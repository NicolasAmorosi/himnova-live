import fs from "node:fs";
import type { SlideTransition } from "@shared/types/transition";
import type {
  EmbeddedFontRef,
  Fill,
  Frame,
  ImageEffect,
  PictureElement,
  ShapeElement,
  SlideElement,
  SlideModel,
} from "@shared/types/slide-model";
import { childrenOf, openOle, readSlideInfo, recordAt, walkRecords, type OleFile, type Rec } from "../ppt-binary";
import type { PptxDeck, PptxSlide } from "../pptx/reader";
import { fontList } from "../pptx/text";
import { imageNaturalSize } from "../pptx/image-size";
import {
  cssColor,
  EMU_PER_MASTER,
  emptyProps,
  fixed,
  flag,
  overProps,
  P,
  propString,
  readEffects,
  readFill,
  readLine,
  readPropTable,
  shapeGeometry,
  type BlipResolver,
  type DrawContext,
  type MsoShapeTable,
  type Props,
  type Scheme,
} from "./escher";
import { encodePart, type BinaryPart } from "./parts";
import { readExt9, readExt9Master, readFonts, readRuler, readStyleSheets, readTextRecords, RT, type Ext9, TEXT, textBody, type Font, type TextData } from "./text";

/**
 * A legacy binary `.ppt`/`.pps` read into the same `SlideModel` a `.pptx` is
 * drawn from — for every deck the picture-only reader (`readBinaryDeck`, the
 * hymnal) refuses: text, shapes, masters, backgrounds. Owner, 2026-11-03: no
 * LibreOffice behind it, and what can't be drawn exactly is approximated,
 * never refused.
 *
 * Path through the file (MS-PPT): `Current User` → the last `UserEditAtom` →
 * persist directory → the document, its slide and master lists → each
 * slide's drawing (OfficeArt shapes), with text either inside a shape or, for
 * placeholders, in the slide list next to the slide's persist atom.
 */

const RT_DOCUMENT = 0x03e8, RT_DOCUMENT_ATOM = 0x03e9, RT_SLIDE = 0x03ee, RT_SLIDE_ATOM = 0x03ef, RT_NOTES = 0x03f0;
const RT_SLIDE_PERSIST = 0x03f3, RT_MAIN_MASTER = 0x03f8, RT_ENVIRONMENT = 0x03f2, RT_DRAWING_GROUP = 0x040b;
const RT_DRAWING = 0x040c, RT_COLOR_SCHEME = 0x07f0, RT_SLIDE_LIST = 0x0ff0, RT_USER_EDIT = 0x0ff5;
const RT_PERSIST_DIR = 0x1772, RT_HEADERS_FOOTERS = 0x0fd9, RT_HEADERS_FOOTERS_ATOM = 0x0fda, RT_CSTRING = 0x0fba;
const RT_PLACEHOLDER = 0x0bc3, RT_EXOBJ_REF = 0x0bc1, RT_ANIMATION_INFO = 0x0ff1, RT_SOUND_COLLECTION = 0x07e4;
const RT_SOUND = 0x07e6, RT_SOUND_DATA = 0x07e7, RT_FONT_COLLECTION = 0x07d5, RT_FONT_ENTITY = 0x0fb7, RT_FONT_EMBED = 0x0fb8;

const OA_BSTORE = 0xf001, OA_DG = 0xf002, OA_SPGR = 0xf003, OA_SP = 0xf004, OA_FBSE = 0xf007;
const OA_FSPGR = 0xf009, OA_FSP = 0xf00a, OA_FOPT = 0xf00b, OA_CLIENT_TEXTBOX = 0xf00d, OA_CHILD_ANCHOR = 0xf00f;
const OA_CLIENT_ANCHOR = 0xf010, OA_CLIENT_DATA = 0xf011, OA_SECONDARY_FOPT = 0xf121, OA_TERTIARY_FOPT = 0xf122;

const FSP_GROUP = 0x1, FSP_PATRIARCH = 0x4, FSP_DELETED = 0x8, FSP_FLIP_H = 0x40, FSP_FLIP_V = 0x80, FSP_BACKGROUND = 0x400;

const SHAPE_PICTURE_FRAME = 75, SHAPE_TEXT_BOX = 202;

/** Master placeholders that are templates for slides, never drawn on them. */
const MASTER_TEMPLATE_PLACEHOLDERS = new Set([1, 2, 3, 4, 5, 6]);
const PH_DATE = 7, PH_SLIDE_NUMBER = 8, PH_FOOTER = 9, PH_HEADER = 10;

const MAX_DEPTH = 12;

export type PptResources = { msoShapes: MsoShapeTable };

/** One sound of the deck's collection: where its bytes are, and what it is. */
export type BinarySound = { id: string; part: string; ext: string };

export type BinarySlideMeta = {
  hidden: boolean;
  autoAdvanceMs: number | null;
  advanceOnClick: boolean;
  transition: SlideTransition | null;
  title: string | null;
  notes: string | null;
  /** The sounds the slide plays: its transition's, and sound objects on it.
   *  `slides` is how many slides one plays across, its own included. */
  sounds: { id: string; loop: boolean; slides: number; origin: "transition" | "embedded" }[];
};

export type PptModelRead = { deck: PptxDeck; slides: BinarySlideMeta[]; sounds: BinarySound[] };

type Doc = {
  ole: OleFile;
  buf: Buffer;
  persist: Map<number, number>;
  documentRec: Rec;
};

type ShapeInfo = {
  spid: number;
  type: number;
  flags: number;
  own: Props;
  anchor: [number, number, number, number] | null;
  childAnchor: [number, number, number, number] | null;
  groupRect: [number, number, number, number] | null;
  textbox: Rec | null;
  placeholder: number | null;
  hiddenMedia: boolean;
  /** A media object: the external object it names, and the slides it plays across. */
  media: { exObjId: number; slides: number } | null;
  /** The shape's PowerPoint 2000 paragraph extension (autonumbers), when it has one. */
  ext9: Rec | null;
  children: ShapeInfo[] | null;
};

/** Reads the deck, or throws when the file is not a PowerPoint 97+ binary. */
export function readPptModel(file: string, resources: PptResources): PptModelRead {
  const fd = fs.openSync(file, "r");
  try {
    const doc = open(fd);
    return readDeck(doc, resources);
  } finally {
    fs.closeSync(fd);
  }
}

function open(fd: number): Doc {
  const ole = openOle(fd, fs.fstatSync(fd).size);
  if (!ole) throw new Error("not an OLE2 compound file");
  const buf = ole.readStreamByName("PowerPoint Document");
  if (!buf) throw new Error("no PowerPoint Document stream");
  const current = ole.readStreamByName("Current User");
  if (!current || current.length < 20) throw new Error("no Current User stream");
  const persist = new Map<number, number>();
  let docRef: number | null = null;
  let edit = current.readUInt32LE(16);
  const seen = new Set<number>();
  while (edit !== 0 && !seen.has(edit)) {
    seen.add(edit);
    const atom = recordAt(buf, edit);
    if (!atom || atom.recType !== RT_USER_EDIT || atom.len < 28) break;
    docRef ??= buf.readUInt32LE(atom.body + 16);
    const dir = recordAt(buf, buf.readUInt32LE(atom.body + 12));
    if (dir && dir.recType === RT_PERSIST_DIR) {
      let p = dir.body;
      const end = dir.body + dir.len;
      while (p + 4 <= end) {
        const packed = buf.readUInt32LE(p);
        p += 4;
        const first = packed & 0xfffff, count = packed >>> 20;
        if (count === 0) break;
        for (let i = 0; i < count && p + 4 <= end; i++, p += 4) if (!persist.has(first + i)) persist.set(first + i, buf.readUInt32LE(p));
      }
    }
    edit = buf.readUInt32LE(atom.body + 8);
  }
  if (docRef === null) throw new Error("no user edit");
  const offset = persist.get(docRef);
  const documentRec = offset === undefined ? null : recordAt(buf, offset);
  if (!documentRec || documentRec.recType !== RT_DOCUMENT) throw new Error("no document container");
  return { ole, buf, persist, documentRec: { ...documentRec, container: true } };
}

function persisted(doc: Doc, id: number | undefined): Rec | null {
  if (id === undefined) return null;
  const offset = doc.persist.get(id);
  const rec = offset === undefined ? null : recordAt(doc.buf, offset);
  return rec ? { ...rec, container: true } : null;
}

// -- the document ---------------------------------------------------------------

function readDeck(doc: Doc, resources: PptResources): PptModelRead {
  const { buf } = doc;
  const top = childrenOf(buf, doc.documentRec);
  const atom = top.find((c) => c.recType === RT_DOCUMENT_ATOM && c.len >= 8);
  if (!atom) throw new Error("no DocumentAtom");
  const width = Math.round(buf.readInt32LE(atom.body) * EMU_PER_MASTER);
  const height = Math.round(buf.readInt32LE(atom.body + 4) * EMU_PER_MASTER);
  if (width <= 0 || height <= 0) throw new Error("no slide size");
  const firstNumber = atom.len >= 34 ? buf.readUInt16LE(atom.body + 32) || 1 : 1;
  const environment = top.find((c) => c.recType === RT_ENVIRONMENT) ?? null;
  const fonts = readFonts(buf, environment);
  const embedded = embeddedFonts(buf, environment, fonts);

  // The slide lists: slides, masters, notes — and, per persist atom, the
  // placeholder texts stored right after it.
  const slideIds: number[] = [];
  const masterById = new Map<number, number>();
  const notesById = new Map<number, number>();
  const texts = new Map<number, TextData[]>();
  const slideIdOf = new Map<number, number>();
  for (const list of top.filter((c) => c.recType === RT_SLIDE_LIST)) {
    let owner: number | null = null;
    let group: Rec[] = [];
    const flushText = (): void => {
      if (owner === null || group.length === 0) return;
      const data = readTextRecords(buf, group);
      if (data) (texts.get(owner) ?? texts.set(owner, []).get(owner)!).push(data);
      group = [];
    };
    for (const r of childrenOf(buf, list)) {
      if (r.recType === RT_SLIDE_PERSIST && r.len >= 16) {
        flushText();
        owner = buf.readUInt32LE(r.body);
        if (list.recInstance === 0) {
          slideIds.push(owner);
          slideIdOf.set(owner, buf.readUInt32LE(r.body + 12));
        }
        else if (list.recInstance === 1) masterById.set(buf.readUInt32LE(r.body + 12), owner);
        else if (list.recInstance === 2) notesById.set(buf.readUInt32LE(r.body + 12), owner);
      } else if (r.recType === RT.textHeader) {
        flushText();
        group = [r];
      } else if (group.length > 0) group.push(r);
    }
    flushText();
  }

  const blips = blipStore(doc, top);
  const sounds = soundCollection(buf, top);
  const docFooter = headersFooters(buf, top);
  const pp9 = powerPoint9(buf, top);
  // A placeholder's autonumbers are kept by the document, by slide and text index.
  for (const [persistId, list] of texts) {
    list.forEach((t, i) => {
      const ext = pp9.paragraphs.get(`${slideIdOf.get(persistId)}:${i}`);
      if (ext) t.ext9 = ext;
    });
  }
  const embeddedAudio = embeddedAudioObjects(buf, top);

  const slides: PptxSlide[] = [];
  const metas: BinarySlideMeta[] = [];
  slideIds.forEach((persistId, index) => {
    const unsupported = new Map<string, number>();
    const miss = (what: string): void => void unsupported.set(what, (unsupported.get(what) ?? 0) + 1);
    const slide = persisted(doc, persistId);
    const info = slide ? readSlideInfo(buf, slide) : null;
    const slideTexts = texts.get(persistId) ?? [];
    let model: SlideModel;
    let damaged = false;
    try {
      if (!slide || slide.recType !== RT_SLIDE) throw new Error("no slide container");
      model = drawSlide(doc, slide, slideTexts, { masterById, blips, fonts, embedded, resources, miss, texts, ext9Master: pp9.master, docFooter, number: firstNumber + index, width, height });
    } catch (error) {
      damaged = true;
      miss("slide:unreadable");
      console.warn(`[slides] legacy slide ${index + 1} unreadable: ${String(error)}`);
      model = { width, height, background: { kind: "solid", color: "rgb(255,255,255)" }, elements: [], fonts: embedded, damaged: true };
    }
    slides.push({ number: index + 1, hidden: info?.hidden ?? false, model, unsupported: Object.fromEntries(unsupported) });
    const title = slideTexts.find((t) => t.type === TEXT.title || t.type === TEXT.centerTitle)?.text.replace(/[\r\v]+/g, " ").trim() || null;
    metas.push({
      hidden: info?.hidden ?? false,
      autoAdvanceMs: info?.autoAdvanceMs ?? null,
      advanceOnClick: info?.advanceOnClick ?? true,
      transition: info?.transition ?? null,
      title,
      notes: damaged || !slide ? null : notesText(doc, slide, notesById),
      sounds: damaged || !slide ? [] : slideSounds(buf, slide, sounds, embeddedAudio),
    });
  });
  if (slides.length === 0) throw new Error("no slides");
  return { deck: { width, height, slides, fonts: embedded }, slides: metas, sounds };
}

/** `FontEmbedDataBlob`s: each follows its face's `FontEntityAtom`, one per style. */
function embeddedFonts(buf: Buffer, environment: Rec | null, fonts: Font[]): EmbeddedFontRef[] {
  if (!environment) return [];
  const collection = childrenOf(buf, environment).find((c) => c.recType === RT_FONT_COLLECTION);
  if (!collection) return [];
  const out: EmbeddedFontRef[] = [];
  let face: string | null = null;
  for (const r of childrenOf(buf, collection)) {
    if (r.recType === RT_FONT_ENTITY) face = fonts[r.recInstance]?.name ?? null;
    else if (r.recType === RT_FONT_EMBED && face && r.len > 0) {
      const style = (["regular", "bold", "italic", "boldItalic"] as const)[r.recInstance & 3]!;
      out.push({ family: face, style, part: encodePart({ stream: "d", offset: r.body, length: r.len, codec: "raw", ext: "eot" }) });
    }
  }
  return out;
}

/** The BLIP store: picture `pib` (1-based) → where its bytes are. */
function blipStore(doc: Doc, top: Rec[]): Map<number, BinaryPart> {
  const { buf, ole } = doc;
  const out = new Map<number, BinaryPart>();
  const group = top.find((c) => c.recType === RT_DRAWING_GROUP);
  if (!group) return out;
  let store: Rec | null = null;
  walkRecords(buf, group.body, group.body + group.len, 0, (type, instance, body, len) => {
    if (!store && type === OA_BSTORE) store = { recType: type, recInstance: instance, body, len, container: true };
  });
  if (!store) return out;
  childrenOf(buf, store).forEach((fbse, i) => {
    if (fbse.recType !== OA_FBSE || fbse.len < 36) return;
    const foDelay = buf.readUInt32LE(fbse.body + 28);
    const cbName = buf[fbse.body + 33] ?? 0;
    const inline = fbse.len > 36 + cbName ? fbse.body + 36 + cbName : null;
    let part: BinaryPart | null = null;
    if (inline !== null) part = blipAt(buf, inline, "d");
    else {
      const head = ole.readStreamRange("Pictures", foDelay, 8 + 16 + 16 + 34);
      if (head) {
        const len = head.readUInt32LE(4);
        const whole = ole.readStreamRange("Pictures", foDelay, Math.min(8 + len, 8 + 16 + 16 + 34));
        if (whole) part = blipAt(whole, 0, "p", foDelay, 8 + len);
      }
    }
    if (part) out.set(i + 1, part);
  });
  return out;
}

const TWO_UIDS = new Set([0x3d5, 0x217, 0x543, 0x46b, 0x6e3, 0x6e1, 0x7a9, 0x6e5]);

/** One BLIP record → the part that serves its picture. `base` is where the
 *  record sits in its stream when `buf` holds only its first bytes. */
function blipAt(buf: Buffer, at: number, stream: "d" | "p", base = at, total?: number): BinaryPart | null {
  if (at + 8 > buf.length) return null;
  const instance = buf.readUInt16LE(at) >> 4;
  const type = buf.readUInt16LE(at + 2);
  const len = total !== undefined ? total - 8 : buf.readUInt32LE(at + 4);
  const uids = 16 + (TWO_UIDS.has(instance) ? 16 : 0);
  const body = base + 8;
  switch (type) {
    case 0xf01a: // EMF
    case 0xf01b: // WMF
    case 0xf01c: { // PICT
      const header = at + 8 + uids;
      if (header + 34 > buf.length) return null;
      const compressed = buf[header + 32] === 0;
      const size = buf.readUInt32LE(header + 28);
      const ext = type === 0xf01a ? "emf" : type === 0xf01b ? "wmf" : "pict";
      return { stream, offset: body + uids + 34, length: Math.min(size, len - uids - 34), codec: compressed ? "z" : "raw", ext };
    }
    case 0xf01d:
    case 0xf02a:
      return { stream, offset: body + uids + 1, length: len - uids - 1, codec: "raw", ext: "jpg" };
    case 0xf01e:
      return { stream, offset: body + uids + 1, length: len - uids - 1, codec: "raw", ext: "png" };
    case 0xf01f:
      return { stream, offset: body + uids + 1, length: len - uids - 1, codec: "dib", ext: "bmp" };
    case 0xf029:
      return { stream, offset: body + uids + 1, length: len - uids - 1, codec: "raw", ext: "tif" };
    default:
      return null;
  }
}

function soundCollection(buf: Buffer, top: Rec[]): BinarySound[] {
  const collection = top.find((c) => c.recType === RT_SOUND_COLLECTION);
  if (!collection) return [];
  const out: BinarySound[] = [];
  for (const sound of childrenOf(buf, collection)) {
    if (sound.recType !== RT_SOUND) continue;
    let id: string | null = null, ext = "wav";
    let data: Rec | null = null;
    for (const c of childrenOf(buf, sound)) {
      if (c.recType === RT_CSTRING && c.recInstance === 1) ext = buf.toString("utf16le", c.body, c.body + c.len).replace(/^\./, "").toLowerCase() || "wav";
      else if (c.recType === RT_CSTRING && c.recInstance === 2) id = buf.toString("utf16le", c.body, c.body + c.len);
      else if (c.recType === RT_SOUND_DATA) data = c;
    }
    if (id && data && data.len > 0) out.push({ id, ext, part: encodePart({ stream: "d", offset: data.body, length: data.len, codec: "raw", ext }) });
  }
  return out;
}

/** Embedded audio objects (`ExWAVAudioEmbeddedContainer`) by external object
 *  id: the sound of the collection they play, and whether they loop. A linked
 *  sound is found beside the deck by `linked-audio.ts`, as for the hymnal. */
function embeddedAudioObjects(buf: Buffer, top: Rec[]): Map<number, { soundId: string; loop: boolean }> {
  const out = new Map<number, { soundId: string; loop: boolean }>();
  const list = top.find((c) => c.recType === 0x0409);
  if (!list) return out;
  for (const obj of childrenOf(buf, list)) {
    if (obj.recType !== 0x100e) continue;
    const kids = childrenOf(buf, obj);
    const media = kids.find((k) => k.recType === 0x1004 && k.len >= 6);
    const atom = kids.find((k) => k.recType === 0x100b && k.len >= 4);
    if (media && atom) out.set(buf.readUInt32LE(media.body), { soundId: String(buf.readUInt32LE(atom.body)), loop: (buf.readUInt16LE(media.body + 4) & 1) !== 0 });
  }
  return out;
}

/** What a slide plays: its transition sound (`SlideShowSlideInfoAtom`, «loop
 *  until next sound» plays across the deck), then each sound object on it,
 *  across the slides its animation says. */
function slideSounds(buf: Buffer, slide: Rec, sounds: BinarySound[], objects: Map<number, { soundId: string; loop: boolean }>): BinarySlideMeta["sounds"] {
  const out: BinarySlideMeta["sounds"] = [];
  const atom = childrenOf(buf, slide).find((c) => c.recType === 0x03f9 && c.len >= 12);
  if (atom) {
    const flags = buf.readUInt16LE(atom.body + 10);
    const id = String(buf.readUInt32LE(atom.body + 4));
    const loop = (flags & 0x40) !== 0;
    if (flags & 0x10 && sounds.some((s) => s.id === id)) out.push({ id, loop, slides: loop ? 999 : 1, origin: "transition" });
  }
  for (const s of flatten(drawingShapes(buf, slide))) {
    const object = s.media && objects.get(s.media.exObjId);
    if (object && sounds.some((x) => x.id === object.soundId)) out.push({ id: object.soundId, loop: object.loop, slides: s.media!.slides, origin: "embedded" });
  }
  return out;
}

function notesText(doc: Doc, slide: Rec, notesById: Map<number, number>): string | null {
  const atom = childrenOf(doc.buf, slide).find((c) => c.recType === RT_SLIDE_ATOM && c.len >= 20);
  if (!atom) return null;
  const notes = persisted(doc, notesById.get(doc.buf.readUInt32LE(atom.body + 16)));
  if (!notes || notes.recType !== RT_NOTES) return null;
  let text: string | null = null;
  let isNotes = false;
  walkRecords(doc.buf, notes.body, notes.body + notes.len, 0, (type, _instance, body, len) => {
    if (text !== null) return;
    if (type === RT.textHeader && len >= 4) isNotes = doc.buf.readUInt32LE(body) === TEXT.notes;
    else if (isNotes && type === RT.textChars) text = doc.buf.toString("utf16le", body, body + (len & ~1));
    else if (isNotes && type === RT.textBytes) text = doc.buf.toString("latin1", body, body + len);
  });
  return (text as string | null)?.replace(/[\r\v]/g, "\n").trim() || null;
}

/** The document's PowerPoint 2000 extension (`___PPT9` binary tag): the masters'
 *  autonumber levels by kind of text, and each placeholder text's paragraph
 *  extension by `slideId:textIndex` (`ExtendedPresRuleContainer`). */
function powerPoint9(buf: Buffer, top: Rec[]): { master: Map<number, Ext9[]>; paragraphs: Map<string, Ext9[]> } {
  const master = new Map<number, Ext9[]>();
  const paragraphs = new Map<string, Ext9[]>();
  // The document keeps its tags in its `DocInfoListContainer` (0x07D0).
  const info = top.find((c) => c.recType === 0x07d0);
  const tags = [...top, ...(info ? childrenOf(buf, info) : [])].filter((c) => c.recType === 0x1388);
  for (const tag of tags.flatMap((t) => childrenOf(buf, t))) {
    if (tag.recType !== 0x138a) continue;
    const kids = childrenOf(buf, tag);
    const name = kids.find((k) => k.recType === RT_CSTRING);
    const blob = kids.find((k) => k.recType === 0x138b);
    if (!name || !blob || buf.toString("utf16le", name.body, name.body + name.len) !== "___PPT9") continue;
    for (const r of childrenOf(buf, blob)) {
      if (r.recType === 0x0fad) master.set(r.recInstance, readExt9Master(buf, r));
      else if (r.recType === 0x0fae) {
        let key: string | null = null;
        for (const c of childrenOf(buf, r)) {
          if (c.recType === 0x0faf && c.len >= 4) key = `${buf.readUInt32LE(c.body)}:${c.recInstance}`;
          else if (c.recType === 0x0fac && key) {
            paragraphs.set(key, readExt9(buf, c));
            key = null;
          }
        }
      }
    }
  }
  return { master, paragraphs };
}

type HeadersFooters = { slideNumber: boolean; footer: string | null; date: string | null; showDate: boolean; showFooter: boolean };

function headersFooters(buf: Buffer, parent: Rec[], base?: HeadersFooters): HeadersFooters {
  const out: HeadersFooters = base ? { ...base } : { slideNumber: false, footer: null, date: null, showDate: false, showFooter: false };
  const container = parent.find((c) => c.recType === RT_HEADERS_FOOTERS && (base !== undefined || c.recInstance === 3));
  if (!container) return out;
  for (const c of childrenOf(buf, container)) {
    if (c.recType === RT_HEADERS_FOOTERS_ATOM && c.len >= 4) {
      const flags = buf.readUInt16LE(c.body + 2);
      out.showDate = (flags & 0x1) !== 0;
      out.slideNumber = (flags & 0x8) !== 0;
      out.showFooter = (flags & 0x20) !== 0;
      if (flags & 0x2) out.date = new Date().toLocaleDateString();
    } else if (c.recType === RT_CSTRING) {
      const s = buf.toString("utf16le", c.body, c.body + c.len);
      if (c.recInstance === 0) out.date = s;
      else if (c.recInstance === 2) out.footer = s;
    }
  }
  return out;
}

// -- a slide --------------------------------------------------------------------

type DeckContext = {
  masterById: Map<number, number>;
  blips: Map<number, BinaryPart>;
  fonts: Font[];
  embedded: EmbeddedFontRef[];
  resources: PptResources;
  miss: (what: string) => void;
  texts: Map<number, TextData[]>;
  ext9Master: Map<number, Ext9[]>;
  docFooter: HeadersFooters;
  number: number;
  width: number;
  height: number;
};

type SlideAtom = { masterId: number; masterObjects: boolean; masterScheme: boolean; masterBackground: boolean };

function slideAtom(buf: Buffer, rec: Rec): SlideAtom | null {
  const atom = childrenOf(buf, rec).find((c) => c.recType === RT_SLIDE_ATOM && c.len >= 22);
  if (!atom) return null;
  const flags = buf.readUInt16LE(atom.body + 20);
  return { masterId: buf.readUInt32LE(atom.body + 12), masterObjects: (flags & 1) !== 0, masterScheme: (flags & 2) !== 0, masterBackground: (flags & 4) !== 0 };
}

function schemeOf(buf: Buffer, rec: Rec): Scheme | null {
  const atom = childrenOf(buf, rec).find((c) => c.recType === RT_COLOR_SCHEME && c.recInstance === 1 && c.len >= 32);
  if (!atom) return null;
  return Array.from({ length: 8 }, (_, i) => {
    const v = buf.readUInt32LE(atom.body + i * 4);
    return { r: v & 0xff, g: (v >>> 8) & 0xff, b: (v >>> 16) & 0xff };
  });
}

const DEFAULT_SCHEME: Scheme = [
  [255, 255, 255], [0, 0, 0], [128, 128, 128], [0, 0, 0], [0, 204, 153], [51, 51, 204], [255, 255, 255], [204, 204, 0],
].map(([r, g, b]) => ({ r: r!, g: g!, b: b! }));

/** The master chain a slide draws on: the slide's own master (a title master
 *  for a title slide) and the main master the title master itself sits on. */
type Master = { rec: Rec; atom: SlideAtom | null; persistId: number };

function masterChain(doc: Doc, ctx: DeckContext, masterId: number): Master[] {
  const out: Master[] = [];
  let id: number | null = masterId;
  const seen = new Set<number>();
  while (id !== null && !seen.has(id) && out.length < 3) {
    seen.add(id);
    const persistId = ctx.masterById.get(id);
    const rec = persisted(doc, persistId);
    if (!rec || (rec.recType !== RT_MAIN_MASTER && rec.recType !== RT_SLIDE)) break;
    const atom = slideAtom(doc.buf, rec);
    out.push({ rec, atom, persistId: persistId! });
    id = rec.recType === RT_SLIDE && atom ? atom.masterId : null;
  }
  return out;
}

function drawSlide(doc: Doc, slide: Rec, slideTexts: TextData[], ctx: DeckContext): SlideModel {
  const { buf } = doc;
  const atom = slideAtom(buf, slide);
  const masters = atom ? masterChain(doc, ctx, atom.masterId) : [];
  const main = masters.find((m) => m.rec.recType === RT_MAIN_MASTER) ?? masters[masters.length - 1];

  // The scheme: the slide's, unless it follows its master's (and so on up).
  let scheme: Scheme | null = atom && !atom.masterScheme ? schemeOf(buf, slide) : null;
  for (const m of masters) {
    if (scheme) break;
    if (m.rec.recType === RT_MAIN_MASTER || !m.atom?.masterScheme) scheme = schemeOf(buf, m.rec);
  }
  scheme ??= DEFAULT_SCHEME;

  const sheets = main ? readStyleSheets(buf, main.rec, environmentOf(doc)) : readStyleSheets(buf, slide, environmentOf(doc));
  const footer = headersFooters(buf, childrenOf(buf, slide), ctx.docFooter);
  const blip: BlipResolver = (pib) => {
    const part = ctx.blips.get(pib);
    if (!part) return null;
    return { part: encodePart(part), size: part.codec === "raw" && (part.ext === "png" || part.ext === "jpg") ? pictureSize(doc, part) : null };
  };
  const draw: DrawContext = { scheme, blip, miss: ctx.miss };
  const textCtx = { sheets, fonts: ctx.fonts, scheme, slideNumber: ctx.number, footer: footer.footer, date: footer.date, ext9Master: ctx.ext9Master, miss: ctx.miss };

  // Shapes of a master, by `spid`, for slide shapes that inherit from one.
  const masterShapes = new Map<number, ShapeInfo>();
  const masterInfos = masters.map((m) => drawingShapes(buf, m.rec));
  for (const shapes of masterInfos) for (const s of flatten(shapes)) masterShapes.set(s.spid, s);
  const inherit = (s: ShapeInfo): Props => {
    let props = s.own;
    const master = s.own.simple.get(P.hspMaster);
    if (master !== undefined) {
      const m = masterShapes.get(master);
      if (m) props = overProps(props, m.own);
    }
    return props;
  };

  const shapes = drawingShapes(buf, slide);
  // Background: the slide's own, or its master's.
  let background: Fill | null = null;
  const own = shapes.find((s) => s.flags & FSP_BACKGROUND);
  if (own && atom && !atom.masterBackground) background = readFill(inherit(own), draw, true);
  else {
    for (const [i, m] of masters.entries()) {
      const bg = masterInfos[i]!.find((s) => s.flags & FSP_BACKGROUND);
      if (bg && (m.rec.recType === RT_MAIN_MASTER || !m.atom?.masterBackground)) {
        background = readFill(bg.own, draw, true);
        break;
      }
    }
  }
  if (!background || background.kind === "background") background = { kind: "solid", color: cssColor(scheme[0] ?? { r: 255, g: 255, b: 255 }) };

  const elements: SlideElement[] = [];
  const toElement = (s: ShapeInfo, texts: TextData[]): SlideElement | null => element(doc, s, texts, inherit, draw, textCtx, ctx);

  // Master objects, main master first: everything but the placeholders that
  // are templates, and the date, number and footer only when they are on.
  if (!atom || atom.masterObjects) {
    for (let i = masters.length - 1; i >= 0; i--) {
      const m = masters[i]!;
      if (i < masters.length - 1 && m.atom && !m.atom.masterObjects) elements.length = 0;
      const masterTexts = ctx.texts.get(m.persistId) ?? [];
      for (const s of masterInfos[i]!) {
        if (s.flags & (FSP_BACKGROUND | FSP_PATRIARCH)) continue;
        const ph = s.placeholder;
        if (ph !== null && MASTER_TEMPLATE_PLACEHOLDERS.has(ph)) continue;
        if (ph === PH_DATE && !footer.showDate) continue;
        if (ph === PH_SLIDE_NUMBER && !footer.slideNumber) continue;
        if (ph === PH_FOOTER && !footer.showFooter) continue;
        if (ph === PH_HEADER) continue;
        const el = safe(() => toElement(s, masterTexts), ctx);
        if (el) elements.push(el);
      }
    }
  }
  for (const s of shapes) {
    if (s.flags & (FSP_BACKGROUND | FSP_PATRIARCH)) continue;
    const el = safe(() => toElement(s, slideTexts), ctx);
    if (el) elements.push(el);
  }
  return { width: ctx.width, height: ctx.height, background, elements, fonts: ctx.embedded };
}

/** A shape that can't be read costs that shape, never the slide. */
function safe(f: () => SlideElement | null, ctx: DeckContext): SlideElement | null {
  try {
    return f();
  } catch (error) {
    ctx.miss("shape:unreadable");
    console.warn(`[slides] legacy shape unreadable: ${String(error)}`);
    return null;
  }
}

function environmentOf(doc: Doc): Rec | null {
  return childrenOf(doc.buf, doc.documentRec).find((c) => c.recType === RT_ENVIRONMENT) ?? null;
}

const sizeCache = new WeakMap<OleFile, Map<string, { w: number; h: number } | null>>();
function pictureSize(doc: Doc, part: BinaryPart): { w: number; h: number } | null {
  let cache = sizeCache.get(doc.ole);
  if (!cache) sizeCache.set(doc.ole, (cache = new Map<string, { w: number; h: number } | null>()));
  const key = `${part.stream}${part.offset}`;
  if (cache.has(key)) return cache.get(key)!;
  const bytes = part.stream === "d" ? doc.buf.subarray(part.offset, part.offset + Math.min(part.length, 64 * 1024)) : doc.ole.readStreamRange("Pictures", part.offset, Math.min(part.length, 64 * 1024));
  const size = bytes ? imageNaturalSize(bytes) : null;
  cache.set(key, size);
  return size;
}

// -- shapes ---------------------------------------------------------------------

function drawingShapes(buf: Buffer, container: Rec): ShapeInfo[] {
  const drawing = childrenOf(buf, container).find((c) => c.recType === RT_DRAWING);
  if (!drawing) return [];
  const dg = childrenOf(buf, drawing).find((c) => c.recType === OA_DG);
  if (!dg) return [];
  const out: ShapeInfo[] = [];
  for (const c of childrenOf(buf, dg)) {
    if (c.recType === OA_SPGR) {
      // The top group: its first shape is the patriarch, the rest are the slide's.
      const members = readGroup(buf, c, 0);
      if (members) out.push(...(members.children ?? []));
    } else if (c.recType === OA_SP) {
      const s = readShape(buf, c);
      if (s) out.push(s);
    }
  }
  return out;
}

function readGroup(buf: Buffer, group: Rec, depth: number): ShapeInfo | null {
  if (depth > MAX_DEPTH) return null;
  const members = childrenOf(buf, group);
  const first = members[0];
  const head = first && first.recType === OA_SP ? readShape(buf, first) : null;
  if (!head) return null;
  head.children = [];
  for (const m of members.slice(1)) {
    const s = m.recType === OA_SPGR ? readGroup(buf, m, depth + 1) : m.recType === OA_SP ? readShape(buf, m) : null;
    if (s) head.children.push(s);
  }
  return head;
}

function readShape(buf: Buffer, sp: Rec): ShapeInfo | null {
  let fsp: Rec | null = null;
  const own = emptyProps();
  const info: Omit<ShapeInfo, "spid" | "type" | "flags"> = {
    own, anchor: null, childAnchor: null, groupRect: null, textbox: null, placeholder: null, hiddenMedia: false, media: null, ext9: null, children: null,
  };
  let media = false;
  let hide = false;
  let exObjId: number | null = null;
  let slideCount = 0;
  for (const c of childrenOf(buf, sp)) {
    switch (c.recType) {
      case OA_FSP: if (c.len >= 8) fsp = c; break;
      case OA_FOPT: case OA_SECONDARY_FOPT: case OA_TERTIARY_FOPT: readPropTable(buf, c, own); break;
      case OA_FSPGR:
        if (c.len >= 16) info.groupRect = [buf.readInt32LE(c.body), buf.readInt32LE(c.body + 4), buf.readInt32LE(c.body + 8), buf.readInt32LE(c.body + 12)];
        break;
      case OA_CHILD_ANCHOR:
        if (c.len >= 16) info.childAnchor = [buf.readInt32LE(c.body), buf.readInt32LE(c.body + 4), buf.readInt32LE(c.body + 8), buf.readInt32LE(c.body + 12)];
        break;
      case OA_CLIENT_ANCHOR:
        // top, left, right, bottom — 16-bit in PowerPoint 97, 32-bit later.
        info.anchor =
          c.len >= 16
            ? [buf.readInt32LE(c.body), buf.readInt32LE(c.body + 4), buf.readInt32LE(c.body + 8), buf.readInt32LE(c.body + 12)]
            : c.len >= 8
              ? [buf.readInt16LE(c.body), buf.readInt16LE(c.body + 2), buf.readInt16LE(c.body + 4), buf.readInt16LE(c.body + 6)]
              : null;
        break;
      case OA_CLIENT_TEXTBOX: info.textbox = c; break;
      case OA_CLIENT_DATA:
        walkRecords(buf, c.body, c.body + c.len, 0, (type, _instance, body, len) => {
          if (type === RT_PLACEHOLDER && len >= 8) info.placeholder = buf[body + 4]!;
          if (type === 0x0fac) info.ext9 = { recType: type, recInstance: 0, body, len, container: false };
          if (type === RT_EXOBJ_REF && len >= 4) {
            media = true;
            exObjId = buf.readUInt32LE(body);
          }
          if (type === RT_ANIMATION_INFO && len >= 6) hide = (buf.readUInt16LE(body + 4) & 0x1000) !== 0;
          if (type === RT_ANIMATION_INFO && len >= 20) slideCount = buf.readUInt16LE(body + 18);
        });
        break;
    }
  }
  if (!fsp) return null;
  info.hiddenMedia = media && hide;
  if (exObjId !== null) info.media = { exObjId, slides: Math.max(1, slideCount) };
  return { spid: buf.readUInt32LE(fsp.body), type: fsp.recInstance, flags: buf.readUInt32LE(fsp.body + 4), ...info };
}

function flatten(shapes: ShapeInfo[]): ShapeInfo[] {
  return shapes.flatMap((s) => [s, ...(s.children ? flatten(s.children) : [])]);
}

/** A shape's frame, in EMU. Office stores the anchor of a shape turned by
 *  45°–135° (or 225°–315°) as its rotated bounds: width and height swap
 *  around the centre. */
function frameOf(rect: [number, number, number, number], order: "tlrb" | "ltrb", props: Props, flags: number, scale: number): Frame {
  const [a, b, c, d] = rect;
  const [left, top, right, bottom] = order === "tlrb" ? [b, a, c, d] : [a, b, c, d];
  let x = left * scale, y = top * scale, w = (right - left) * scale, h = (bottom - top) * scale;
  const rot = fixed(props.simple.get(P.rotation) ?? 0);
  const norm = ((rot % 360) + 360) % 360;
  if ((norm >= 45 && norm < 135) || (norm >= 225 && norm < 315)) {
    const cx = x + w / 2, cy = y + h / 2;
    [w, h] = [h, w];
    x = cx - w / 2;
    y = cy - h / 2;
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), rot, flipH: (flags & FSP_FLIP_H) !== 0, flipV: (flags & FSP_FLIP_V) !== 0 };
}

function element(
  doc: Doc,
  s: ShapeInfo,
  texts: TextData[],
  inherit: (s: ShapeInfo) => Props,
  draw: DrawContext,
  textCtx: Parameters<typeof textBody>[2],
  ctx: DeckContext,
  inGroup = false,
): SlideElement | null {
  if (s.flags & FSP_DELETED) return null;
  if (s.hiddenMedia) return null;
  const props = inherit(s);
  if (flag(props, P.groupBooleans, 0x02)) return null; // fHidden
  const rect = inGroup ? s.childAnchor ?? s.anchor : s.anchor ?? s.childAnchor;
  if (!rect) return null;
  const frame = frameOf(rect, inGroup && s.childAnchor ? "ltrb" : s.anchor ? "tlrb" : "ltrb", props, s.flags, EMU_PER_MASTER);

  if (s.flags & FSP_GROUP && s.children) {
    const g = s.groupRect ?? [rect[1], rect[0], rect[2], rect[3]];
    const children = s.children.flatMap((c) => {
      const el = safe(() => element(doc, c, texts, inherit, draw, textCtx, ctx, true), ctx);
      return el ? [el] : [];
    });
    return {
      kind: "group",
      frame,
      childFrame: { x: g[0] * EMU_PER_MASTER, y: g[1] * EMU_PER_MASTER, w: Math.max(1, (g[2] - g[0]) * EMU_PER_MASTER), h: Math.max(1, (g[3] - g[1]) * EMU_PER_MASTER) },
      children,
    };
  }

  let effects = readEffects(props, draw);
  const pib = props.simple.get(P.pib);
  if ((s.type === SHAPE_PICTURE_FRAME || pib !== undefined) && pib !== undefined && pib > 0) {
    const picture = draw.blip(pib);
    if (!picture) {
      ctx.miss("picture:missing");
      return null;
    }
    if (/\.(pict|tif)$/.test(picture.part)) ctx.miss("picture:unsupported-format");
    const crop = (id: number): number => fixed(props.simple.get(id) ?? 0);
    const imageEffects: ImageEffect[] = [];
    if (flag(props, P.pictureBooleans, 0x04)) imageEffects.push({ kind: "grayscale" });
    if (flag(props, P.pictureBooleans, 0x02)) imageEffects.push({ kind: "biLevel", threshold: 0.5 });
    const bright = props.simple.get(P.pictureBrightness);
    const contrast = props.simple.get(P.pictureContrast);
    if (bright !== undefined || contrast !== undefined) {
      const c = contrast === undefined ? 1 : fixed(contrast);
      imageEffects.push({ kind: "lum", bright: bright === undefined ? 0 : (bright | 0) / 32768, contrast: c <= 1 ? c - 1 : 1 - 1 / c });
    }
    const pictureEl: PictureElement = {
      kind: "picture",
      frame,
      image: {
        part: picture.part,
        crop: { l: crop(P.cropLeft), t: crop(P.cropTop), r: crop(P.cropRight), b: crop(P.cropBottom) },
        fill: null,
        alpha: 1,
        effects: imageEffects,
      },
      fill: readFill(props, draw, false),
      clip: null,
      line: readLine(props, draw, false),
      effects,
    };
    return pictureEl;
  }

  const table = ctx.resources.msoShapes;
  const geometry = shapeGeometry(s.type, props, frame.w, frame.h, table);
  const wordArt = propString(props, P.gtextUnicode);
  const data = textOf(doc, s, texts);
  let fill = readFill(props, draw, !table.notFilled.has(s.type) && s.type !== SHAPE_TEXT_BOX);
  let line = readLine(props, draw, !table.notStroked.has(s.type) && s.type !== SHAPE_TEXT_BOX);
  let text = data ? textBody(data, props, textCtx) : null;
  if (wordArt) {
    // WordArt: the shape's fill and line paint the letters, which fill the box.
    ctx.miss("text:wordart");
    text = wordArtBody(wordArt, props, fill, line, effects, ctx.fonts);
    fill = null;
    line = null;
    effects = { ...effects, shadow: null };
  }
  if (!geometry && !text) {
    if (s.type !== 0) ctx.miss(`shape:type-${s.type}`);
    return null;
  }
  const shape: ShapeElement = {
    kind: "shape",
    frame,
    paths: geometry?.paths ?? [],
    fill,
    line,
    effects,
    textRect: geometry?.textRect ?? { l: 0, t: 0, r: frame.w, b: frame.h },
    text,
  };
  return shape;
}

/** The text a shape shows: inside its client textbox, or — a placeholder's —
 *  in the slide list, named by index. */
function textOf(doc: Doc, s: ShapeInfo, texts: TextData[]): TextData | null {
  if (!s.textbox) return null;
  const records = childrenOf(doc.buf, s.textbox);
  const ref = records.find((r) => r.recType === RT.outlineTextRef && r.len >= 4);
  if (ref) {
    const data = texts[doc.buf.readInt32LE(ref.body)];
    if (!data) return null;
    // The shape keeps its own ruler next to the reference; it wins over the list's.
    const ruler = records.find((r) => r.recType === RT.textRuler);
    const own = ruler ? readRuler(doc.buf, ruler) : null;
    return own ? { ...data, ruler: own } : data;
  }
  const data = readTextRecords(doc.buf, records);
  if (data && s.ext9) data.ext9 = readExt9(doc.buf, s.ext9);
  return data;
}

function wordArtBody(text: string, props: Props, fill: Fill | null, line: ShapeElement["line"], effects: ShapeElement["effects"], fonts: Font[]): ShapeElement["text"] {
  const face = propString(props, P.gtextFont) ?? fonts[0]?.name ?? "Arial";
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const bits = props.simple.get(P.gtextBooleans) ?? 0;
  const on = (bit: number): boolean => ((bits >>> 16) & bit) !== 0 && (bits & bit) !== 0;
  // The letters stretch to the box (`TextBody.stretch`, measured by the
  // painter); the size only sets their proportions. 36 pt is Office's default.
  const size = fixed(props.simple.get(P.gtextSize) ?? 36 * 65536) || 36;
  return {
    insets: { l: 0, t: 0, r: 0, b: 0 },
    anchor: "ctr",
    anchorCenter: false,
    wrap: false,
    vertical: "horz",
    autofit: { kind: "none" },
    columns: { count: 1, spacing: 0 },
    rotation: 0,
    upright: false,
    stretch: true,
    paragraphs: lines.map((l) => ({
      align: "ctr",
      marginLeft: 0,
      indent: 0,
      lineSpacing: { pct: 1 },
      spaceBefore: { pts: 0 },
      spaceAfter: { pts: 0 },
      rtl: false,
      bullet: null,
      runs: l
        ? [
            {
              kind: "text",
              text: l,
              font: fontList(face, null),
              size,
              bold: on(0x20),
              italic: on(0x10),
              underline: on(0x08),
              strike: on(0x01),
              caps: on(0x02) ? "small" : "none",
              baseline: 0,
              spacing: 0,
              fill: fill ?? { kind: "solid", color: "rgb(0,0,0)" },
              outline: line,
              highlight: null,
              effects,
            },
          ]
        : [],
      endSize: size,
      tabs: [],
      defaultTab: 914400,
    })),
  };
}

