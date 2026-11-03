import fs from "node:fs";
import {
  SLIDE_TRANSITION_SPEED_MS,
  type SlideTransition,
  type SlideTransitionStyle,
} from "@shared/types/transition";

/**
 * Reads a legacy binary `.ppt`/`.pps` (OLE2 + the PowerPoint 97 record
 * stream): per-slide timings and transitions for every deck
 * (`readBinarySlideTimings`), and — for a deck made only of pictures, which is
 * every deck of the hymnal this app exists for — the slides themselves.
 *
 * ## Why the slides are read here (2026-10-26)
 *
 * Every slide of the hymnal is an 800×600 JPEG with the lyrics already drawn
 * into it, plus at most a small white logo and a speaker icon PowerPoint is
 * told to hide. Reading that takes ~2 ms, with no copy of any slide on disk.
 * `readBinaryDeck` says which pictures make up each slide and where they sit
 * in the file, and `worship://` serves them straight from it
 * (`readBinaryPictures`).
 *
 * It is deliberately narrow and says no to anything it does not draw exactly:
 * a deck with text, shapes, a slide not covered by a picture, a recolored or
 * cropped picture or an embedded sound goes whole to the model reader
 * (`ppt/model-reader.ts`), which draws everything. Never half a deck each way.
 *
 * ## What it reads
 *
 * The OLE2 compound file's `PowerPoint Document` stream, and the record
 * headers of the pictures it uses in the `Pictures` stream. Sectors are read on
 * demand through one file descriptor, never the whole file — the same rule
 * `zip-reader.ts` follows, for the same reason: this runs on the thread that
 * serves the projection window.
 *
 * Presentation order comes from the documented path (MS-PPT), not from the
 * order records happen to sit in the stream: `Current User` → the most recent
 * `UserEditAtom` → its persist directory → the `SlideListWithText` for slides
 * → one `SlidePersistAtom` per slide, in order → each slide's container.
 */

// -- record types (MS-PPT) ---------------------------------------------------

const RT_DOCUMENT = 0x03e8;
const RT_DOCUMENT_ATOM = 0x03e9;
const RT_SLIDE = 0x03ee;
const RT_SLIDE_ATOM = 0x03ef;
const RT_SLIDE_PERSIST_ATOM = 0x03f3;
const RT_MAIN_MASTER = 0x03f8;
const RT_SS_SLIDE_INFO_ATOM = 0x03f9;
const RT_DRAWING_GROUP = 0x040b;
const RT_DRAWING = 0x040c;
const RT_SOUND_COLLECTION = 0x07e4;
const RT_EXTERNAL_OBJECT_LIST = 0x0409;
const RT_CSTRING = 0x0fba;
const RT_EXTERNAL_OBJECT_REF_ATOM = 0x0bc1;
const RT_OUTLINE_TEXT_REF_ATOM = 0x0f9e;
const RT_TEXT_CHARS_ATOM = 0x0fa0;
const RT_TEXT_BYTES_ATOM = 0x0fa8;
const RT_SLIDE_LIST_WITH_TEXT = 0x0ff0;
const RT_ANIMATION_INFO_ATOM = 0x0ff1;
const RT_USER_EDIT_ATOM = 0x0ff5;
const RT_PERSIST_DIRECTORY_ATOM = 0x1772;

/** `SlideListWithTextContainer.rh.recInstance`: 0 = slides, 1 = masters,
 *  2 = notes. Reading the wrong one silently yields the masters' timings. */
const SLIDE_LIST_INSTANCE_SLIDES = 0;
const SLIDE_LIST_INSTANCE_MASTERS = 1;

/**
 * `SlideShowSlideInfoAtom.fFlags`. MS-PPT interleaves reserved bits, so these
 * are NOT consecutive — reading them as bits 0..6 (the obvious guess) makes
 * `fAutoAdvance` land on `fLoopSound` and every deck looks manual-only.
 */
const FLAG_MANUAL_ADVANCE = 0x0001;
const FLAG_HIDDEN = 0x0004;
const FLAG_AUTO_ADVANCE = 0x0400;

/** `SlideAtom.slideFlags`. */
const SLIDE_FLAG_MASTER_OBJECTS = 0x0001;

/** `AnimationInfoAtom.flags` bit 12: «hide while not playing» — what
 *  PowerPoint writes for a sound whose icon must not show during the show. All
 *  1030 visible speaker icons of the hymnal carry it. */
const ANIMATION_FLAG_HIDE = 0x1000;

/** `TransitionTypeEnum` (MS-PPT 2.13.45) values with a drawing of their own.
 *  Every other non-zero value is a transition we do not draw, and arrives as a
 *  crossfade of the same length (`SlideTransition`). */
const TT_CUT = 0;
const TT_FADE = 6; // «Fade Through Black»
const TT_RANDOM_BAR = 8;
const TT_SMOOTH_FADE = 23; // «Fade Smoothly», OOXML's `<p:fade/>`

/** A record header is `recVer/recInstance` (u16), `recType` (u16), `recLen`
 *  (u32). A container is marked by `recVer == 0xF`. */
const HEADER_SIZE = 8;
const CONTAINER_VER = 0x0f;

/** `SlideShowSlideInfoAtom` is a fixed 16 bytes; anything shorter is not one. */
const SS_SLIDE_INFO_MIN_LEN = 12;

/** Bounds every recursive walk. Real decks nest ~4 deep; this only ever fires
 *  on a malformed file, where the alternative is a stack overflow in main. */
const MAX_DEPTH = 16;

/** The records stream of even a 400-slide deck is a few hundred KB. Anything
 *  past this is not a presentation we should be loading into memory on the
 *  main thread — bail and let the model reader, on its worker thread, answer. */
const MAX_RECORD_STREAM_BYTES = 32 * 1024 * 1024;

const STREAM_POWERPOINT = "PowerPoint Document";
const STREAM_CURRENT_USER = "Current User";
const STREAM_PICTURES = "Pictures";

// -- OfficeArt (MS-ODRAW) ----------------------------------------------------

const OA_BSTORE = 0xf001;
const OA_DG = 0xf002;
const OA_SPGR = 0xf003;
const OA_SP = 0xf004;
const OA_FBSE = 0xf007;
const OA_FSP = 0xf00a;
const OA_FOPT = 0xf00b;
const OA_CLIENT_TEXTBOX = 0xf00d;
const OA_CHILD_ANCHOR = 0xf00f;
const OA_CLIENT_ANCHOR = 0xf010;
const OA_CLIENT_DATA = 0xf011;
const OA_FPSPL = 0xf11d;
const OA_SECONDARY_FOPT = 0xf121;
const OA_TERTIARY_FOPT = 0xf122;
const OA_BLIP_JPEG = 0xf01d;
const OA_BLIP_PNG = 0xf01e;
const OA_BLIP_JPEG_CMYK = 0xf02a;

/** `OfficeArtFSP.flags`. */
const FSP_GROUP = 0x0001;
const FSP_CHILD = 0x0002;
const FSP_PATRIARCH = 0x0004;
const FSP_DELETED = 0x0008;
const FSP_OLE = 0x0010;
const FSP_FLIP_H = 0x0040;
const FSP_FLIP_V = 0x0080;
const FSP_CONNECTOR = 0x0100;
const FSP_BACKGROUND = 0x0400;

const SHAPE_PICTURE_FRAME = 75;

/** `recInstance` values of a BLIP record that carry a second 16-byte UID
 *  before the image bytes (MS-ODRAW 2.2.27 and siblings). */
const BLIP_TWO_UIDS = new Set([0x46b, 0x6e1, 0x6e3]);

// Shape properties (`OfficeArtFOPT` opids) a picture this reader draws may
// carry. Anything else on the shape — a recolor, brightness, shadow, 3D, a
// custom geometry — is something we would draw wrong, so its presence sends
// the deck to the model reader.
const OPT_ROTATION = 0x0004;
const OPT_CROP_FIRST = 0x0100;
const OPT_CROP_LAST = 0x0103;
const OPT_PIB = 0x0104;
const OPT_PIB_FLAGS = 0x0106;
const OPT_BLIP_BOOLEANS = 0x013f;
const OPT_FILL_BOOLEANS = 0x01bf;
const OPT_LINE_BOOLEANS = 0x01ff;
const OPT_HSP_MASTER = 0x0301;
const OPT_GROUP_BOOLEANS = 0x03bf;

/** Fill (0x0180–0x01BF) and line (0x01C0–0x01FF) details only matter when the
 *  fill or the line is on, which `fillIsOff`/`lineIsOff` decide; text layout
 *  (0x0080–0x00BF) only when the shape has text, which is refused on its own. */
function isDrawnPictureProperty(opid: number): boolean {
  return (
    opid === OPT_ROTATION ||
    opid === 0x007f || // protection
    (opid >= 0x0080 && opid <= 0x00bf) || // text layout
    (opid >= OPT_CROP_FIRST && opid <= OPT_PIB_FLAGS) || // crop, pib, pibName, pibFlags
    opid === OPT_BLIP_BOOLEANS ||
    (opid >= 0x0180 && opid <= 0x01ff) || // fill, line
    opid === OPT_HSP_MASTER ||
    opid === 0x033f || // shape booleans
    opid === 0x0380 || // name
    opid === 0x0381 || // description
    opid === OPT_GROUP_BOOLEANS
  );
}

// -- OLE2 compound file ------------------------------------------------------

const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const SECTOR_END_OF_CHAIN = 0xfffffffe;
const SECTOR_FREE = 0xffffffff;
const DIFAT_HEADER_ENTRIES = 109;
const DIR_ENTRY_SIZE = 128;
const DIR_ENTRY_TYPE_STORAGE = 1;
const DIR_ENTRY_TYPE_STREAM = 2;
const DIR_ENTRY_TYPE_ROOT = 5;
const DIR_ENTRY_NONE = 0xffffffff;

/**
 * PowerPoint 95/97 "dual storage". A `.ppt` saved for both versions keeps the
 * PowerPoint 95 stream at the root and the 97-format one — the record layout
 * this file parses — inside this storage. Reading the root's by name picks the
 * 95 one, whose records are a different format entirely: found on the user's
 * own `044.ppt`, the single deck of 673 that came back unparseable.
 */
const DUAL_STORAGE_NAME = "PP97_DUALSTORAGE";

/** A chain longer than this is a loop in a corrupt file, not a real stream. */
const MAX_CHAIN_SECTORS = 1 << 20;

export type OleFile = {
  /** Whether the root (or the 97-format storage) holds an entry of that name. */
  has: (name: string) => boolean;
  readStreamByName: (name: string) => Buffer | null;
  /** Random access into a stream without loading it: the `Pictures` stream of
   *  a hymn is most of the file, and a slide needs one picture out of it. */
  readStreamRange: (name: string, offset: number, length: number) => Buffer | null;
};

export function openOle(fd: number, fileSize: number): OleFile | null {
  const header = Buffer.alloc(512);
  if (fs.readSync(fd, header, 0, 512, 0) < 512) return null;
  if (!header.subarray(0, 8).equals(OLE_SIGNATURE)) return null;

  const sectorSize = 1 << header.readUInt16LE(30);
  const miniSectorSize = 1 << header.readUInt16LE(32);
  const fatSectorCount = header.readUInt32LE(44);
  const dirStart = header.readUInt32LE(48);
  const miniCutoff = header.readUInt32LE(56);
  const miniFatStart = header.readUInt32LE(60);
  const difatStart = header.readUInt32LE(68);
  const difatSectorCount = header.readUInt32LE(72);
  if (sectorSize < 128 || miniSectorSize < 16) return null;

  const sectorOffset = (sector: number): number => (sector + 1) * sectorSize;

  const readSector = (sector: number): Buffer | null => {
    const offset = sectorOffset(sector);
    if (offset + sectorSize > fileSize) return null;
    const buf = Buffer.alloc(sectorSize);
    return fs.readSync(fd, buf, 0, sectorSize, offset) === sectorSize ? buf : null;
  };

  // The DIFAT: which sectors hold the FAT. The first 109 live in the header;
  // the rest chain through their own sectors.
  const fatSectors: number[] = [];
  for (let i = 0; i < DIFAT_HEADER_ENTRIES && fatSectors.length < fatSectorCount; i++) {
    const value = header.readUInt32LE(76 + i * 4);
    if (value === SECTOR_FREE || value === SECTOR_END_OF_CHAIN) break;
    fatSectors.push(value);
  }
  let difatSector = difatStart;
  const entriesPerDifat = sectorSize / 4 - 1;
  for (let i = 0; i < difatSectorCount && difatSector !== SECTOR_END_OF_CHAIN; i++) {
    const buf = readSector(difatSector);
    if (!buf) break;
    for (let j = 0; j < entriesPerDifat; j++) {
      const value = buf.readUInt32LE(j * 4);
      if (value !== SECTOR_FREE && value !== SECTOR_END_OF_CHAIN) fatSectors.push(value);
    }
    difatSector = buf.readUInt32LE(sectorSize - 4);
  }

  // The FAT is read one sector at a time, on demand: following three stream
  // chains touches a handful of FAT sectors, while materializing the whole FAT
  // of a 60 MB deck would be half a megabyte read for nothing.
  const entriesPerFatSector = sectorSize / 4;
  const fatCache = new Map<number, Buffer>();
  const fatNext = (sector: number): number => {
    const index = Math.floor(sector / entriesPerFatSector);
    const fatSector = fatSectors[index];
    if (fatSector === undefined) return SECTOR_END_OF_CHAIN;
    let buf = fatCache.get(index);
    if (!buf) {
      const read = readSector(fatSector);
      if (!read) return SECTOR_END_OF_CHAIN;
      buf = read;
      fatCache.set(index, buf);
    }
    return buf.readUInt32LE((sector % entriesPerFatSector) * 4);
  };

  const chain = (start: number, next: (s: number) => number): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    let sector = start;
    while (sector !== SECTOR_END_OF_CHAIN && sector !== SECTOR_FREE && out.length < MAX_CHAIN_SECTORS) {
      if (seen.has(sector)) break;
      seen.add(sector);
      out.push(sector);
      sector = next(sector);
    }
    return out;
  };

  const readChain = (start: number, size: number | null): Buffer => {
    const sectors = chain(start, fatNext);
    const out = Buffer.alloc(sectors.length * sectorSize);
    sectors.forEach((sector, i) => {
      const buf = readSector(sector);
      if (buf) buf.copy(out, i * sectorSize);
    });
    return size === null ? out : out.subarray(0, size);
  };

  // Directory entries. The directory is a tree of red-black sibling lists, not
  // a flat list, and the hierarchy matters: see `DUAL_STORAGE_NAME`.
  const dirBuf = readChain(dirStart, null);
  type Entry = {
    name: string;
    type: number;
    start: number;
    size: number;
    left: number;
    right: number;
    child: number;
  };
  const entryCount = Math.floor(dirBuf.length / DIR_ENTRY_SIZE);
  const entryAt = (index: number): Entry | null => {
    if (index >= entryCount) return null;
    const offset = index * DIR_ENTRY_SIZE;
    const nameLen = dirBuf.readUInt16LE(offset + 64);
    if (nameLen < 2 || nameLen > 64) return null;
    return {
      name: dirBuf.toString("utf16le", offset, offset + nameLen - 2),
      type: dirBuf.readUInt8(offset + 66),
      start: dirBuf.readUInt32LE(offset + 116),
      size: dirBuf.readUInt32LE(offset + 120),
      left: dirBuf.readUInt32LE(offset + 68),
      right: dirBuf.readUInt32LE(offset + 72),
      child: dirBuf.readUInt32LE(offset + 76),
    };
  };

  /** The direct children of one storage, by name. */
  const childrenOf = (childIndex: number): Map<string, Entry> => {
    const out = new Map<string, Entry>();
    const seen = new Set<number>();
    const visit = (index: number): void => {
      if (index === DIR_ENTRY_NONE || seen.has(index)) return;
      seen.add(index);
      const entry = entryAt(index);
      if (!entry) return;
      visit(entry.left);
      out.set(entry.name, entry);
      visit(entry.right);
    };
    visit(childIndex);
    return out;
  };

  const root = entryAt(0);
  if (!root || root.type !== DIR_ENTRY_TYPE_ROOT) return null;
  const rootChildren = childrenOf(root.child);

  // Prefer the 97-format storage when the file carries both.
  const dual = rootChildren.get(DUAL_STORAGE_NAME);
  const streamHome =
    dual && dual.type === DIR_ENTRY_TYPE_STORAGE ? childrenOf(dual.child) : rootChildren;

  // The mini stream, for entries below `miniCutoff`, lives inside the root
  // entry's own chain and is indexed by its own FAT.
  let miniStream: Buffer | null = null;
  let miniFatNext: ((sector: number) => number) | null = null;
  const loadMini = (): void => {
    if (miniStream) return;
    miniStream = readChain(root.start, root.size);
    const miniFatBuf = readChain(miniFatStart, null);
    miniFatNext = (sector: number): number =>
      sector * 4 + 4 <= miniFatBuf.length ? miniFatBuf.readUInt32LE(sector * 4) : SECTOR_END_OF_CHAIN;
  };

  const streamEntry = (name: string): Entry | null => {
    const entry = streamHome.get(name);
    return entry && entry.type === DIR_ENTRY_TYPE_STREAM ? entry : null;
  };

  const readSmallStream = (entry: Entry): Buffer | null => {
    loadMini();
    if (!miniStream || !miniFatNext) return null;
    const sectors = chain(entry.start, miniFatNext);
    const out = Buffer.alloc(sectors.length * miniSectorSize);
    sectors.forEach((sector, i) => {
      const from = sector * miniSectorSize;
      miniStream!.copy(out, i * miniSectorSize, from, from + miniSectorSize);
    });
    return out.subarray(0, entry.size);
  };

  const readStreamByName = (name: string): Buffer | null => {
    const entry = streamEntry(name);
    if (!entry || entry.size > MAX_RECORD_STREAM_BYTES) return null;
    if (entry.size >= miniCutoff) return readChain(entry.start, entry.size);
    return readSmallStream(entry);
  };

  // A stream's sector list, built once per stream: walking the FAT is cheap
  // (one cached FAT sector per 128 data sectors), reading the data is not.
  const sectorLists = new Map<string, number[]>();
  const readStreamRange = (name: string, offset: number, length: number): Buffer | null => {
    const entry = streamEntry(name);
    if (!entry || offset < 0 || length < 0 || offset + length > entry.size) return null;
    if (entry.size < miniCutoff) return readSmallStream(entry)?.subarray(offset, offset + length) ?? null;

    let sectors = sectorLists.get(name);
    if (!sectors) {
      sectors = chain(entry.start, fatNext);
      sectorLists.set(name, sectors);
    }
    const out = Buffer.alloc(length);
    let written = 0;
    while (written < length) {
      const position = offset + written;
      const sector = sectors[Math.floor(position / sectorSize)];
      if (sector === undefined) return null;
      const within = position % sectorSize;
      // Runs of consecutive sectors are read in one call: PowerPoint writes a
      // picture contiguously almost always, so a 100 KB JPEG is one read.
      let run = sectorSize - within;
      let index = Math.floor(position / sectorSize);
      while (written + run < length && sectors[index + 1] === sectors[index]! + 1) {
        index += 1;
        run += sectorSize;
      }
      const take = Math.min(run, length - written);
      if (fs.readSync(fd, out, written, take, sectorOffset(sector) + within) !== take) return null;
      written += take;
    }
    return out;
  };

  const has = (name: string): boolean => streamHome.has(name) || rootChildren.has(name);

  return { has, readStreamByName, readStreamRange };
}

// -- record walking ----------------------------------------------------------

type RecordVisit = (recType: number, recInstance: number, body: number, len: number) => void;

/** Walks the records between `start` and `end`, descending into containers.
 *  `cb` sees atoms AND containers, so a caller can stop at a container it
 *  recognizes. */
export function walkRecords(buf: Buffer, start: number, end: number, depth: number, cb: RecordVisit): void {
  if (depth > MAX_DEPTH) return;
  let pointer = start;
  while (pointer + HEADER_SIZE <= end) {
    const verInstance = buf.readUInt16LE(pointer);
    const recType = buf.readUInt16LE(pointer + 2);
    const recLen = buf.readUInt32LE(pointer + 4);
    const body = pointer + HEADER_SIZE;
    if (body + recLen > end || recLen < 0) return;

    cb(recType, verInstance >> 4, body, recLen);
    if ((verInstance & 0x0f) === CONTAINER_VER) {
      walkRecords(buf, body, body + recLen, depth + 1, cb);
    }
    pointer = body + recLen;
  }
}

/** Reads one record header at an absolute offset, validating it fits. */
export function recordAt(
  buf: Buffer,
  offset: number,
): { recType: number; recInstance: number; body: number; len: number } | null {
  if (offset < 0 || offset + HEADER_SIZE > buf.length) return null;
  const recInstance = buf.readUInt16LE(offset) >> 4;
  const recType = buf.readUInt16LE(offset + 2);
  const len = buf.readUInt32LE(offset + 4);
  const body = offset + HEADER_SIZE;
  if (body + len > buf.length) return null;
  return { recType, recInstance, body, len };
}

export type Rec = { recType: number; recInstance: number; body: number; len: number; container: boolean };

/** The direct children of a container — no descent. */
export function childrenOf(buf: Buffer, parent: { body: number; len: number }): Rec[] {
  const out: Rec[] = [];
  let pointer = parent.body;
  const end = parent.body + parent.len;
  while (pointer + HEADER_SIZE <= end) {
    const verInstance = buf.readUInt16LE(pointer);
    const len = buf.readUInt32LE(pointer + 4);
    const body = pointer + HEADER_SIZE;
    if (body + len > end) break;
    out.push({
      recType: buf.readUInt16LE(pointer + 2),
      recInstance: verInstance >> 4,
      body,
      len,
      container: (verInstance & 0x0f) === CONTAINER_VER,
    });
    pointer = body + len;
  }
  return out;
}

/** The first record of a type anywhere under `parent`, depth-bounded. */
export function findDeep(buf: Buffer, parent: { body: number; len: number }, recType: number): Rec | null {
  let found: Rec | null = null;
  walkRecords(buf, parent.body, parent.body + parent.len, 0, (type, instance, body, len) => {
    if (!found && type === recType) found = { recType: type, recInstance: instance, body, len, container: false };
  });
  return found;
}

// -- the document --------------------------------------------------------------

export type PptDocument = {
  ole: OleFile;
  doc: Buffer;
  persistOffsets: Map<number, number>;
  documentContainer: { body: number; len: number };
  /** In presentation order. */
  slidePersistIds: number[];
  /** A master's persist id by its `slideId` — what `SlideAtom.masterIdRef`
   *  names. It is NOT a persist id: read as one, it finds nothing. */
  masterPersistIds: Map<number, number>;
};

/** Everything both readers start from, or `null` when this is not a parseable
 *  PowerPoint 97+ binary. */
function openDocument(fd: number): PptDocument | null {
  const fileSize = fs.fstatSync(fd).size;
  const ole = openOle(fd, fileSize);
  if (!ole) return null;

  const doc = ole.readStreamByName(STREAM_POWERPOINT);
  if (!doc) return null;

  const currentUser = ole.readStreamByName(STREAM_CURRENT_USER);
  // `CurrentUserAtom`: rh (8) + size (4) + headerToken (4), then the offset
  // of the most recent UserEditAtom in the records stream.
  if (!currentUser || currentUser.length < 20) return null;
  const currentEditOffset = currentUser.readUInt32LE(16);

  // Walk the edit chain newest → oldest. Each edit contributes a persist
  // directory; an id already seen belongs to a newer edit and wins.
  const persistOffsets = new Map<number, number>();
  let docPersistIdRef: number | null = null;
  let editOffset = currentEditOffset;
  const seenEdits = new Set<number>();
  while (editOffset !== 0 && !seenEdits.has(editOffset)) {
    seenEdits.add(editOffset);
    const edit = recordAt(doc, editOffset);
    if (!edit || edit.recType !== RT_USER_EDIT_ATOM || edit.len < 28) break;

    if (docPersistIdRef === null) docPersistIdRef = doc.readUInt32LE(edit.body + 16);
    readPersistDirectory(doc, doc.readUInt32LE(edit.body + 12), persistOffsets);
    editOffset = doc.readUInt32LE(edit.body + 8);
  }
  if (docPersistIdRef === null) return null;

  const docOffset = persistOffsets.get(docPersistIdRef);
  if (docOffset === undefined) return null;
  const documentContainer = recordAt(doc, docOffset);
  if (!documentContainer || documentContainer.recType !== RT_DOCUMENT) return null;

  // The slide list, in presentation order — and the masters' list, which is
  // what a slide's `masterIdRef` is looked up in. Notes have a third list.
  const slidePersistIds: number[] = [];
  const masterPersistIds = new Map<number, number>();
  for (const list of childrenOf(doc, documentContainer)) {
    if (list.recType !== RT_SLIDE_LIST_WITH_TEXT) continue;
    for (const atom of childrenOf(doc, list)) {
      if (atom.recType !== RT_SLIDE_PERSIST_ATOM || atom.len < 16) continue;
      const persistId = doc.readUInt32LE(atom.body);
      if (list.recInstance === SLIDE_LIST_INSTANCE_SLIDES) slidePersistIds.push(persistId);
      else if (list.recInstance === SLIDE_LIST_INSTANCE_MASTERS) {
        masterPersistIds.set(doc.readUInt32LE(atom.body + 12), persistId);
      }
    }
  }

  if (slidePersistIds.length === 0) return null;
  return { ole, doc, persistOffsets, documentContainer, slidePersistIds, masterPersistIds };
}

/** Opens the file, hands the parsed document to `read`, and closes the file
 *  whatever happens. Every failure means "another reader answers", so it is
 *  `null`, never a throw. */
export function withDocument<T>(filePath: string, read: (document: PptDocument) => T | null): T | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const document = openDocument(fd);
    return document ? read(document) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

/** `PersistDirectoryAtom`: a sequence of `{ persistId:20 | cPersist:12 }`
 *  headers, each followed by `cPersist` stream offsets. */
function readPersistDirectory(doc: Buffer, offset: number, into: Map<number, number>): void {
  const record = recordAt(doc, offset);
  if (!record || record.recType !== RT_PERSIST_DIRECTORY_ATOM) return;

  let pointer = record.body;
  const end = record.body + record.len;
  while (pointer + 4 <= end) {
    const packed = doc.readUInt32LE(pointer);
    pointer += 4;
    const firstId = packed & 0x000fffff;
    const count = packed >>> 20;
    if (count === 0) break;
    for (let i = 0; i < count && pointer + 4 <= end; i++, pointer += 4) {
      const id = firstId + i;
      // Newest edit first: an id already present came from a later edit.
      if (!into.has(id)) into.set(id, doc.readUInt32LE(pointer));
    }
  }
}

export type SlideInfo = {
  autoAdvanceMs: number | null;
  hidden: boolean;
  advanceOnClick: boolean;
  transition: SlideTransition | null;
};

export function readSlideInfo(doc: Buffer, slide: { body: number; len: number }): SlideInfo | null {
  const atom = childrenOf(doc, slide).find(
    (child) => child.recType === RT_SS_SLIDE_INFO_ATOM && child.len >= SS_SLIDE_INFO_MIN_LEN,
  );
  if (!atom) return null;
  const slideTime = doc.readInt32LE(atom.body);
  const flags = doc.readUInt16LE(atom.body + 10);
  return {
    // `slideTime` is only meaningful when the deck actually auto-advances;
    // PowerPoint leaves the last value behind when the box is unticked.
    autoAdvanceMs: (flags & FLAG_AUTO_ADVANCE) !== 0 && slideTime > 0 ? slideTime : null,
    hidden: (flags & FLAG_HIDDEN) !== 0,
    advanceOnClick: (flags & FLAG_MANUAL_ADVANCE) !== 0,
    transition: binaryTransition(doc[atom.body + 9]!, doc[atom.body + 8]!, doc[atom.body + 12]),
  };
}

/** `effectType`, `effectDirection` and `speed` (0 slow, 1 medium, 2 fast) of
 *  a `SlideShowSlideInfoAtom`, as the transition the slide enters with. */
export function binaryTransition(
  effectType: number,
  effectDirection: number,
  speed: number | undefined,
): SlideTransition | null {
  if (effectType === TT_CUT) return null;
  const durationMs =
    speed === 0
      ? SLIDE_TRANSITION_SPEED_MS.slow
      : speed === 1
        ? SLIDE_TRANSITION_SPEED_MS.medium
        : SLIDE_TRANSITION_SPEED_MS.fast;
  let style: SlideTransitionStyle = "crossfade";
  if (effectType === TT_FADE) style = "fade-through-black";
  else if (effectType === TT_RANDOM_BAR) {
    style = effectDirection === 1 ? "random-bars-vertical" : "random-bars-horizontal";
  } else if (effectType === TT_SMOOTH_FADE) style = "crossfade";
  return { style, durationMs };
}

// -- public: timings -----------------------------------------------------------

export type BinarySlideTiming = {
  /** 1-based, in presentation order. */
  slideIndex: number;
  /** Milliseconds to wait before advancing, or null when the slide does not
   *  auto-advance at all. Unrounded, as PowerPoint stored it. */
  autoAdvanceMs: number | null;
  hidden: boolean;
  /** Whether a click also advances. Recorded for completeness; the app does
   *  not act on it. */
  advanceOnClick: boolean;
  transition: SlideTransition | null;
};

/**
 * Per-slide timings from a legacy binary presentation, in presentation order,
 * or `null` when the file is not a parseable OLE2 PowerPoint deck.
 *
 * Never throws: every failure mode here (a truncated file, a format we do not
 * recognize, a persist id with no offset) means "no timings", never "the deck
 * fails".
 */
export function readBinarySlideTimings(filePath: string): BinarySlideTiming[] | null {
  return withDocument(filePath, ({ doc, persistOffsets, slidePersistIds }) =>
    slidePersistIds.map((persistId, index) => {
      const offset = persistOffsets.get(persistId);
      const slide = offset === undefined ? null : recordAt(doc, offset);
      const info = slide ? readSlideInfo(doc, slide) : null;
      return {
        slideIndex: index + 1,
        autoAdvanceMs: info?.autoAdvanceMs ?? null,
        hidden: info?.hidden ?? false,
        advanceOnClick: info?.advanceOnClick ?? true,
        transition: info?.transition ?? null,
      };
    }),
  );
}

/**
 * Every path the deck's external objects record — a linked sound's is the
 * file it played on whoever's machine made it, `C:\\Documents and
 * Settings\\…\\522 Suenen las palabras.mp3`. `null` when this is not a
 * parseable binary.
 *
 * What `linked-audio.ts` matches beside the deck. It used to find it by
 * running a regex over the whole file in two encodings: 0.4–1.7 s on the main
 * thread per hymn, the first time each was opened — the whole wait once the
 * deck itself takes 2 ms.
 */
export function readBinaryExternalPaths(filePath: string): string[] | null {
  return withDocument(filePath, ({ doc, documentContainer }) => {
    const list = childrenOf(doc, documentContainer).find((child) => child.recType === RT_EXTERNAL_OBJECT_LIST);
    const paths: string[] = [];
    if (list) {
      walkRecords(doc, list.body, list.body + list.len, 0, (type, _instance, body, len) => {
        if (type === RT_CSTRING) paths.push(doc.toString("utf16le", body, body + len));
      });
    }
    return paths;
  });
}

// -- public: the deck ------------------------------------------------------------

/** Where one picture's bytes sit inside the `Pictures` stream. */
export type BinaryPictureRef = { offset: number; length: number; type: "jpeg" | "png" };

/** One picture of a slide, placed in the slide's own units (`BinaryDeck`). */
export type BinaryDeckLayer = BinaryPictureRef & { x: number; y: number; width: number; height: number };

export type BinaryDeckSlide = {
  autoAdvanceMs: number | null;
  advanceOnClick: boolean;
  transition: SlideTransition | null;
  /** Bottom to top. The first one always covers the whole slide and is opaque,
   *  so nothing under it — background, master — is ever needed. */
  layers: BinaryDeckLayer[];
};

export type BinaryDeck = {
  /** The slide's size in master units (576 per inch). */
  width: number;
  height: number;
  /** The VISIBLE slides, in presentation order — hidden ones are left out, as
   *  PowerPoint's show leaves them out. */
  slides: BinaryDeckSlide[];
};

/** A deck we can read but not draw exactly, and why — for the log, so a deck
 *  that goes to the model reader says what stopped it here. */
export type BinaryDeckRefusal = { unsupported: string };

class Unsupported extends Error {}

/**
 * The deck as pictures, or the reason it isn't one we draw, or `null` when
 * the file is not a parseable binary at all.
 *
 * The rule, per visible slide: the topmost opaque JPEG that covers the whole
 * slide is its base, and everything above it must be either a picture we draw
 * as is or something PowerPoint does not show (off the slide, hidden, a sound
 * icon flagged to hide). Anything else anywhere refuses the whole deck — half
 * a deck through each path would be two looks in one hymn.
 */
export function readBinaryDeck(filePath: string): { deck: BinaryDeck } | BinaryDeckRefusal | null {
  return withDocument(filePath, (document) => {
    try {
      return { deck: buildDeck(document) };
    } catch (error) {
      if (error instanceof Unsupported) return { unsupported: error.message };
      throw error;
    }
  });
}

function buildDeck({
  ole,
  doc,
  persistOffsets,
  documentContainer,
  slidePersistIds,
  masterPersistIds,
}: PptDocument): BinaryDeck {
  const children = childrenOf(doc, documentContainer);
  const documentAtom = children.find((child) => child.recType === RT_DOCUMENT_ATOM && child.len >= 8);
  if (!documentAtom) throw new Unsupported("no DocumentAtom");
  const width = doc.readInt32LE(documentAtom.body);
  const height = doc.readInt32LE(documentAtom.body + 4);
  if (width <= 0 || height <= 0) throw new Unsupported("no slide size");

  // An embedded sound lives in the document, not in a sibling file: this
  // reader serves pictures only, so a deck with one goes to the model reader.
  const sounds = children.find((child) => child.recType === RT_SOUND_COLLECTION);
  if (sounds && childrenOf(doc, sounds).some((child) => child.container)) {
    throw new Unsupported("embedded sound");
  }

  const blips = readBlipStore(doc, children);
  const pictureCache = new Map<number, BinaryPictureRef>();
  const pictureFor = (pib: number): BinaryPictureRef => {
    const cached = pictureCache.get(pib);
    if (cached) return cached;
    const foDelay = blips[pib - 1];
    if (foDelay === undefined) throw new Unsupported(`picture ${pib} not in the BLIP store`);
    const head = ole.readStreamRange(STREAM_PICTURES, foDelay, HEADER_SIZE);
    if (!head) throw new Unsupported(`picture ${pib} outside the Pictures stream`);
    const recInstance = head.readUInt16LE(0) >> 4;
    const recType = head.readUInt16LE(2);
    const len = head.readUInt32LE(4);
    const type =
      recType === OA_BLIP_JPEG || recType === OA_BLIP_JPEG_CMYK ? "jpeg" : recType === OA_BLIP_PNG ? "png" : null;
    if (!type) throw new Unsupported(`picture format 0x${recType.toString(16)}`);
    // rgbUid1 (16), rgbUid2 (16, some instances), tag (1), then the image.
    const skip = 16 + (BLIP_TWO_UIDS.has(recInstance) ? 16 : 0) + 1;
    if (len <= skip) throw new Unsupported(`picture ${pib} is empty`);
    const ref: BinaryPictureRef = { offset: foDelay + HEADER_SIZE + skip, length: len - skip, type };
    pictureCache.set(pib, ref);
    return ref;
  };

  const masterShapes = new Map<number, Map<number, Map<number, number>>>();
  const shapesOfMaster = (masterId: number): Map<number, Map<number, number>> => {
    let shapes = masterShapes.get(masterId);
    if (!shapes) {
      shapes = new Map();
      const persistId = masterPersistIds.get(masterId);
      const offset = persistId === undefined ? undefined : persistOffsets.get(persistId);
      const master = offset === undefined ? null : recordAt(doc, offset);
      if (master && master.recType === RT_MAIN_MASTER) {
        for (const shape of drawingShapes(doc, master)) shapes.set(shape.spid, shape.props);
      }
      masterShapes.set(masterId, shapes);
    }
    return shapes;
  };

  const slides: BinaryDeckSlide[] = [];
  slidePersistIds.forEach((persistId, index) => {
    const offset = persistOffsets.get(persistId);
    const slide = offset === undefined ? null : recordAt(doc, offset);
    if (!slide || slide.recType !== RT_SLIDE) throw new Unsupported(`slide ${index + 1} has no container`);
    const info = readSlideInfo(doc, slide);
    if (info?.hidden) return;

    const atom = childrenOf(doc, slide).find((child) => child.recType === RT_SLIDE_ATOM && child.len >= 22);
    if (!atom) throw new Unsupported(`slide ${index + 1} has no SlideAtom`);
    const master = shapesOfMaster(doc.readUInt32LE(atom.body + 12));
    const masterObjects = (doc.readUInt16LE(atom.body + 20) & SLIDE_FLAG_MASTER_OBJECTS) !== 0;

    const layers = slideLayers(doc, slide, master, pictureFor, width, height, index + 1, masterObjects);
    slides.push({
      autoAdvanceMs: info?.autoAdvanceMs ?? null,
      advanceOnClick: info?.advanceOnClick ?? true,
      transition: info?.transition ?? null,
      layers,
    });
  });
  if (slides.length === 0) throw new Unsupported("no visible slides");
  return { width, height, slides };
}

/** `foDelay` of every BLIP in the document's store, by `pib - 1`. A BLIP kept
 *  inside the store itself rather than in the `Pictures` stream reads as
 *  `undefined` and refuses whatever uses it. */
export function readBlipStore(doc: Buffer, documentChildren: Rec[]): (number | undefined)[] {
  const group = documentChildren.find((child) => child.recType === RT_DRAWING_GROUP);
  if (!group) return [];
  const store = findDeep(doc, group, OA_BSTORE);
  if (!store) return [];
  return childrenOf(doc, store).map((entry) => {
    // OfficeArtFBSE: btWin32, btMacOS, rgbUid (16), tag (2), size (4),
    // cRef (4), foDelay (4)… and 36 bytes in all when the BLIP is elsewhere.
    if (entry.recType !== OA_FBSE || entry.len !== 36) return undefined;
    return doc.readUInt32LE(entry.body + 28);
  });
}

type Shape = {
  spid: number;
  type: number;
  flags: number;
  props: Map<number, number>;
  /** top, left, right, bottom — `null` without a client anchor. */
  anchor: [number, number, number, number] | null;
  hasText: boolean;
  /** A sound or movie told to hide while it is not playing. */
  hiddenMedia: boolean;
  /** Carries a record this reader does not know, so it is never drawn. */
  foreign: boolean;
};

/** The records a shape container may hold without making it `foreign`. */
const KNOWN_SHAPE_RECORDS = new Set([
  OA_FSP,
  OA_FOPT,
  OA_SECONDARY_FOPT,
  OA_TERTIARY_FOPT,
  OA_CLIENT_ANCHOR,
  OA_CHILD_ANCHOR,
  OA_CLIENT_DATA,
  OA_CLIENT_TEXTBOX,
  OA_FPSPL,
]);

/** The shapes of a slide or master drawing, in z-order (bottom first). A
 *  group's members are flattened in its place and flagged `FSP_CHILD`: they
 *  are positioned in the group's own coordinates, which this reader does not
 *  resolve, so it never draws one. */
function drawingShapes(doc: Buffer, container: { body: number; len: number }): Shape[] {
  const drawing = childrenOf(doc, container).find((child) => child.recType === RT_DRAWING);
  if (!drawing) return [];
  const dg = childrenOf(doc, drawing).find((child) => child.recType === OA_DG);
  if (!dg) return [];

  const shapes: Shape[] = [];
  const read = (sp: Rec, grouped: boolean): void => {
    let fsp: Rec | undefined;
    const props = new Map<number, number>();
    let anchor: Shape["anchor"] = null;
    let hasText = false;
    let hiddenMedia = false;
    let media = false;
    let foreign = false;
    for (const child of childrenOf(doc, sp)) {
      if (!KNOWN_SHAPE_RECORDS.has(child.recType)) foreign = true;
      if (child.recType === OA_FSP && child.len >= 8) fsp = child;
      else if (child.recType === OA_FOPT || child.recType === OA_SECONDARY_FOPT || child.recType === OA_TERTIARY_FOPT) {
        for (const [opid, value] of readProps(doc, child)) props.set(opid, value);
      } else if (child.recType === OA_CLIENT_ANCHOR) {
        anchor =
          child.len >= 16
            ? [doc.readInt32LE(child.body), doc.readInt32LE(child.body + 4), doc.readInt32LE(child.body + 8), doc.readInt32LE(child.body + 12)]
            : child.len >= 8
              ? [doc.readInt16LE(child.body), doc.readInt16LE(child.body + 2), doc.readInt16LE(child.body + 4), doc.readInt16LE(child.body + 6)]
              : null;
      } else if (child.recType === OA_CLIENT_TEXTBOX) {
        walkRecords(doc, child.body, child.body + child.len, 0, (type, _instance, body, len) => {
          if (type === RT_OUTLINE_TEXT_REF_ATOM) hasText = true;
          if (type === RT_TEXT_CHARS_ATOM && doc.toString("utf16le", body, body + len).trim() !== "") hasText = true;
          if (type === RT_TEXT_BYTES_ATOM && doc.toString("latin1", body, body + len).trim() !== "") hasText = true;
        });
      } else if (child.recType === OA_CLIENT_DATA) {
        // What matters inside: the media reference and its animation flags.
        walkRecords(doc, child.body, child.body + child.len, 0, (type, _instance, body, len) => {
          if (type === RT_EXTERNAL_OBJECT_REF_ATOM) media = true;
          if (type === RT_ANIMATION_INFO_ATOM && len >= 6) {
            hiddenMedia = (doc.readUInt16LE(body + 4) & ANIMATION_FLAG_HIDE) !== 0;
          }
        });
      }
    }
    if (!fsp) return;
    const flags = doc.readUInt32LE(fsp.body + 4);
    shapes.push({
      spid: doc.readUInt32LE(fsp.body),
      type: fsp.recInstance,
      flags: grouped ? flags | FSP_CHILD : flags,
      props,
      anchor,
      hasText,
      hiddenMedia: media && hiddenMedia,
      foreign,
    });
  };

  // The top-level group's first shape is the patriarch, a group of its own
  // that stays top level; a nested group's first shape is that group.
  const readGroup = (group: Rec, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    for (const member of childrenOf(doc, group)) {
      if (member.recType === OA_SP) read(member, depth > 0);
      else if (member.recType === OA_SPGR) readGroup(member, depth + 1);
    }
  };

  for (const child of childrenOf(doc, dg)) {
    if (child.recType === OA_SP) read(child, false);
    else if (child.recType === OA_SPGR) readGroup(child, 0);
  }
  return shapes;
}

/** `OfficeArtFOPT`: `recInstance` simple properties of 6 bytes each. Complex
 *  data (names) follows them and is not needed. */
export function readProps(doc: Buffer, fopt: Rec): Map<number, number> {
  const props = new Map<number, number>();
  for (let i = 0; i < fopt.recInstance && (i + 1) * 6 <= fopt.len; i++) {
    const at = fopt.body + i * 6;
    props.set(doc.readUInt16LE(at) & 0x3fff, doc.readUInt32LE(at + 2));
  }
  return props;
}

function slideLayers(
  doc: Buffer,
  slide: { body: number; len: number },
  master: Map<number, Map<number, number>>,
  pictureFor: (pib: number) => BinaryPictureRef,
  width: number,
  height: number,
  number: number,
  masterObjects: boolean,
): BinaryDeckLayer[] {
  const shapes = drawingShapes(doc, slide).filter(
    (shape) => (shape.flags & (FSP_DELETED | FSP_BACKGROUND)) === 0 && (shape.flags & FSP_PATRIARCH) === 0,
  );

  /** A shape's own properties over the master shape it inherits from, or
   *  `null` when that master shape is not there to inherit from. */
  const effective = (shape: Shape): Map<number, number> | null => {
    const masterSpid = shape.props.get(OPT_HSP_MASTER);
    if (masterSpid === undefined) return shape.props;
    const inherited = master.get(masterSpid);
    if (!inherited) return null;
    const merged = new Map(inherited);
    for (const [opid, value] of shape.props) {
      const fromMaster = inherited.get(opid);
      merged.set(opid, fromMaster !== undefined && isBooleanProperty(opid) ? mergeBooleans(value, fromMaster) : value);
    }
    return merged;
  };

  const pictureLayer = (shape: Shape, mustCover: boolean): BinaryDeckLayer | null => {
    const props = effective(shape);
    if (!props || shape.foreign || shape.type !== SHAPE_PICTURE_FRAME || shape.hasText || !shape.anchor) return null;
    if (shape.flags & (FSP_GROUP | FSP_CHILD | FSP_OLE | FSP_FLIP_H | FSP_FLIP_V | FSP_CONNECTOR)) return null;
    for (const opid of props.keys()) if (!isDrawnPictureProperty(opid)) return null;
    const pib = props.get(OPT_PIB);
    if (pib === undefined || pib <= 0) return null;
    if ((props.get(OPT_ROTATION) ?? 0) !== 0 || (props.get(OPT_PIB_FLAGS) ?? 0) !== 0) return null;
    for (let opid = OPT_CROP_FIRST; opid <= OPT_CROP_LAST; opid++) if ((props.get(opid) ?? 0) !== 0) return null;
    // Grayscale, bi-level: the low half of the BLIP booleans.
    if (((props.get(OPT_BLIP_BOOLEANS) ?? 0) & 0xffff) !== 0) return null;
    if (!lineIsOff(props)) return null;

    const [top, left, right, bottom] = shape.anchor;
    if (right <= left || bottom <= top) return null;
    const picture = pictureFor(pib);
    if (mustCover) {
      if (picture.type !== "jpeg") return null;
      if (left > 0 || top > 0 || right < width || bottom < height) return null;
    } else if (picture.type === "png" && !fillIsOff(props)) {
      // A fill shows through the transparent parts of a PNG.
      return null;
    }
    return { ...picture, x: left, y: top, width: right - left, height: bottom - top };
  };

  // The base: the topmost opaque JPEG covering the whole slide. Nothing under
  // it can show, so nothing under it — background, master objects, a title
  // placeholder left behind — has to be understood.
  let baseIndex = -1;
  let base: BinaryDeckLayer | null = null;
  for (const [index, shape] of shapes.entries()) {
    const layer = pictureLayer(shape, true);
    if (layer) {
      baseIndex = index;
      base = layer;
    }
  }
  if (!base) {
    throw new Unsupported(
      `slide ${number} is not covered by a picture${masterObjects ? " (and shows the master's objects)" : ""}`,
    );
  }

  const layers: BinaryDeckLayer[] = [base];
  for (const shape of shapes.slice(baseIndex + 1)) {
    if (shape.hiddenMedia) continue;
    const props = effective(shape);
    if (props && isHidden(props)) continue;
    if (shape.anchor) {
      const [top, left, right, bottom] = shape.anchor;
      if (right <= 0 || bottom <= 0 || left >= width || top >= height) continue;
    }
    const layer = pictureLayer(shape, false);
    if (!layer) throw new Unsupported(`slide ${number}: a shape over the picture (type ${shape.type}) is not a plain picture`);
    layers.push(layer);
  }
  return layers;
}

/** Every property set ends in one of these: 16 flags, each meaningful only
 *  where its `fUse` twin in the high half is set (MS-ODRAW 2.3). */
export function isBooleanProperty(opid: number): boolean {
  return (opid & 0x3f) === 0x3f;
}

/** A shape's booleans over the master shape's, flag by flag: a flag the shape
 *  does not `fUse` is the master's. Measured on the hymnal: 166 covers say
 *  nothing about their line, and the master's body placeholder they inherit
 *  from says «no line». */
export function mergeBooleans(own: number, inherited: number): number {
  const ownUse = (own >>> 16) & 0xffff;
  const values = (own & ownUse) | (inherited & ~ownUse & 0xffff);
  return (((own | inherited) & 0xffff0000) | values) >>> 0;
}

/** `fHidden` with its `fUsefHidden`: the shape exists but is not shown. */
function isHidden(props: Map<number, number>): boolean {
  const value = props.get(OPT_GROUP_BOOLEANS) ?? 0;
  return (value & 0x00020000) !== 0 && (value & 0x00000002) !== 0;
}

/** Only an explicit «no line» counts. `fLine` is meaningful only under its
 *  `fUsefLine` bit, and a shape that says nothing inherits a default this
 *  reader does not want to guess — every picture of the hymnal says it, on the
 *  shape or on the master shape it inherits from. */
function lineIsOff(props: Map<number, number>): boolean {
  const value = props.get(OPT_LINE_BOOLEANS);
  return value !== undefined && (value & 0x00080000) !== 0 && (value & 0x00000008) === 0;
}

/** The same rule for `fFilled` (bit 4) under `fUsefFilled` (bit 20). */
function fillIsOff(props: Map<number, number>): boolean {
  const value = props.get(OPT_FILL_BOOLEANS);
  return value !== undefined && (value & 0x00100000) !== 0 && (value & 0x00000010) === 0;
}

// -- public: the pictures ---------------------------------------------------------

/** The bytes of each picture, read straight out of the file — `null` when the
 *  file is no longer the deck those references were taken from. */
export function readBinaryPictures(filePath: string, refs: readonly BinaryPictureRef[]): Buffer[] | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const ole = openOle(fd, fs.fstatSync(fd).size);
    if (!ole) return null;
    const out: Buffer[] = [];
    for (const ref of refs) {
      const bytes = ole.readStreamRange(STREAM_PICTURES, ref.offset, ref.length);
      if (!bytes) return null;
      out.push(bytes);
    }
    return out;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

// -- public: why a deck won't open ---------------------------------------------

/** Why no reader could open a deck, from its bytes — see `sniffUnreadableDeck`. */
export type UnreadableDeckReason = "DECK_PASSWORD" | "DECK_OLD_FORMAT" | "NOT_A_PRESENTATION";

/** `CurrentUserAtom.headerToken` of a deck whose records are encrypted
 *  (MS-PPT 2.3.2); an open one says `0xE391C05F`. */
const HEADER_TOKEN_ENCRYPTED = 0xf3d1c4df;
/** The shortest PowerPoint 97 `CurrentUserAtom` stream: PowerPoint 95 wrote a
 *  15-byte one beside a `PowerPoint Document` of its own, older format. */
const CURRENT_USER_97_MIN_LEN = 28;

/**
 * A look at a deck every reader declined, so the operator is told what they
 * can do about it rather than only that it failed. Names only, plus one atom:
 *
 * - **A password.** An encrypted `.pptx` is not a zip but an OLE file holding
 *   `EncryptionInfo` + `EncryptedPackage` (MS-OFFCRYPTO); an encrypted
 *   PowerPoint 97 deck keeps an `EncryptedSummary` stream and flags its
 *   `CurrentUserAtom`.
 * - **PowerPoint 95 or older.** A `PP40` stream and no `PowerPoint Document`
 *   (PowerPoint 4), or a `PowerPoint Document` whose `Current User` is too
 *   short to be the 97 atom (PowerPoint 95) — what Apache POI tells apart too.
 * - **Anything else** is not a presentation we know.
 */
export function sniffUnreadableDeck(filePath: string): UnreadableDeckReason {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const ole = openOle(fd, fs.fstatSync(fd).size);
    if (!ole) return "NOT_A_PRESENTATION";
    if (ole.has("EncryptionInfo") || ole.has("EncryptedPackage") || ole.has("EncryptedSummary")) return "DECK_PASSWORD";
    if (!ole.has(STREAM_POWERPOINT)) return ole.has("PP40") ? "DECK_OLD_FORMAT" : "NOT_A_PRESENTATION";
    const currentUser = ole.readStreamByName(STREAM_CURRENT_USER);
    if (!currentUser || currentUser.length < CURRENT_USER_97_MIN_LEN) return "DECK_OLD_FORMAT";
    return currentUser.readUInt32LE(12) === HEADER_TOKEN_ENCRYPTED ? "DECK_PASSWORD" : "NOT_A_PRESENTATION";
  } catch {
    return "NOT_A_PRESENTATION";
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
