/**
 * A legacy binary `.ppt` (an OLE2 compound file carrying a PowerPoint 97
 * record stream), built rather than checked in: the readers get deterministic
 * fixtures that cost no binary in the repo, and the structures they depend on
 * are spelled out here — the persist directory, the slide list that defines
 * PRESENTATION order, the `SlideShowSlideInfoAtom` flag layout, the BLIP store
 * and the `Pictures` stream, the OfficeArt shapes of a slide, and the master a
 * shape can inherit its properties from.
 *
 * With no arguments it is the deck the timings reader was first tested on: two
 * slides, the first auto-advancing after 12345 ms, the second not (its
 * `fAutoAdvance` bit is clear, with a stale `slideTime` left behind — exactly
 * what PowerPoint writes when the box is unticked).
 *
 * Every stream is padded to `miniCutoff`, so they all live in ordinary sectors
 * — the mini-FAT is not what these tests are about.
 */

/** top, left, right, bottom, in master units (576 per inch). */
export type LegacyRect = [number, number, number, number];

export type LegacyShape = {
  /** OfficeArt shape type: 75 is a picture frame, 1 a rectangle. */
  type?: number;
  rect: LegacyRect | null;
  /** 1-based index into `LegacyDeck.pictures`, for a picture frame. */
  pib?: number;
  /** Simple properties, opid → value, over the defaults (a picture says
   *  «no line, no fill», as every picture of the real hymnal does). */
  props?: Record<number, number>;
  /** A sound or movie object, and whether it hides while not playing. */
  media?: { hideWhileNotPlaying: boolean };
  text?: string;
  /** Raw records inside the shape's client textbox (a text with its runs). */
  textRecords?: Buffer[];
  /** Raw records inside the shape's client data (a placeholder atom). */
  clientData?: Buffer[];
  /** OfficeArtFSP flags on top of fHaveAnchor | fHaveSpt. */
  flags?: number;
};

export type LegacySlide = {
  slideTimeMs?: number;
  /** `SlideShowSlideInfoAtom.fFlags`. */
  infoFlags?: number;
  effectType?: number;
  effectDirection?: number;
  /** 0 slow, 1 medium, 2 fast. */
  speed?: number;
  /** `SlideAtom.slideFlags` — fMasterObjects 0x1, fMasterScheme 0x2,
   *  fMasterBackground 0x4. */
  slideFlags?: number;
  shapes?: LegacyShape[];
  /** Raw records appended to the slide container (a colour scheme). */
  records?: Buffer[];
  /** Placeholder texts kept in the slide list after the slide's persist atom. */
  listTexts?: Buffer[];
  /** A slide container that is not one, for a damaged deck. */
  garbage?: boolean;
};

export type LegacyDeck = {
  width?: number;
  height?: number;
  slides?: LegacySlide[];
  pictures?: { type: "jpeg" | "png"; bytes: Buffer }[];
  /** The master's shapes, which a slide shape names through `hspMaster`. */
  masterShapes?: { spid: number; props: Record<number, number> }[];
  /** Paths recorded by the deck's external objects — a linked sound's file. */
  externalPaths?: string[];
  /** The master's shapes as whole shapes (types, anchors, text), drawn on slides. */
  masterDrawing?: LegacyShape[];
  /** Raw records appended to the master (text styles, colour scheme). */
  masterRecords?: Buffer[];
  /** Raw records in the document's environment (fonts, default text style). */
  environment?: Buffer[];
  /** Raw records appended to the document container (headers and footers). */
  documentRecords?: Buffer[];
};

const SECTOR = 512;
const MIN_STREAM_BYTES = 4096;
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;
const MASTER_SLIDE_ID = 0x80000000;

export function rec(recVer: number, recInstance: number, recType: number, body: Buffer | Buffer[]): Buffer {
  const content = Array.isArray(body) ? Buffer.concat(body) : body;
  const head = Buffer.alloc(8);
  head.writeUInt16LE((recInstance << 4) | recVer, 0);
  head.writeUInt16LE(recType, 2);
  head.writeUInt32LE(content.length, 4);
  return Buffer.concat([head, content]);
}

export function u32s(...values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => buf.writeUInt32LE(value >>> 0, i * 4));
  return buf;
}

export function fopt(props: Record<number, number>): Buffer {
  const entries = Object.entries(props);
  const body = Buffer.alloc(entries.length * 6);
  entries.forEach(([opid, value], i) => {
    body.writeUInt16LE(Number(opid), i * 6);
    body.writeUInt32LE(value >>> 0, i * 6 + 2);
  });
  return rec(0x3, entries.length, 0xf00b, body);
}

function spContainer(spid: number, type: number, flags: number, children: Buffer[]): Buffer {
  return rec(0xf, 0, 0xf004, [rec(0x2, type, 0xf00a, u32s(spid, flags)), ...children]);
}

function drawing(shapes: Buffer[]): Buffer {
  const patriarch = spContainer(0x400, 0, 0x0005, []);
  const dg = rec(0xf, 0, 0xf002, [rec(0x0, 0, 0xf008, u32s(shapes.length + 1, 0)), rec(0xf, 0, 0xf003, [patriarch, ...shapes])]);
  return rec(0xf, 0, 0x040c, dg);
}

function slideShape(shape: LegacyShape, spid: number): Buffer {
  const type = shape.type ?? 75;
  const props: Record<number, number> =
    type === 75
      ? { 0x0104: shape.pib ?? 1, 0x01bf: 0x00100000, 0x01ff: 0x00080000, ...shape.props }
      : { ...shape.props };
  const children = [fopt(props)];
  if (shape.rect) {
    const anchor = Buffer.alloc(8);
    shape.rect.forEach((value, i) => anchor.writeInt16LE(value, i * 2));
    children.push(rec(0x0, 0, 0xf010, anchor));
  }
  if (shape.media) {
    const animation = Buffer.alloc(28);
    animation.writeUInt16LE(0x0104 | (shape.media.hideWhileNotPlaying ? 0x1000 : 0), 4);
    children.push(
      rec(0xf, 0, 0xf011, [rec(0x0, 0, 0x0bc1, u32s(1)), rec(0xf, 0, 0x1014, rec(0x1, 0, 0x0ff1, animation))]),
    );
  }
  if (shape.text !== undefined) {
    children.push(rec(0xf, 0, 0xf00d, rec(0x0, 0, 0x0fa0, Buffer.from(shape.text, "utf16le"))));
  }
  if (shape.textRecords) children.push(rec(0xf, 0, 0xf00d, shape.textRecords));
  if (shape.clientData) children.push(rec(0xf, 0, 0xf011, shape.clientData));
  return spContainer(spid, type, 0x0a00 | (shape.flags ?? 0), children);
}

function slideContainer(slide: LegacySlide, index: number): Buffer {
  if (slide.garbage) return Buffer.from("not a slide container at all");
  const atom = Buffer.alloc(24);
  atom.writeUInt32LE(MASTER_SLIDE_ID, 12); // masterIdRef: the master's slideId
  atom.writeUInt16LE(slide.slideFlags ?? 0, 20);
  const info = Buffer.alloc(16);
  info.writeInt32LE(slide.slideTimeMs ?? 0, 0);
  info.writeUInt8(slide.effectDirection ?? 0, 8);
  info.writeUInt8(slide.effectType ?? 0, 9);
  info.writeUInt16LE(slide.infoFlags ?? 0x0001, 10);
  info.writeUInt8(slide.speed ?? 2, 12);
  const children = [rec(0x2, 0, 0x03ef, atom), rec(0x0, 0, 0x03f9, info)];
  if (slide.shapes) {
    children.push(drawing(slide.shapes.map((shape, i) => slideShape(shape, 0x800 * (index + 1) + i + 1))));
  }
  children.push(...(slide.records ?? []));
  return rec(0xf, 0, 0x03ee, children);
}

function slidePersistAtom(persistId: number, slideId: number): Buffer {
  const body = Buffer.alloc(20);
  body.writeUInt32LE(persistId, 0);
  body.writeUInt32LE(slideId, 12);
  return rec(0x0, 0, 0x03f3, body);
}

/** One OLE2 compound file holding these streams, in order. */
export function compoundFile(streams: { name: string; data: Buffer }[]): Buffer {
  const padded = streams.map(({ name, data }) => {
    const size = Math.max(MIN_STREAM_BYTES, Math.ceil(data.length / SECTOR) * SECTOR);
    const buf = Buffer.alloc(size);
    data.copy(buf);
    return { name, data: buf, size: data.length < MIN_STREAM_BYTES ? MIN_STREAM_BYTES : data.length };
  });
  const dataSectors = padded.reduce((sum, stream) => sum + stream.data.length / SECTOR, 0);
  let fatSectors = 1;
  while (fatSectors * (SECTOR / 4) < fatSectors + 1 + dataSectors) fatSectors += 1;

  const directorySector = fatSectors;
  const fat = Buffer.alloc(fatSectors * SECTOR);
  for (let i = 0; i < fat.length / 4; i++) fat.writeUInt32LE(FREESECT, i * 4);
  for (let i = 0; i < fatSectors; i++) fat.writeUInt32LE(FATSECT, i * 4);
  fat.writeUInt32LE(ENDOFCHAIN, directorySector * 4);

  const directory = Buffer.alloc(SECTOR);
  const writeEntry = (index: number, name: string, type: number, right: number, child: number, start: number, size: number): void => {
    const offset = index * 128;
    const encoded = Buffer.from(`${name}\0`, "utf16le");
    encoded.copy(directory, offset);
    directory.writeUInt16LE(encoded.length, offset + 64);
    directory.writeUInt8(type, offset + 66);
    directory.writeUInt8(1, offset + 67); // colour: black
    directory.writeUInt32LE(NOSTREAM, offset + 68);
    directory.writeUInt32LE(right, offset + 72);
    directory.writeUInt32LE(child, offset + 76);
    directory.writeUInt32LE(start, offset + 116);
    directory.writeUInt32LE(size, offset + 120);
  };
  writeEntry(0, "Root Entry", 5, NOSTREAM, 1, ENDOFCHAIN, 0);

  let next = directorySector + 1;
  const body: Buffer[] = [fat, directory];
  padded.forEach((stream, i) => {
    const count = stream.data.length / SECTOR;
    for (let s = 0; s < count; s++) fat.writeUInt32LE(s === count - 1 ? ENDOFCHAIN : next + s + 1, (next + s) * 4);
    writeEntry(i + 1, stream.name, 2, i + 2 <= padded.length ? i + 2 : NOSTREAM, NOSTREAM, next, stream.size);
    body.push(stream.data);
    next += count;
  });

  const head = Buffer.alloc(SECTOR);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(head, 0);
  head.writeUInt16LE(0x003e, 24); // minor version
  head.writeUInt16LE(0x0003, 26); // major version
  head.writeUInt16LE(0xfffe, 28); // byte order
  head.writeUInt16LE(9, 30); // sector shift -> 512
  head.writeUInt16LE(6, 32); // mini sector shift -> 64
  head.writeUInt32LE(fatSectors, 44);
  head.writeUInt32LE(directorySector, 48);
  head.writeUInt32LE(MIN_STREAM_BYTES, 56); // mini stream cutoff
  head.writeUInt32LE(ENDOFCHAIN, 60); // mini FAT start
  head.writeUInt32LE(ENDOFCHAIN, 68); // DIFAT start
  for (let i = 0; i < 109; i++) head.writeUInt32LE(i < fatSectors ? i : FREESECT, 76 + i * 4);
  return Buffer.concat([head, ...body]);
}

export function buildLegacyPpt(deck: LegacyDeck = {}): Buffer {
  const slides = deck.slides ?? [
    // 0x0400 = fAutoAdvance, 0x0001 = fManualAdvance. Not consecutive bits.
    { slideTimeMs: 12_345, infoFlags: 0x0400 },
    { slideTimeMs: 999, infoFlags: 0x0001 },
  ];
  const pictures = deck.pictures ?? [];

  // The Pictures stream, and the BLIP store entries pointing into it.
  const blips: Buffer[] = [];
  const fbses: Buffer[] = [];
  let picturesOffset = 0;
  for (const picture of pictures) {
    const jpeg = picture.type === "jpeg";
    const blip = rec(0x0, jpeg ? 0x46a : 0x6e0, jpeg ? 0xf01d : 0xf01e, [Buffer.alloc(17), picture.bytes]);
    const fbse = Buffer.alloc(36);
    fbse.writeUInt8(jpeg ? 5 : 6, 0); // btWin32
    fbse.writeUInt8(jpeg ? 5 : 6, 1); // btMacOS
    fbse.writeUInt32LE(blip.length, 20); // size
    fbse.writeUInt32LE(1, 24); // cRef
    fbse.writeUInt32LE(picturesOffset, 28); // foDelay
    fbses.push(rec(0x2, jpeg ? 5 : 6, 0xf007, fbse));
    blips.push(blip);
    picturesOffset += blip.length;
  }

  const documentAtom = Buffer.alloc(40);
  documentAtom.writeInt32LE(deck.width ?? 5760, 0);
  documentAtom.writeInt32LE(deck.height ?? 4320, 4);
  const masterPersistId = 2;
  const slidePersistId = (index: number): number => 3 + index;

  const documentChildren = [rec(0x1, 0, 0x03e9, documentAtom)];
  if (deck.environment) documentChildren.push(rec(0xf, 0, 0x03f2, deck.environment));
  documentChildren.push(...(deck.documentRecords ?? []));
  if (deck.externalPaths?.length) {
    documentChildren.push(
      rec(0xf, 0, 0x0409, [
        rec(0x0, 0, 0x040a, u32s(deck.externalPaths.length)),
        ...deck.externalPaths.map((target) =>
          rec(0xf, 0, 0x100d, [rec(0x0, 0, 0x1004, Buffer.alloc(8)), rec(0x0, 0, 0x0fba, Buffer.from(target, "utf16le"))]),
        ),
      ]),
    );
  }
  if (fbses.length > 0) {
    documentChildren.push(rec(0xf, 0, 0x040b, rec(0xf, 0, 0xf000, rec(0xf, fbses.length, 0xf001, fbses))));
  }
  documentChildren.push(rec(0xf, 1, 0x0ff0, slidePersistAtom(masterPersistId, MASTER_SLIDE_ID)));
  documentChildren.push(rec(0xf, 0, 0x0ff0, slides.flatMap((s, i) => [slidePersistAtom(slidePersistId(i), 256 + i), ...(s.listTexts ?? [])])));
  const documentContainer = rec(0xf, 0, 0x03e8, documentChildren);

  const masterShapes = [
    ...(deck.masterShapes ?? []).map(({ spid, props }) => spContainer(spid, 1, 0x0a00, [fopt(props)])),
    ...(deck.masterDrawing ?? []).map((shape, i) => slideShape(shape, 0x500 + i)),
  ];
  const master = rec(0xf, 0, 0x03f8, [drawing(masterShapes), ...(deck.masterRecords ?? [])]);
  const slideContainers = slides.map(slideContainer);

  const offsets: number[] = [];
  let offset = 0;
  for (const part of [documentContainer, master, ...slideContainers]) {
    offsets.push(offset);
    offset += part.length;
  }
  const persistOffset = offset;
  // One run of ids starting at 1: document, master, then the slides.
  const persistDirectory = rec(0x0, 0, 0x1772, u32s(1 | (offsets.length << 20), ...offsets));

  const editOffset = persistOffset + persistDirectory.length;
  const editBody = Buffer.alloc(28);
  editBody.writeUInt32LE(256 + slides.length - 1, 0); // lastSlideIdRef
  editBody.writeUInt32LE(0, 8); // offsetLastEdit — no earlier edit
  editBody.writeUInt32LE(persistOffset, 12);
  editBody.writeUInt32LE(1, 16); // docPersistIdRef
  editBody.writeUInt32LE(offsets.length + 1, 20); // persistIdSeed
  const userEdit = rec(0x0, 0, 0x0ff5, editBody);

  // A whole PowerPoint 97 `CurrentUserAtom` with an empty user name: what the
  // sniff for an old or encrypted deck tells apart (`sniffUnreadableDeck`).
  const currentUser = Buffer.alloc(32);
  rec(0x0, 0, 0x0ff6, Buffer.alloc(24)).copy(currentUser, 0, 0, 8); // CurrentUserAtom header
  currentUser.writeUInt32LE(0x14, 8); // size
  currentUser.writeUInt32LE(0xe391c05f, 12); // headerToken (unencrypted)
  currentUser.writeUInt32LE(editOffset, 16); // offsetToCurrentEdit
  currentUser.writeUInt16LE(0x03f4, 22); // docFileVersion
  currentUser.writeUInt8(3, 24); // majorVersion
  currentUser.writeUInt32LE(8, 28); // relVersion

  return compoundFile([
    { name: "PowerPoint Document", data: Buffer.concat([documentContainer, master, ...slideContainers, persistDirectory, userEdit]) },
    { name: "Current User", data: currentUser },
    ...(blips.length > 0 ? [{ name: "Pictures", data: Buffer.concat(blips) }] : []),
  ]);
}

/** The first bytes of a JPEG of this size: SOI and a baseline SOF — all the
 *  readers look at. Not decodable, and nothing here decodes it. */
export function jpegHeader(width: number, height: number, filler = 64): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(9 + filler, 0x11), Buffer.from([0xff, 0xd9])]);
}

/** The first bytes of an RGBA PNG of this size: signature and IHDR. */
export function pngHeader(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16); // bit depth
  ihdr.writeUInt8(6, 17); // colour type: RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}
