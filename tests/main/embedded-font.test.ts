/**
 * `decodeEmbeddedFont` — a `.pptx`'s `ppt/fonts/*.fntdata` (EOT, usually MTX-compressed) back to the
 * plain TrueType Chromium's `FontFace` takes.
 *
 * The uncompressed paths are checked against a real font (Carlito, shipped with the app), byte for
 * byte. The MTX path is checked against a tiny font built here in CTF form and compressed by a
 * literal-only LZCOMP encoder written out again from the spec — so it shares no code with the
 * decoder. Real MTX fonts are third-party and stay out of the repo: the corpus run
 * (`tools/release-checks/pptx-render/fonts-check.ts`, maintainer side) is what exercises copy items,
 * the run-length pass and Chromium's acceptance.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { decodeEmbeddedFont, expandRuns } from "../../src/main/slides/pptx/embedded-font";

const CARLITO = fs.readFileSync(path.resolve("src/renderer/src/assets/fonts/slides/Carlito-Regular.ttf"));

const TTEMBED_TTCOMPRESSED = 0x4;
const TTEMBED_XORENCRYPTDATA = 0x10000000;

function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value & 0xffff);
  return b;
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value >>> 0);
  return b;
}

/** An EOT version 0x00010000 around `data`, with a real family name so the font data does not sit
 *  at a fixed offset. `data` is stored XOR-ed when the flags say so, as a producer would. */
function wrapEot(data: Uint8Array, flags: number): Buffer {
  const family = Buffer.from("Carlito", "utf16le");
  const le16 = (v: number): Buffer => Buffer.from([v & 0xff, v >> 8]);
  // FamilyName, then (Padding, size) for the empty Style, Version and Full names.
  const names = Buffer.concat([le16(family.length), family, le16(0), le16(0), le16(0), le16(0), le16(0), le16(0)]);
  const header = Buffer.alloc(82);
  header.writeUInt32LE(82 + names.length + data.length, 0);
  header.writeUInt32LE(data.length, 4);
  header.writeUInt32LE(0x00010000, 8);
  header.writeUInt32LE(flags, 12);
  header.writeUInt16LE(0x504c, 34);
  const stored = (flags & TTEMBED_XORENCRYPTDATA) !== 0 ? data.map((b) => b ^ 0x50) : data;
  return Buffer.concat([header, names, stored]);
}

/** A table of an sfnt by tag, or `undefined`. */
function table(font: Uint8Array, tag: string): Buffer | undefined {
  const b = Buffer.from(font.buffer, font.byteOffset, font.byteLength);
  for (let i = 0; i < b.readUInt16BE(4); i += 1) {
    const record = 12 + 16 * i;
    if (b.toString("latin1", record, record + 4) !== tag) continue;
    const offset = b.readUInt32BE(record + 8);
    return b.subarray(offset, offset + b.readUInt32BE(record + 12));
  }
  return undefined;
}

describe("decodeEmbeddedFont — no compression", () => {
  test("a plain TrueType file passes through untouched", () => {
    expect(decodeEmbeddedFont(CARLITO)).toBe(CARLITO);
  });

  test("an uncompressed EOT gives back the font byte for byte", () => {
    const decoded = decodeEmbeddedFont(wrapEot(CARLITO, 0));
    expect(decoded && Buffer.from(decoded).equals(CARLITO)).toBe(true);
  });

  test("an XOR-ed EOT is un-XOR-ed", () => {
    const decoded = decodeEmbeddedFont(wrapEot(CARLITO, TTEMBED_XORENCRYPTDATA));
    expect(decoded && Buffer.from(decoded).equals(CARLITO)).toBe(true);
  });

  test("anything unreadable is null, never a throw", () => {
    expect(decodeEmbeddedFont(new Uint8Array(0))).toBeNull();
    expect(decodeEmbeddedFont(new Uint8Array(500).fill(7))).toBeNull();
    const eot = wrapEot(CARLITO, 0);
    expect(decodeEmbeddedFont(eot.subarray(0, 4000))).toBeNull(); // EOTSize past the end
    // Compressed per the flags, but the payload is a plain font: LZCOMP reads garbage.
    expect(decodeEmbeddedFont(wrapEot(CARLITO, TTEMBED_TTCOMPRESSED))).toBeNull();
    expect(decodeEmbeddedFont(wrapEot(new Uint8Array(3), TTEMBED_TTCOMPRESSED))).toBeNull();
  });
});

// -- a tiny MTX font --------------------------------------------------------------------------------

/** The encoder half of LZCOMP's adaptive Huffman model (MTX Appendix C, `MTX_AHUFF_Create` and
 *  `MTX_AHUFF_WriteSymbol`), written out again so the test does not borrow the decoder's. */
class HuffmanWriter {
  private readonly up: number[] = [];
  private readonly left: number[] = [];
  private readonly right: number[] = [];
  private readonly symbol: number[] = [];
  private readonly weight: number[] = [];
  private readonly leafOf: number[] = [];

  constructor(range: number) {
    for (let i = 0; i < 2 * range; i += 1) {
      this.up.push(i >> 1);
      this.left.push(i < range ? 2 * i : -1);
      this.right.push(i < range ? 2 * i + 1 : -1);
      this.symbol.push(i < range ? -1 : i - range);
      this.weight.push(1);
    }
    for (let s = 0; s < range; s += 1) this.leafOf.push(range + s);
    for (let i = range - 1; i >= 1; i -= 1) this.weight[i] = this.weight[2 * i]! + this.weight[2 * i + 1]!;
    this.weight[0] = 0;
    this.update(this.leafOf[256]!);
    this.update(this.leafOf[257]!);
    for (let i = 0; i < 12; i += 1) this.update(this.leafOf[range - 3]!);
    for (let i = 0; i < 6; i += 1) this.update(this.leafOf[range - 2]!);
  }

  write(symbol: number, bits: number[]): void {
    const path: number[] = [];
    for (let node = this.leafOf[symbol]!; node !== 1; node = this.up[node]!) {
      path.push(this.right[this.up[node]!] === node ? 1 : 0);
    }
    bits.push(...path.reverse());
    this.update(this.leafOf[symbol]!);
  }

  private update(leaf: number): void {
    for (let a = leaf; a !== 1; a = this.up[a]!) {
      const w = this.weight[a]!;
      let b = a - 1;
      if (this.weight[b] === w) {
        while (this.weight[b] === w) b -= 1;
        b += 1;
        if (b > 1) {
          this.swap(a, b);
          a = b;
        }
      }
      this.weight[a] = w + 1;
    }
    this.weight[1] = this.weight[1]! + 1;
  }

  private swap(a: number, b: number): void {
    for (const field of [this.left, this.right, this.symbol, this.weight]) [field[a], field[b]] = [field[b]!, field[a]!];
    for (const node of [a, b]) {
      const s = this.symbol[node]!;
      if (s >= 0) this.leafOf[s] = node;
      else this.up[this.left[node]!] = this.up[this.right[node]!] = node;
    }
  }
}

/** LZCOMP the simplest legal way: no run-length pass, every byte a literal. */
function lzcompLiterals(data: Uint8Array): Buffer {
  const bits: number[] = [];
  const put = (value: number, count: number): void => {
    for (let i = count - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  put(0, 1); // no run-length pass
  put(data.length, 24);
  let ranges = 1;
  while (8 ** ranges < data.length) ranges += 1;
  const symbols = new HuffmanWriter(256 + 8 * ranges + 3);
  for (const byte of data) symbols.write(byte, bits);
  const out = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((bit, i) => (out[i >> 3] = out[i >> 3]! | (bit << (7 - (i & 7)))));
  return out;
}

function mtx(tables: Buffer, pushes: Buffer, code: Buffer): Buffer {
  const blocks = [lzcompLiterals(tables), lzcompLiterals(pushes), lzcompLiterals(code)];
  const u24 = (v: number): Buffer => Buffer.from([v >> 16, (v >> 8) & 0xff, v & 0xff]);
  const offset2 = 10 + blocks[0]!.length;
  const offset3 = offset2 + blocks[1]!.length;
  return Buffer.concat([Buffer.from([3]), u24(0x7fffff), u24(offset2), u24(offset3), ...blocks]);
}

/** A CTF sfnt: the directory, then the tables back to back (CTF needs no alignment). */
function ctf(tables: [string, Buffer][]): Buffer {
  let offset = 12 + 16 * tables.length;
  const records = tables.map(([tag, data]) => {
    const record = Buffer.concat([Buffer.from(tag, "latin1"), u32(0), u32(data.length ? offset : 0), u32(data.length)]);
    offset += data.length;
    return record;
  });
  return Buffer.concat([u32(0x00010000), u16(tables.length), u16(0), u16(0), u16(0), ...records, ...tables.map(([, d]) => d)]);
}

const head = Buffer.alloc(54);
head.writeUInt32BE(0x00010000, 0);
head.writeUInt32BE(0xdeadbeef, 8); // a stale checkSumAdjustment, to be recomputed
head.writeUInt32BE(0x5f0f3cf5, 12);
head.writeUInt16BE(1000, 18);

const maxp = Buffer.alloc(32);
maxp.writeUInt32BE(0x00010000, 0);
maxp.writeUInt16BE(3, 4); // numGlyphs
maxp.writeUInt16BE(0, 26); // maxSizeOfInstructions: understated on purpose

/** §5.2: 10, +290 (= 300), -305 (= -5), +20005 (= 20000), in each of the four byte forms. */
const cvt = Buffer.from([0, 4, 10, 248, 52, 240, 67, 238, 0x4e, 0x25]);

/** Glyph 0 empty; glyph 1 a triangle (100,0) (300,600 off-curve) (500,0) with 5 pushes and 2 bytes
 *  of code; glyph 2 a composite of glyph 1 with 1 byte of code. */
const glyf = Buffer.concat([
  u16(0),
  u16(1), // contours
  Buffer.from([2]), // end point of the first contour
  Buffer.from([11, 0x80 | 95, 93]), // triplet flags: dx only (+); 8+8 bits (+,+) off-curve; (+,-)
  Buffer.from([100, 199, 87, 199, 87]), // dx 100 | dx 1+199, dy 513+87 | dx 1+199, dy -(513+87)
  Buffer.from([5, 2]), // pushCount, codeSize
  u16(-1),
  u16(100), u16(0), u16(500), u16(600), // bounding box
  u16(0x0103), u16(1), u16(10), u16(20), // ARG_1_AND_2_ARE_WORDS | ARGS_ARE_XY_VALUES | WE_HAVE_INSTRUCTIONS
  Buffer.from([0, 1]), // pushCount, codeSize
]);
/** 1, 2, Hop3 → A=1, 300 (255 + 50), A: the values 1 2 1 300 1. */
const pushes = Buffer.from([1, 2, 0xfb, 255, 50]);
const code = Buffer.from([0x1d, 0x1e, 0x2f]);

const tinyCtf = ctf([
  ["cvt ", cvt],
  ["glyf", glyf],
  ["hdmx", Buffer.from([0, 0, 0, 0])],
  ["head", head],
  ["loca", Buffer.alloc(0)],
  ["maxp", maxp],
]);

describe("decodeEmbeddedFont — MTX", () => {
  for (const [label, flags] of [
    ["compressed", TTEMBED_TTCOMPRESSED],
    ["compressed, then XOR-ed", TTEMBED_TTCOMPRESSED | TTEMBED_XORENCRYPTDATA],
  ] as const) {
    test(`rebuilds glyf, loca, cvt, maxp and the checksums (${label})`, () => {
      const font = decodeEmbeddedFont(wrapEot(mtx(tinyCtf, pushes, code), flags));
      expect(font).not.toBeNull();
      const f = Buffer.from(font!);

      expect(f.readUInt32BE(0)).toBe(0x00010000);
      const tags = Array.from({ length: f.readUInt16BE(4) }, (_, i) => f.toString("latin1", 12 + 16 * i, 16 + 16 * i));
      expect(tags).toEqual(["cvt ", "glyf", "head", "loca", "maxp"]); // sorted; hdmx dropped

      expect(Array.from({ length: 4 }, (_, i) => table(f, "cvt ")!.readInt16BE(2 * i))).toEqual([10, 300, -5, 20000]);

      const triangle = Buffer.concat([
        u16(1), u16(100), u16(0), u16(500), u16(600), // contours, box from the points
        u16(2), // end point
        u16(11), Buffer.from([0xb2, 1, 2, 1, 0xb8, 0x01, 0x2c, 0xb0, 1, 0x1d, 0x1e]), // PUSHB[3] PUSHW[1] PUSHB[1], code
        Buffer.from([0x33, 0x12, 0x13]), // on x+short y-same | off x+short y-word | on x+short y-word
        Buffer.from([100, 200, 200]),
        u16(600), u16(-600),
        Buffer.alloc(1), // 2-byte alignment
      ]);
      const composite = Buffer.concat([
        u16(-1), u16(100), u16(0), u16(500), u16(600),
        u16(0x0103), u16(1), u16(10), u16(20),
        u16(1), Buffer.from([0x2f]),
        Buffer.alloc(1),
      ]);
      expect(table(f, "glyf")!.equals(Buffer.concat([triangle, composite]))).toBe(true);
      expect(table(f, "loca")!.equals(Buffer.concat([u16(0), u16(0), u16(18), u16(29)]))).toBe(true);
      expect(table(f, "maxp")!.readUInt16BE(26)).toBe(11);

      // Every table's checksum, then the whole file's.
      const sum = (b: Buffer): number => {
        const padded = Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
        let s = 0;
        for (let i = 0; i < padded.length; i += 4) s = (s + padded.readUInt32BE(i)) >>> 0;
        return s;
      };
      for (const [i, tag] of tags.entries()) {
        const t = Buffer.from(table(f, tag)!);
        if (tag === "head") t.writeUInt32BE(0, 8);
        expect(f.readUInt32BE(16 + 16 * i)).toBe(sum(t));
      }
      expect(sum(f)).toBe(0xb1b0afba);
    });
  }
});

test("a run-length pass that would expand past 32 MB is refused, not written byte by byte (2026-11-22 audit, SE1)", () => {
  const escape = 0xfe;
  const runs = new Uint8Array(1 + 3 * 140_000);
  runs[0] = escape;
  for (let i = 1; i < runs.length; i += 3) runs.set([escape, 255, 0x41], i);
  expect(() => expandRuns(runs)).toThrow(RangeError);
  expect(expandRuns(new Uint8Array([escape, escape, 3, 0x41, 0x42]))).toEqual(new Uint8Array([0x41, 0x41, 0x41, 0x42]));
});
