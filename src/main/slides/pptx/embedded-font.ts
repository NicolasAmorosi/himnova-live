/**
 * Turns a font a `.pptx` embeds (`ppt/fonts/*.fntdata`) back into the plain TrueType file that
 * Chromium's `FontFace` takes.
 *
 * PowerPoint never stores the font as is. It stores an Embedded OpenType (EOT) wrapper around it —
 * and almost always (277 of the 284 fonts of the corpus) a MicroType Express (MTX) compressed one:
 * the format Internet Explorer used for web fonts, which no browser engine reads any more. So the
 * bytes go through the two W3C member submissions this file implements:
 *
 * - EOT (https://www.w3.org/Submission/EOT/): a little-endian header, then the font data,
 *   optionally MTX-compressed and/or XOR-ed with 0x50 (XOR applied last, so undone first).
 * - MTX (https://www.w3.org/Submission/MTX/): three LZCOMP-compressed blocks — the font's tables in
 *   Compact Table Format (CTF), every glyph's initial PUSH values, and the rest of their
 *   instructions. CTF re-encodes `glyf`, drops `loca` and delta-codes `cvt `; the rest is verbatim.
 *
 * Decoded from the specs; libeot (MPL-2.0) was only read to settle what they leave open, and each of
 * those points says so where it is decided.
 *
 * Never throws: a font this cannot read must cost that font, not the slide. Every read goes through
 * `DataView` or an explicit end-of-data check, so a truncated or hostile file fails at the first
 * byte it does not have and lands in the single `catch` of `decodeEmbeddedFont`.
 */

const SFNT_TRUETYPE = 0x00010000;
const SFNT_APPLE = 0x74727565; // 'true'
const SFNT_CFF = 0x4f54544f; // 'OTTO'

const EOT_MAGIC = 0x504c;
/** Every EOT version starts with the same 82 bytes, up to `Padding1`. Anything shorter is not one. */
const EOT_FIXED_HEADER = 82;
const TTEMBED_TTCOMPRESSED = 0x00000004;
const TTEMBED_XORENCRYPTDATA = 0x10000000;
const XOR_KEY = 0x50;

/** Plain TrueType/OpenType bytes for an embedded font, or `null` when it cannot be read. */
export function decodeEmbeddedFont(bytes: Uint8Array): Uint8Array | null {
  try {
    if (isSfnt(bytes)) return bytes;
    const font = unwrapEot(bytes);
    return font && isSfnt(font) ? font : null;
  } catch {
    return null;
  }
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function isSfnt(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const flavor = view(bytes).getUint32(0);
  return flavor === SFNT_TRUETYPE || flavor === SFNT_APPLE || flavor === SFNT_CFF;
}

function unwrapEot(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < EOT_FIXED_HEADER) return null;
  const header = view(bytes);
  const eotSize = header.getUint32(0, true);
  const fontDataSize = header.getUint32(4, true);
  const flags = header.getUint32(12, true);
  if (header.getUint16(34, true) !== EOT_MAGIC) return null;
  if (eotSize > bytes.length || fontDataSize > eotSize - EOT_FIXED_HEADER) return null;
  // `FontData` is the LAST field of every version (2.1 and 2.2 only add fields before it) and
  // `EOTSize` is the whole structure, so the tail locates it without walking the name strings —
  // whose layout differs per version, and libeot keeps a fallback for files whose `Version` lies.
  let data = bytes.slice(eotSize - fontDataSize, eotSize);
  if ((flags & TTEMBED_XORENCRYPTDATA) !== 0) data = data.map((b) => b ^ XOR_KEY);
  return (flags & TTEMBED_TTCOMPRESSED) !== 0 ? decodeMtx(data) : data;
}

// -- MTX --------------------------------------------------------------------------------------------

/** MTX §2: a version byte, then three 24-bit big-endian fields — the copy limit and the offsets of
 *  blocks 2 and 3. Block 1 starts right after them. */
const MTX_HEADER = 10;

function decodeMtx(data: Uint8Array): Uint8Array {
  if (data.length < MTX_HEADER) throw new RangeError("MTX: truncated header");
  const offset2 = u24(data, 4);
  const offset3 = u24(data, 7);
  if (offset2 < MTX_HEADER || offset3 < offset2 || offset3 > data.length) {
    throw new RangeError("MTX: block offsets out of order");
  }
  // The copy limit (bytes 1–3) only bounds how far back the encoder searched, which lets a decoder
  // keep a ring buffer that small. Decoding into one flat buffer yields the same bytes, so it is
  // not read.
  return ctfToSfnt(
    unpackLzcomp(data.subarray(MTX_HEADER, offset2)),
    unpackLzcomp(data.subarray(offset2, offset3)),
    unpackLzcomp(data.subarray(offset3)),
  );
}

function u24(bytes: Uint8Array, at: number): number {
  const v = view(bytes);
  return (v.getUint8(at) << 16) | (v.getUint8(at + 1) << 8) | v.getUint8(at + 2);
}

// -- LZCOMP (MTX §3 and Appendix C) ------------------------------------------------------------------

/** Bits are consumed most significant first (`MTX_BITIO_input_bit`). */
class BitReader {
  private at = 0;
  private byte = 0;
  private remaining = 0;

  constructor(private readonly bytes: Uint8Array) {}

  bit(): number {
    if (this.remaining === 0) {
      const next = this.bytes[this.at];
      if (next === undefined) throw new RangeError("LZCOMP: data ends mid-symbol");
      this.at += 1;
      this.byte = next;
      this.remaining = 8;
    }
    this.remaining -= 1;
    return (this.byte >> this.remaining) & 1;
  }

  read(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i += 1) value = value * 2 + this.bit();
    return value;
  }
}

const ROOT = 1;

/**
 * LZCOMP's adaptive Huffman coder (`AHUFF`). The tree is never transmitted: the decoder has to
 * evolve it exactly as the encoder did, symbol after symbol, so this mirrors the reference
 * bit for bit — nodes `1 .. 2·range-1` kept in sibling order (heaviest first), leaves starting at
 * `range`, and after every symbol each node on its path to the root swapped with the FIRST node of
 * equal weight before its weight is bumped. Any other tie-break decodes garbage.
 */
class AdaptiveHuffman {
  private readonly up: Int32Array;
  private readonly left: Int32Array;
  private readonly right: Int32Array;
  /** The symbol at a leaf, -1 at an internal node. */
  private readonly symbol: Int32Array;
  private readonly weight: Int32Array;
  /** Where each symbol's leaf sits right now. */
  private readonly leafOf: Int32Array;

  constructor(
    private readonly bits: BitReader,
    range: number,
  ) {
    const nodes = 2 * range;
    this.up = new Int32Array(nodes);
    this.left = new Int32Array(nodes);
    this.right = new Int32Array(nodes);
    this.symbol = new Int32Array(nodes).fill(-1);
    this.weight = new Int32Array(nodes);
    this.leafOf = new Int32Array(range);
    for (let i = 2; i < nodes; i += 1) {
      this.up[i] = i >> 1;
      this.weight[i] = 1;
    }
    for (let i = ROOT; i < range; i += 1) {
      this.left[i] = 2 * i;
      this.right[i] = 2 * i + 1;
    }
    for (let s = 0; s < range; s += 1) {
      this.symbol[range + s] = s;
      this.leafOf[s] = range + s;
    }
    // Children always sit after their parent, so one backwards pass sums every subtree.
    for (let i = range - 1; i >= ROOT; i -= 1) this.weight[i] = this.weight[2 * i]! + this.weight[2 * i + 1]!;

    // The reference's starting bias (`MTX_AHUFF_Create`). The symbol coder (257–511 symbols) favours
    // the first two copy commands and DUP2/DUP4; the 8-symbol length and distance coders start with
    // every symbol seen twice.
    if (range > 256 && range < 512) {
      this.bump(256);
      this.bump(257);
      for (let i = 0; i < 12; i += 1) this.bump(range - 3);
      for (let i = 0; i < 6; i += 1) this.bump(range - 2);
    } else {
      for (let pass = 0; pass < 2; pass += 1) for (let s = 0; s < range; s += 1) this.bump(s);
    }
  }

  read(): number {
    let node = ROOT;
    do node = this.bits.bit() === 1 ? this.right[node]! : this.left[node]!;
    while (this.symbol[node]! < 0);
    // Read before `update`: it may swap this leaf to another slot.
    const symbol = this.symbol[node]!;
    this.update(node);
    return symbol;
  }

  private bump(symbol: number): void {
    this.update(this.leafOf[symbol]!);
  }

  private update(leaf: number): void {
    const weight = this.weight;
    let node = leaf;
    while (node !== ROOT) {
      const w = weight[node]!;
      if (weight[node - 1] === w) {
        let first = node - 1;
        while (weight[first - 1] === w) first -= 1;
        if (first > ROOT) {
          this.swap(node, first);
          node = first;
        }
      }
      weight[node] = w + 1;
      node = this.up[node]!;
    }
    weight[ROOT] = weight[ROOT]! + 1;
  }

  /** Swaps two subtrees' contents; each slot keeps its own parent link. */
  private swap(a: number, b: number): void {
    const { left, right, symbol, weight } = this;
    for (const field of [left, right, symbol, weight]) {
      const t = field[a]!;
      field[a] = field[b]!;
      field[b] = t;
    }
    for (const node of [a, b]) {
      const s = symbol[node]!;
      if (s >= 0) {
        this.leafOf[s] = node;
      } else {
        this.up[left[node]!] = node;
        this.up[right[node]!] = node;
      }
    }
  }
}

/** LZCOMP's history starts pre-filled (`InitializeModel`) so that even a block's first bytes can be
 *  copy items: every pair `(k, j)` for `k < 32`, `j < 96`, then every byte value four times. */
const PRELOAD = buildPreload();

function buildPreload(): Uint8Array {
  const bytes = new Uint8Array(2 * 32 * 96 + 4 * 256);
  let i = 0;
  for (let k = 0; k < 32; k += 1) {
    for (let j = 0; j < 96; j += 1) {
      bytes[i++] = k;
      bytes[i++] = j;
    }
  }
  for (let value = 0; value < 256; value += 1) {
    bytes.fill(value, i, i + 4);
    i += 4;
  }
  return bytes;
}

/** Past this distance a 2-byte match is not worth a copy item, so lengths there start at 3. */
const MAX_2_BYTE_DISTANCE = 512;
/** A font past this is not a font: 32 MB, where a real one is a few hundred KB. */
const MAX_FONT_BYTES = 32 * 1024 * 1024;

function unpackLzcomp(block: Uint8Array): Uint8Array {
  const bits = new BitReader(block);
  // Only LZCOMP "version 1" (1996, before MTX 1.0) lacks this bit.
  const runLengthCoded = bits.bit() === 1;
  const distances = new AdaptiveHuffman(bits, 8);
  const lengths = new AdaptiveHuffman(bits, 8);
  const size = bits.read(24);
  // `SetDistRange`: as many 3-bit distance digits as it takes to reach back over the whole output.
  let distanceRanges = 1;
  while (8 ** distanceRanges < size) distanceRanges += 1;
  const dup2 = 256 + 8 * distanceRanges;
  const symbols = new AdaptiveHuffman(bits, dup2 + 3);

  const out = new Uint8Array(PRELOAD.length + size);
  out.set(PRELOAD);
  let pos = PRELOAD.length;
  while (pos < out.length) {
    const symbol = symbols.read();
    if (symbol < 256) {
      out[pos++] = symbol;
    } else if (symbol >= dup2) {
      // DUP2 / DUP4 / DUP6: one byte copied from 2, 4 or 6 back.
      out[pos] = out[pos - 2 * (symbol - dup2 + 1)]!;
      pos += 1;
    } else {
      // A copy item. The symbol carries how many 3-bit distance digits follow and the first 2 bits
      // of the length; its third bit says whether another 3-bit length symbol follows. §3.3's prose
      // calls that bit a stop bit SET on the last symbol; the reference `DecodeLength` stops when it
      // is CLEAR — and that is what the encoder writes.
      let digits = symbol - 256;
      const distanceDigits = (digits >> 3) + 1;
      let length = 0;
      for (;;) {
        length = length * 4 + (digits & 3);
        if ((digits & 4) === 0) break;
        digits = lengths.read();
      }
      length += 2;
      let distance = 0;
      for (let i = 0; i < distanceDigits; i += 1) distance = distance * 8 + distances.read();
      distance += 1;
      if (distance >= MAX_2_BYTE_DISTANCE) length += 1;
      // The distance is to the END of the match, so the source never overlaps the destination.
      const from = pos - distance - length + 1;
      if (from < 0 || pos + length > out.length) throw new RangeError("LZCOMP: copy out of bounds");
      out.copyWithin(pos, from, from + length);
      pos += length;
    }
  }
  const data = out.subarray(PRELOAD.length);
  return runLengthCoded ? expandRuns(data) : data;
}

/** The run-length pass under LZCOMP (`MTX_RUNLENGTHCOMP_SaveBytes`): the first byte names an escape;
 *  `escape, 0` is the escape byte itself and `escape, n, b` is `n` copies of `b`.Exported for its test. */
export function expandRuns(data: Uint8Array): Uint8Array {
  const escape = data[0];
  if (escape === undefined) return data;
  const out = new ByteWriter();
  // Each 3-byte run can stand for 255 bytes: 16 MB of LZCOMP output could expand to 1.4 GB, byte by byte, in main
  // (2026-11-22 audit, SE1). A real font is a few hundred KB.
  for (let i = 1; i < data.length; i += 1) {
    const value = data[i]!;
    if (value !== escape) {
      out.u8(value);
      continue;
    }
    const count = data[++i];
    if (count === undefined) throw new RangeError("LZCOMP: run cut short");
    if (count === 0) {
      out.u8(escape);
      continue;
    }
    const repeated = data[++i];
    if (repeated === undefined) throw new RangeError("LZCOMP: run cut short");
    if (out.length + count > MAX_FONT_BYTES) throw new RangeError("LZCOMP: font past its size cap");
    for (let k = 0; k < count; k += 1) out.u8(repeated);
  }
  return out.result();
}

// -- CTF → sfnt (MTX §4–7) --------------------------------------------------------------------------

/** Sequential big-endian reads that throw past the end (`DataView` bounds-checks every access). */
class Reader {
  at = 0;
  private readonly data: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.data = view(bytes);
  }

  u8(): number {
    return this.data.getUint8(this.at++);
  }

  peek(): number {
    return this.data.getUint8(this.at);
  }

  u16(): number {
    const v = this.data.getUint16(this.at);
    this.at += 2;
    return v;
  }

  s16(): number {
    const v = this.data.getInt16(this.at);
    this.at += 2;
    return v;
  }

  take(length: number): Uint8Array {
    if (this.at + length > this.bytes.length) throw new RangeError("CTF: data ends early");
    const out = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return out;
  }

  /** `255USHORT` (§6.1.1). */
  u255(): number {
    const code = this.u8();
    if (code === 253) return this.u16();
    if (code === 255) return 253 + this.u8();
    if (code === 254) return 506 + this.u8();
    return code;
  }

  /** `255SHORT` (§6.1.2). */
  s255(): number {
    let code = this.u8();
    if (code === 253) return this.s16();
    const sign = code === 250 ? -1 : 1;
    if (code === 250) code = this.u8();
    if (code === 255) return sign * (250 + this.u8());
    if (code === 254) return sign * (500 + this.u8());
    return sign * code;
  }
}

class ByteWriter {
  private buffer = new Uint8Array(4096);
  length = 0;

  private reserve(count: number): void {
    if (this.length + count <= this.buffer.length) return;
    const grown = new Uint8Array(Math.max(this.buffer.length * 2, this.length + count));
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }

  /** Stores the low byte: a negative value wraps the way a C `uint8_t` cast would. */
  u8(value: number): void {
    this.reserve(1);
    this.buffer[this.length++] = value;
  }

  u16(value: number): void {
    this.reserve(2);
    this.buffer[this.length++] = value >> 8;
    this.buffer[this.length++] = value;
  }

  bytes(source: Uint8Array | readonly number[]): void {
    this.reserve(source.length);
    this.buffer.set(source, this.length);
    this.length += source.length;
  }

  result(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

function ctfToSfnt(ctf: Uint8Array, pushes: Uint8Array, code: Uint8Array): Uint8Array {
  const directory = view(ctf);
  const flavor = directory.getUint32(0);
  const count = directory.getUint16(4);
  const tables = new Map<string, Uint8Array>();
  let glyf: Uint8Array | null = null;
  for (let i = 0; i < count; i += 1) {
    const record = 12 + 16 * i;
    const tag = String.fromCharCode(...ctf.subarray(record, record + 4));
    const offset = directory.getUint32(record + 8);
    const length = directory.getUint32(record + 12);
    if (offset + length > ctf.length) throw new RangeError(`CTF: '${tag}' out of bounds`);
    const data = ctf.slice(offset, offset + length);
    if (tag === "glyf") glyf = data;
    else if (tag === "cvt ") tables.set(tag, decodeCvt(data));
    else if (tag === "cmap") tables.set(tag, repairCmap(data));
    // `loca` is rebuilt from `glyf`. `hdmx` and `VDMX` are dropped, as libeot does: both are caches
    // of hinted metrics a rasterizer can recompute, CTF stores them as predictions whose rounding
    // §5.4 leaves open, and a cache with a wrong value is worse than none.
    else if (tag !== "loca" && tag !== "hdmx" && tag !== "VDMX") tables.set(tag, data);
  }

  const head = tables.get("head");
  const maxp = tables.get("maxp");
  if (!head || head.length < 54 || !maxp || maxp.length < 6) throw new RangeError("CTF: no head/maxp");
  view(head).setUint32(8, 0); // checkSumAdjustment: `head`'s own checksum is taken with it zeroed
  if (glyf) {
    const glyphs = decodeGlyphs(glyf, pushes, code, view(maxp).getUint16(4));
    const longLoca = view(head).getInt16(50) === 1 || glyphs.glyf.length > 2 * 0xffff;
    const loca = new ByteWriter();
    for (const offset of glyphs.offsets) {
      if (longLoca) {
        loca.u16(offset >>> 16);
        loca.u16(offset);
      } else {
        loca.u16(offset / 2);
      }
    }
    tables.set("glyf", glyphs.glyf);
    tables.set("loca", loca.result());
    view(head).setInt16(50, longLoca ? 1 : 0);
    // The PUSH instructions are regenerated, not restored, so a glyph's program can come out a few
    // bytes longer than the original's — and OTS checks it against `maxSizeOfInstructions`.
    if (view(maxp).getUint32(0) === 0x00010000 && maxp.length >= 28) {
      view(maxp).setUint16(26, Math.max(view(maxp).getUint16(26), glyphs.maxInstructions));
    }
  }
  return writeSfnt(flavor, tables);
}

/** §5.2: a count, then each value as a delta from the previous one (mod 2^16) in 1–3 bytes. */
function decodeCvt(table: Uint8Array): Uint8Array {
  const r = new Reader(table);
  const count = r.u16();
  const out = new ByteWriter();
  let value = 0;
  for (let i = 0; i < count; i += 1) {
    const code = r.u8();
    let delta: number;
    if (code >= 248) delta = 238 * (code - 247) + r.u8();
    else if (code >= 239) delta = -(238 * (code - 239) + r.u8());
    else if (code === 238) delta = r.s16();
    else delta = code;
    value = ((value + delta) << 16) >> 16;
    out.u16(value);
  }
  return out.result();
}

/**
 * Mends the two `cmap` defects that made Chromium's sanitizer (OTS) reject 10 of the corpus's 277
 * MTX fonts outright — both already in the bytes PowerPoint stored, not introduced here: a format
 * 12/13 subtable whose `language` holds garbage (9 fonts; it must be 0, and OTS checks), and a
 * format 4 closing segment `U+FFFF..U+FFFF` whose idDelta sends that noncharacter past the last
 * glyph instead of to .notdef (1 font). Neither field takes part in looking up a real character.
 */
function repairCmap(cmap: Uint8Array): Uint8Array {
  const v = view(cmap);
  const count = v.getUint16(2);
  for (let i = 0; i < count; i += 1) {
    const at = v.getUint32(4 + 8 * i + 4);
    const format = v.getUint16(at);
    if (format === 12 || format === 13) v.setUint32(at + 8, 0);
    if (format !== 4) continue;
    // endCode[n] at 14, a pad, startCode[n], idDelta[n], idRangeOffset[n]
    const segments = v.getUint16(at + 6) / 2;
    const last = 2 * (segments - 1);
    const closing =
      v.getUint16(at + 14 + last) === 0xffff &&
      v.getUint16(at + 16 + 2 * segments + last) === 0xffff &&
      v.getUint16(at + 16 + 6 * segments + last) === 0;
    if (closing) v.setUint16(at + 16 + 4 * segments + last, 1);
  }
  return cmap;
}

type Streams = { glyf: Reader; push: Reader; code: Reader };

function decodeGlyphs(
  glyf: Uint8Array,
  pushes: Uint8Array,
  code: Uint8Array,
  numGlyphs: number,
): { glyf: Uint8Array; offsets: number[]; maxInstructions: number } {
  const streams: Streams = { glyf: new Reader(glyf), push: new Reader(pushes), code: new Reader(code) };
  const out = new ByteWriter();
  const offsets = [0];
  let maxInstructions = 0;
  for (let g = 0; g < numGlyphs; g += 1) {
    maxInstructions = Math.max(maxInstructions, decodeGlyph(streams, out));
    // Even offsets: all a short `loca` (offset / 2) can address.
    if (out.length % 2 !== 0) out.u8(0);
    offsets.push(out.length);
  }
  return { glyf: out.result(), offsets, maxInstructions };
}

/** Writes one TrueType glyph and returns its instruction count. CTF glyphs are stored back to back
 *  in glyph order, each one's length implied by its own data (§5.1). */
function decodeGlyph(s: Streams, out: ByteWriter): number {
  let contours = s.glyf.s16();
  if (contours < 0) return decodeCompositeGlyph(s, out);
  let box: number[] | null = null;
  // §5.7.1: a bounding box the points do not give is stored, flagged by 0x7FFF in place of the
  // contour count. PowerPoint's encoder does not seem to bother: PatrickHand 1.003 came back with all
  // 515 outlines identical to the OFL original but 167 boxes recomputed from the points. The
  // outline is what gets drawn; only the box is lost.
  if (contours === 0x7fff) {
    contours = s.glyf.s16();
    box = [s.glyf.s16(), s.glyf.s16(), s.glyf.s16(), s.glyf.s16()];
    if (contours < 0) throw new RangeError("CTF: bad contour count");
  }
  // An empty glyph (a space) is just its zero count: no points, no instructions — and in TrueType
  // no bytes at all, `loca` giving it zero length (libeot reads it the same way).
  if (contours === 0) return 0;

  // The first value is the first contour's END POINT; each following one, a contour's point count.
  const endPoints: number[] = [];
  let points = 0;
  for (let c = 0; c < contours; c += 1) {
    points += s.glyf.u255() + (c === 0 ? 1 : 0);
    endPoints.push(points - 1);
  }
  if (points > 0xffff) throw new RangeError("CTF: too many points");
  const flags = s.glyf.take(points);
  const dxs = new Int16Array(points);
  const dys = new Int16Array(points);
  let x = 0;
  let y = 0;
  let xMin = 0x7fff;
  let yMin = 0x7fff;
  let xMax = -0x8000;
  let yMax = -0x8000;
  for (let i = 0; i < points; i += 1) {
    const [dx, dy] = readTriplet(flags[i]! & 0x7f, s.glyf);
    dxs[i] = dx;
    dys[i] = dy;
    x = ((x + dx) << 16) >> 16;
    y = ((y + dy) << 16) >> 16;
    xMin = Math.min(xMin, x);
    yMin = Math.min(yMin, y);
    xMax = Math.max(xMax, x);
    yMax = Math.max(yMax, y);
  }
  // In CTF the instruction counts come after the outline; in TrueType, before it.
  const instructions = readInstructions(s);

  out.u16(contours);
  for (const v of box ?? [xMin, yMin, xMax, yMax]) out.u16(v);
  for (const end of endPoints) out.u16(end);
  out.u16(instructions.length);
  out.bytes(instructions);
  for (let i = 0; i < points; i += 1) {
    // CTF's flag has the off-curve bit on top (§5.9); TrueType's has on-curve at the bottom.
    const onCurve = (flags[i]! & 0x80) === 0 ? 0x01 : 0;
    out.u8(onCurve | axisFlag(dxs[i]!, 0x02, 0x10) | axisFlag(dys[i]!, 0x04, 0x20));
  }
  for (const d of dxs) writeDelta(out, d);
  for (const d of dys) writeDelta(out, d);
  return instructions.length;
}

/** TrueType's per-axis flag bits: `same` alone is a zero delta; `short` is one byte, with `same`
 *  then meaning positive; neither is a signed 16-bit delta. */
function axisFlag(delta: number, short: number, same: number): number {
  if (delta === 0) return same;
  if (delta > -256 && delta < 256) return delta > 0 ? short | same : short;
  return 0;
}

function writeDelta(out: ByteWriter, delta: number): void {
  if (delta === 0) return;
  if (delta > -256 && delta < 256) out.u8(Math.abs(delta));
  else out.u16(delta);
}

/**
 * One point's `(dx, dy)` in the triplet encoding (§5.11, which WOFF2 later adopted as is): the low
 * 7 bits of its flag say how many bytes follow, how their bits split between dx and dy, a base to
 * add to each and both signs (bit 0 for x — or for the only axis — and bit 1 for y).
 */
function readTriplet(flag: number, r: Reader): [number, number] {
  const signed = (bit: number, magnitude: number): number => ((flag & bit) !== 0 ? magnitude : -magnitude);
  if (flag < 10) return [0, signed(1, ((flag & 14) << 7) + r.u8())];
  if (flag < 20) return [signed(1, (((flag - 10) & 14) << 7) + r.u8()), 0];
  if (flag < 84) {
    const b0 = flag - 20;
    const b1 = r.u8();
    return [signed(1, 1 + (b0 & 0x30) + (b1 >> 4)), signed(2, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f))];
  }
  if (flag < 120) {
    const b0 = flag - 84;
    const bx = r.u8();
    const by = r.u8();
    return [signed(1, 1 + Math.floor(b0 / 12) * 256 + bx), signed(2, 1 + ((b0 % 12) >> 2) * 256 + by)];
  }
  if (flag < 124) {
    const b1 = r.u8();
    const b2 = r.u8();
    const b3 = r.u8();
    return [signed(1, (b1 << 4) | (b2 >> 4)), signed(2, ((b2 & 0x0f) << 8) | b3)];
  }
  const bx = r.u16();
  const by = r.u16();
  return [signed(1, bx), signed(2, by)];
}

const ARG_1_AND_2_ARE_WORDS = 0x0001;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;
const WE_HAVE_INSTRUCTIONS = 0x0100;

/** §5.10: a composite is stored as in TrueType (its box always present), except its instructions,
 *  which are split like a simple glyph's. */
function decodeCompositeGlyph(s: Streams, out: ByteWriter): number {
  out.u16(-1);
  out.bytes(s.glyf.take(8));
  let flags: number;
  do {
    flags = s.glyf.u16();
    const args = (flags & ARG_1_AND_2_ARE_WORDS) !== 0 ? 4 : 2;
    const transform =
      (flags & WE_HAVE_A_TWO_BY_TWO) !== 0
        ? 8
        : (flags & WE_HAVE_AN_X_AND_Y_SCALE) !== 0
          ? 4
          : (flags & WE_HAVE_A_SCALE) !== 0
            ? 2
            : 0;
    out.u16(flags);
    out.bytes(s.glyf.take(2 + args + transform)); // glyph index, arguments, transform
  } while ((flags & MORE_COMPONENTS) !== 0);
  // The last component's flags decide, as the §5.10 table reads.
  if ((flags & WE_HAVE_INSTRUCTIONS) === 0) return 0;
  const instructions = readInstructions(s);
  out.u16(instructions.length);
  out.bytes(instructions);
  return instructions.length;
}

/** A glyph's program: its initial PUSH values (block 2), re-emitted as PUSH instructions, then the
 *  rest of its code (block 3) as is (§6.2.5, §7). */
function readInstructions(s: Streams): Uint8Array {
  const pushes = pushInstructions(readPushValues(s.push, s.glyf.u255()));
  const code = s.code.take(s.glyf.u255());
  if (pushes.length + code.length > 0xffff) throw new RangeError("CTF: glyph program too long");
  const out = new Uint8Array(pushes.length + code.length);
  out.set(pushes);
  out.set(code, pushes.length);
  return out;
}

const HOP_3 = 0xfb;
const HOP_4 = 0xfc;

/** §6.2.2–6.2.4: `255SHORT` values, where the hop codes expand `A, x1, A, x2, A` patterns. */
function readPushValues(r: Reader, count: number): number[] {
  const values: number[] = [];
  while (values.length < count) {
    const code = r.peek();
    if (code !== HOP_3 && code !== HOP_4) {
      values.push(r.s255());
      continue;
    }
    r.u8();
    const a = values[values.length - 2];
    if (a === undefined) throw new RangeError("CTF: hop code with nothing to repeat");
    values.push(a, r.s255(), a);
    if (code === HOP_4) values.push(r.s255(), a);
  }
  if (values.length !== count) throw new RangeError("CTF: hop code overruns the push count");
  return values;
}

const NPUSHB = 0x40;
const NPUSHW = 0x41;
const PUSHB_1 = 0xb0;
const PUSHW_1 = 0xb8;

/** §6.2.1 leaves the opcodes to the decoder ("generate new TrueType instructions"): runs of byte-sized
 *  values go out as PUSHB and the rest as PUSHW, the short forms up to 8 values and NPUSH* up to 255. */
function pushInstructions(values: readonly number[]): number[] {
  const out: number[] = [];
  const isByte = (v: number): boolean => v >= 0 && v < 256;
  for (let i = 0; i < values.length; ) {
    const bytes = isByte(values[i]!);
    let run = 1;
    while (run < 255 && i + run < values.length && isByte(values[i + run]!) === bytes) run += 1;
    if (run <= 8) out.push((bytes ? PUSHB_1 : PUSHW_1) + run - 1);
    else out.push(bytes ? NPUSHB : NPUSHW, run);
    for (const v of values.slice(i, i + run)) {
      if (bytes) out.push(v);
      else out.push((v >> 8) & 0xff, v & 0xff);
    }
    i += run;
  }
  return out;
}

// -- sfnt -------------------------------------------------------------------------------------------

/** Tables sorted by tag and 4-byte aligned, every checksum and `head.checkSumAdjustment` recomputed. */
function writeSfnt(flavor: number, tables: Map<string, Uint8Array>): Uint8Array {
  const entries = [...tables].sort(([a], [b]) => (a < b ? -1 : 1));
  const directorySize = 12 + 16 * entries.length;
  const font = new Uint8Array(entries.reduce((size, [, data]) => size + pad4(data.length), directorySize));
  const out = view(font);
  const log2 = Math.floor(Math.log2(entries.length));
  out.setUint32(0, flavor);
  out.setUint16(4, entries.length);
  out.setUint16(6, 16 << log2);
  out.setUint16(8, log2);
  out.setUint16(10, entries.length * 16 - (16 << log2));
  let at = directorySize;
  let headAt = -1;
  entries.forEach(([tag, data], i) => {
    const record = 12 + 16 * i;
    for (let k = 0; k < 4; k += 1) out.setUint8(record + k, tag.charCodeAt(k));
    font.set(data, at);
    out.setUint32(record + 4, checksum(font, at, data.length));
    out.setUint32(record + 8, at);
    out.setUint32(record + 12, data.length);
    if (tag === "head") headAt = at;
    at += pad4(data.length);
  });
  if (headAt >= 0) out.setUint32(headAt + 8, (0xb1b0afba - checksum(font, 0, font.length)) >>> 0);
  return font;
}

function pad4(length: number): number {
  return (length + 3) & ~3;
}

/** The sum of the big-endian 32-bit words, the last one zero-padded (the buffer is, past each table). */
function checksum(font: Uint8Array, at: number, length: number): number {
  const data = view(font);
  let sum = 0;
  for (let i = at; i < at + length; i += 4) sum = (sum + data.getUint32(i)) >>> 0;
  return sum;
}
