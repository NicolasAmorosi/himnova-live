/**
 * `readZipEntries` — the reason a 200 MB deck costs kilobytes to parse.
 *
 * The property that matters is not "it inflates entries" (fflate does that);
 * it is that the archive is never read whole. A `.pptx` is mostly media around
 * a few dozen KB of XML, and `unzipSync` with a filter still `readFileSync`s
 * every byte first — it saves the inflate, not the read. So the central
 * assertion here counts the bytes the reader actually pulls off disk.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { strFromU8, strToU8, zipSync } from "fflate";
import { ZipFormatError, readZipEntries } from "../../src/main/slides/zip-reader";

const XML = '<?xml version="1.0"?><p:presentation><p:sldSz cx="9144000" cy="6858000"/></p:presentation>';
/** Incompressible, so the stored copy on disk really is this big. */
const BULK_BYTES = 2 * 1024 * 1024;

let tmpDir: string;
let archive: string;
let bulk: Uint8Array;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-zip-"));
  archive = path.join(tmpDir, "deck.pptx");

  bulk = new Uint8Array(BULK_BYTES);
  // Deterministic pseudo-random: deflate cannot shrink it, so the entry's
  // weight on disk is real rather than an artifact of a compressible pattern.
  let seed = 1;
  for (let i = 0; i < bulk.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    bulk[i] = seed & 0xff;
  }

  fs.writeFileSync(
    archive,
    zipSync({
      "ppt/presentation.xml": strToU8(XML),
      "ppt/media/image1.png": [bulk, { level: 0 }],
      "docProps/app.xml": strToU8("<Properties/>"),
    }),
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("readZipEntries", () => {
  test("returns exactly the wanted entries, byte for byte", () => {
    const entries = readZipEntries(archive, (name) => name === "ppt/presentation.xml");
    expect(Object.keys(entries)).toEqual(["ppt/presentation.xml"]);
    expect(Buffer.from(entries["ppt/presentation.xml"]!).toString("utf8")).toBe(XML);
  });

  test("reads several entries in one pass", () => {
    const entries = readZipEntries(archive, (name) => name.endsWith(".xml"));
    expect(Object.keys(entries).sort()).toEqual(["docProps/app.xml", "ppt/presentation.xml"]);
  });

  test("a stored (uncompressed) entry comes back intact", () => {
    const entries = readZipEntries(archive, (name) => name === "ppt/media/image1.png");
    // Byte comparison, not `toEqual`: a deep equality walks 2 MB one element at
    // a time (12 s), which timed the suite out on a loaded machine.
    const entry = entries["ppt/media/image1.png"];
    expect(entry && Buffer.from(entry).equals(Buffer.from(bulk))).toBe(true);
  });

  test("never reads the whole archive to get at the small parts", () => {
    // The regression guard for the `unzipSync` version: reading 2 MB of PNG to
    // parse 90 bytes of XML. The budget is generous on purpose — what must not
    // happen is the reader touching anything near the file's size.
    const fileSize = fs.statSync(archive).size;
    expect(fileSize).toBeGreaterThan(BULK_BYTES);

    let bytesRead = 0;
    const realReadSync = fs.readSync.bind(fs) as (...args: unknown[]) => number;
    vi.spyOn(fs, "readSync").mockImplementation((...args: unknown[]) => {
      // Signature in use here: (fd, buffer, offset, length, position).
      bytesRead += typeof args[3] === "number" ? args[3] : 0;
      return realReadSync(...args);
    });

    try {
      const entries = readZipEntries(archive, (name) => name === "ppt/presentation.xml");
      expect(Object.keys(entries)).toEqual(["ppt/presentation.xml"]);
    } finally {
      vi.restoreAllMocks();
    }

    // Measured: 5437 bytes off a 2 MB archive (the EOCD search window, the
    // central directory, and the one entry's own span). The bound is a round
    // number well above that and far below the file — it has to fail loudly if
    // anyone reintroduces a whole-file read, not track the exact figure.
    expect(bytesRead).toBeLessThan(64 * 1024);
    expect(bytesRead).toBeLessThan(fileSize / 8);
  });

  test("an unmatched filter yields nothing, without reading any entry", () => {
    expect(readZipEntries(archive, () => false)).toEqual({});
  });

  test("a file that is not a zip throws ZipFormatError", () => {
    const notAZip = path.join(tmpDir, "not-a-zip.pptx");
    fs.writeFileSync(notAZip, "this is a PowerPoint 97 binary, not an OOXML package");
    expect(() => readZipEntries(notAZip, () => true)).toThrow(ZipFormatError);
  });

  test("a file too small to hold an end-of-central-directory record throws", () => {
    const tiny = path.join(tmpDir, "tiny.pptx");
    fs.writeFileSync(tiny, "PK");
    expect(() => readZipEntries(tiny, () => true)).toThrow(ZipFormatError);
  });
});

describe("an entry is never inflated past the size the central directory declares", () => {
  let dir: string;
  /** 32 MB of one letter, a few KB on disk. The sizes the tests need are written into its headers: building a real
   *  300 MB one in a hook took long enough under the full suite's load to fail it. */
  let bomb: Uint8Array;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-zip-bomb-"));
    bomb = zipSync({ "biblia.xml": [new Uint8Array(32 * 1024 * 1024).fill(0x61), { level: 9 }], "ok.xml": strToU8("<ok/>") });
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** Writes `declared` as `name`'s uncompressed size in its local header and in the central directory. */
  function patchDeclaredSize(zip: Uint8Array, name: string, declared: number): Buffer {
    const buf = Buffer.from(zip);
    const target = Buffer.from(name, "utf8");
    for (let at = 0; at < buf.length - 46; at++) {
      const sig = buf.readUInt32LE(at);
      if (sig === 0x04034b50 && buf.subarray(at + 30, at + 30 + target.length).equals(target)) buf.writeUInt32LE(declared, at + 22);
      if (sig === 0x02014b50 && buf.subarray(at + 46, at + 46 + target.length).equals(target)) buf.writeUInt32LE(declared, at + 24);
    }
    return buf;
  }

  function read(name: string, zip: Uint8Array): { out: Record<string, Uint8Array>; ms: number } {
    const file = path.join(dir, name);
    fs.writeFileSync(file, zip);
    const t0 = performance.now();
    const out = readZipEntries(file, (entry) => entry.endsWith(".xml"));
    return { out, ms: performance.now() - t0 };
  }

  test("a few hundred KB declaring 300 MB comes back without that entry", () => {
    // 2026-11-10 review, agent6-04: 398 KB on disk became 400 MB in main.
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const { out } = read("bomb.zip", patchDeclaredSize(bomb, "biblia.xml", 300 * 1024 * 1024));
    expect(out["biblia.xml"]?.length).toBeUndefined();
    expect(strFromU8(out["ok.xml"]!)).toBe("<ok/>");
  });

  // 2026-11-15 audit, S7: fflate given a 1000-byte `out` decoded the whole stream (15 s for a 3 GB one) and handed
  // back the first 1000 bytes as if they were the part.
  test("the same bomb declaring 1000 bytes is refused in milliseconds, and its neighbour still reads", () => {
    const { out, ms } = read("small.zip", patchDeclaredSize(bomb, "biblia.xml", 1000));
    expect(out["biblia.xml"]?.length).toBeUndefined();
    expect(strFromU8(out["ok.xml"]!)).toBe("<ok/>");
    expect(ms).toBeLessThan(1000);
  });

  test("declaring 0 bytes means an empty part, so the bomb is refused in milliseconds too", () => {
    const { out, ms } = read("zero.zip", patchDeclaredSize(bomb, "biblia.xml", 0));
    expect(out["biblia.xml"]?.length).toBeUndefined();
    expect(strFromU8(out["ok.xml"]!)).toBe("<ok/>");
    expect(ms).toBeLessThan(1000);
  });

  test("an honest part that declares ten bytes too few is corrupt, not silently cut", () => {
    const xml = "<p:sld><p:cSld><p:spTree/></p:cSld></p:sld>";
    const { out } = read("short.zip", patchDeclaredSize(zipSync({ "slide1.xml": strToU8(xml) }), "slide1.xml", xml.length - 10));
    expect(out["slide1.xml"]).toBeUndefined();
  });

  test("an honest part reads whole, as an exact buffer of its own, and an empty one reads empty", () => {
    const xml = "<p:sld>" + "<a:t>Santo, santo, santo</a:t>".repeat(4000) + "</p:sld>";
    const { out } = read("honest.zip", zipSync({ "slide1.xml": strToU8(xml), "empty.xml": new Uint8Array(0) }));
    expect(strFromU8(out["slide1.xml"]!)).toBe(xml);
    expect(out["slide1.xml"]!.byteOffset).toBe(0);
    expect(out["slide1.xml"]!.buffer.byteLength).toBe(xml.length);
    expect(out["empty.xml"]!.length).toBe(0);
  });
});

// 2026-11-15 audit, S10: the cap was per entry, so three XML parts of 200 MB of zeros (a 614 KB `.pptx`) inflated
// 600 MB together. The budget is the third parameter so this needs megabytes, not the real 512 MB.
test("one call inflates no more than its budget in all, and stored entries do not count against it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-zip-budget-"));
  const file = path.join(dir, "deck.pptx");
  const mb = new Uint8Array(1024 * 1024);
  fs.writeFileSync(file, zipSync({ "a.xml": mb, "b.xml": mb, "video.mp4": [new Uint8Array(3 * 1024 * 1024), { level: 0 }], "c.xml": mb }));
  const out = readZipEntries(file, () => true, 2.5 * 1024 * 1024);
  expect(out["a.xml"]!.length).toBe(mb.length);
  expect(out["b.xml"]!.length).toBe(mb.length);
  expect(out["video.mp4"]!.length).toBe(3 * 1024 * 1024);
  expect(out["c.xml"]).toBeUndefined();
  expect(Object.keys(readZipEntries(file, () => true)).sort()).toEqual(["a.xml", "b.xml", "c.xml", "video.mp4"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 2026-11-15 audit, S10, review: stored entries were not counted at all, so a central directory whose entries all
// point at one stored blob copied it once per entry, N times a file of about one blob.
test("stored entries copy no more than the file holds in all, however many entries point at one blob", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-zip-stored-"));
  const file = path.join(dir, "deck.pptx");
  const blob = new Uint8Array(1024 * 1024).fill(7);
  const zip = Buffer.from(
    zipSync({ "a.mp4": [blob, { level: 0 }], "b.mp4": [new Uint8Array(1), { level: 0 }], "c.mp4": [new Uint8Array(1), { level: 0 }] }),
  );
  // The directory says `b` and `c` are `a`'s bytes, at `a`'s offset.
  for (let at = 0; at < zip.length - 46; at++) {
    if (zip.readUInt32LE(at) !== 0x02014b50 || zip.subarray(at + 46, at + 51).toString() === "a.mp4") continue;
    zip.writeUInt32LE(blob.length, at + 20);
    zip.writeUInt32LE(blob.length, at + 24);
    zip.writeUInt32LE(0, at + 42);
  }
  fs.writeFileSync(file, zip);
  const out = readZipEntries(file, () => true);
  expect(out["a.mp4"]!.length).toBe(blob.length);
  expect(Object.keys(out)).toEqual(["a.mp4"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
