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

test("a zip bomb is refused, not inflated: a few hundred KB declaring 300 MB comes back without that entry", () => {
  // 2026-11-10 review, agent6-04: 398 KB on disk became 400 MB in main.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-zip-bomb-"));
  const file = path.join(dir, "bomb.zip");
  fs.writeFileSync(file, zipSync({ "biblia.xml": [new Uint8Array(300 * 1024 * 1024).fill(0x61), { level: 9 }], "ok.xml": strToU8("<ok/>") }));
  expect(fs.statSync(file).size).toBeLessThan(1024 * 1024);
  const out = readZipEntries(file, (name) => name.endsWith(".xml"));
  expect(out["biblia.xml"]).toBeUndefined();
  expect(strFromU8(out["ok.xml"]!)).toBe("<ok/>");
  fs.rmSync(dir, { recursive: true, force: true });
});
