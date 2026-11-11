import fs from "node:fs";
import { Inflate, inflateSync } from "fflate";

/**
 * Reads a handful of named entries out of a zip without ever holding the
 * whole archive in memory.
 *
 * The reason this exists: a `.pptx`/`.ppsx` is a zip whose bulk is media —
 * a 200 MB deck is 200 MB of images and video around a few dozen KB of the
 * XML we actually parse. `unzipSync` (fflate) takes a buffer, so using it
 * means `readFileSync`-ing the entire file first: a 200 MB synchronous read
 * plus a 200 MB allocation, on the same thread that serves the projection
 * window. Filtering entries afterwards saves the *inflate*, not the read.
 *
 * A zip is random-access by design — that is the whole point of its central
 * directory, which sits at the end and says where every entry starts. So
 * this reads the tail, walks the directory, and then reads exactly the byte
 * ranges of the entries it was asked for: kilobytes instead of megabytes, no
 * matter how big the deck is.
 *
 * Deliberately synchronous. Every read here is small and bounded, so it
 * blocks the event loop for microseconds rather than the hundreds of
 * milliseconds a whole-file read costs — which is what lets the callers
 * (`readPresentationMeta`, `extractAudioParts`, `extractHintFromOoxml`) keep
 * their synchronous signatures, and with them `MediaRepo.ensureLinkedAudio`
 * and everything above it.
 */

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

const EOCD_MIN_SIZE = 22;
const ZIP64_LOCATOR_SIZE = 20;
const CENTRAL_HEADER_FIXED_SIZE = 46;
const LOCAL_HEADER_FIXED_SIZE = 30;

/** The zip comment is a `u16` length, so the end-of-central-directory record
 *  can never start further back than this from the end of the file. */
const MAX_EOCD_SEARCH_BYTES = 0xffff + EOCD_MIN_SIZE;

/** A field set to all-ones is zip's "look in the zip64 extra field instead". */
const U32_SENTINEL = 0xffffffff;
const U16_SENTINEL = 0xffff;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** General-purpose bit 0. An encrypted entry's bytes are not inflatable, and
 *  a presentation that needs a password is not something this app opens. */
const FLAG_ENCRYPTED = 0x0001;
/** General-purpose bit 11: the name is UTF-8 rather than CP437. */
const FLAG_UTF8_NAME = 0x0800;

/** One read per entry is the obvious way to do this and it is the wrong one
 *  past a few dozen entries: a 400-slide deck wants ~800 parts, and the
 *  syscalls alone cost more than reading the file whole (measured: 2.9 ms vs
 *  0.9 ms over 118 parts of a 3 MB archive). The parts this reader is asked
 *  for are also, in every real `.pptx`, written near each other — so when
 *  they all fit inside a window this size, the window is read once and every
 *  entry is sliced out of it. Beyond it, per-entry reads: a deck whose wanted
 *  parts are genuinely scattered across 200 MB is exactly the case where
 *  reading the span would be reading the whole file again. */
const SPAN_MAX_BYTES = 8 * 1024 * 1024;

/** A local header's extra field is not the central directory's, and only the
 *  local one says where the data starts — so a span has to over-reserve for
 *  it. Real writers use a few dozen bytes of alignment padding; an entry that
 *  somehow overruns this just falls back to its own read. */
const LOCAL_EXTRA_SLACK = 4096;

export class ZipFormatError extends Error {}

type CentralEntry = {
  compressedSize: number;
  /** Load-bearing for speed, not just bookkeeping — see `inflateEntry`. */
  uncompressedSize: number;
  localHeaderOffset: number;
  /** The central directory's copy — only used to size the read window, never
   *  to locate data (see `readEntryData`). */
  nameLength: number;
  method: number;
  flags: number;
};

/** A single stretch of the file held in memory, out of which several entries
 *  are sliced. `null` whenever the wanted entries are too far apart to make
 *  that worthwhile. */
type ReadWindow = { start: number; buffer: Buffer } | null;

function readChunk(fd: number, position: number, length: number): Buffer {
  // Unsafe, i.e. not zero-filled: every byte is either overwritten by the
  // read below or the whole call throws. Zeroing matters here — the read
  // window is megabytes, and filling it with zeroes first was costing more
  // than the read itself.
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, buffer, read, length - read, position + read);
    if (n === 0) break;
    read += n;
  }
  if (read < length) throw new ZipFormatError("Unexpected end of file");
  return buffer;
}

/** Zip stores 64-bit fields as two 32-bit halves. `Number` is exact to 2^53,
 *  which is far past any file this app will ever open — but a value that
 *  large is corruption, not a big deck, so it is rejected rather than
 *  silently truncated. */
function readU64(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipFormatError("Offset too large");
  return Number(value);
}

type Eocd = { centralDirOffset: number; centralDirSize: number; entryCount: number };

/** Scans backwards for the EOCD signature, reading a small tail first: an
 *  archive with no trailing comment — every `.pptx` this app will see — puts
 *  it in the last 22 bytes, so the 64 KB the format technically allows is
 *  only ever read when the short tail comes up empty. */
function readTailContainingEocd(fd: number, fileSize: number): { tail: Buffer; eocd: number } {
  const sizes = [Math.min(fileSize, 1024), Math.min(fileSize, MAX_EOCD_SEARCH_BYTES)];
  for (const tailSize of sizes) {
    if (tailSize < EOCD_MIN_SIZE) continue;
    const tail = readChunk(fd, fileSize - tailSize, tailSize);
    for (let i = tail.length - EOCD_MIN_SIZE; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) return { tail, eocd: i };
    }
    if (tailSize === fileSize) break;
  }
  throw new ZipFormatError("Not a zip file (no end-of-central-directory record)");
}

function locateCentralDirectory(fd: number, fileSize: number): Eocd {
  const { tail, eocd } = readTailContainingEocd(fd, fileSize);

  let entryCount = tail.readUInt16LE(eocd + 10);
  let centralDirSize = tail.readUInt32LE(eocd + 12);
  let centralDirOffset = tail.readUInt32LE(eocd + 16);

  // Any of the three going to all-ones means the real values live in a zip64
  // record, which the locator immediately before the EOCD points at. Decks
  // big enough to need this are rare but entirely legal, and a deck of >65535
  // parts is not even that far-fetched for a heavily illustrated one.
  const needsZip64 =
    entryCount === U16_SENTINEL || centralDirSize === U32_SENTINEL || centralDirOffset === U32_SENTINEL;
  if (needsZip64) {
    const locator = eocd - ZIP64_LOCATOR_SIZE;
    if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR_SIGNATURE) {
      throw new ZipFormatError("zip64 end-of-central-directory locator missing");
    }
    const zip64Offset = readU64(tail, locator + 8);
    const record = readChunk(fd, zip64Offset, 56);
    if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
      throw new ZipFormatError("zip64 end-of-central-directory record missing");
    }
    entryCount = readU64(record, 32);
    centralDirSize = readU64(record, 40);
    centralDirOffset = readU64(record, 48);
  }

  if (centralDirOffset + centralDirSize > fileSize) {
    throw new ZipFormatError("Central directory out of bounds");
  }
  return { centralDirOffset, centralDirSize, entryCount };
}

/** Only the three fields zip64 can override, and only in this fixed order,
 *  each one present only if its 32-bit slot held the sentinel. */
function applyZip64Extra(
  extra: Buffer,
  sizes: { uncompressedSize: number; compressedSize: number; localHeaderOffset: number },
): void {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    const body = cursor + 4;
    if (headerId === 0x0001) {
      let field = body;
      if (sizes.uncompressedSize === U32_SENTINEL && field + 8 <= body + size) {
        sizes.uncompressedSize = readU64(extra, field);
        field += 8;
      }
      if (sizes.compressedSize === U32_SENTINEL && field + 8 <= body + size) {
        sizes.compressedSize = readU64(extra, field);
        field += 8;
      }
      if (sizes.localHeaderOffset === U32_SENTINEL && field + 8 <= body + size) {
        sizes.localHeaderOffset = readU64(extra, field);
      }
      return;
    }
    cursor = body + size;
  }
}

function parseCentralDirectory(
  directory: Buffer,
  entryCount: number,
  wanted: (name: string) => boolean,
): Map<string, CentralEntry> {
  const found = new Map<string, CentralEntry>();
  let cursor = 0;

  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + CENTRAL_HEADER_FIXED_SIZE > directory.length) break;
    if (directory.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) {
      throw new ZipFormatError("Malformed central directory entry");
    }

    const flags = directory.readUInt16LE(cursor + 8);
    const method = directory.readUInt16LE(cursor + 10);
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    const nameStart = cursor + CENTRAL_HEADER_FIXED_SIZE;
    const extraStart = nameStart + nameLength;

    const sizes = {
      uncompressedSize: directory.readUInt32LE(cursor + 24),
      compressedSize: directory.readUInt32LE(cursor + 20),
      localHeaderOffset: directory.readUInt32LE(cursor + 42),
    };
    if (
      sizes.uncompressedSize === U32_SENTINEL ||
      sizes.compressedSize === U32_SENTINEL ||
      sizes.localHeaderOffset === U32_SENTINEL
    ) {
      applyZip64Extra(directory.subarray(extraStart, extraStart + extraLength), sizes);
    }

    const name = directory
      .subarray(nameStart, extraStart)
      .toString((flags & FLAG_UTF8_NAME) !== 0 ? "utf8" : "latin1");

    if (wanted(name)) {
      found.set(name, {
        compressedSize: sizes.compressedSize,
        uncompressedSize: sizes.uncompressedSize,
        localHeaderOffset: sizes.localHeaderOffset,
        nameLength,
        method,
        flags,
      });
    }

    cursor = extraStart + extraLength + commentLength;
  }

  return found;
}

/**
 * The central directory's copy of a name/extra length is not authoritative
 * for the *local* header — the two are allowed to differ, and in practice do
 * (writers pad the local extra field for alignment). So the data offset has
 * to come from the local header itself, which is why this costs one extra
 * 30-byte read per entry.
 */
function openReadWindow(fd: number, entries: Iterable<CentralEntry>, fileSize: number): ReadWindow {
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  for (const entry of entries) {
    start = Math.min(start, entry.localHeaderOffset);
    end = Math.max(
      end,
      entry.localHeaderOffset +
        LOCAL_HEADER_FIXED_SIZE +
        entry.nameLength +
        LOCAL_EXTRA_SLACK +
        entry.compressedSize,
    );
  }
  if (!Number.isFinite(start)) return null;
  const length = Math.min(end, fileSize) - start;
  if (length <= 0 || length > SPAN_MAX_BYTES) return null;
  return { start, buffer: readChunk(fd, start, length) };
}

/** The window's view of `[offset, offset + length)`, or `null` when it does
 *  not cover that range — which is the signal to read it directly instead. */
function sliceWindow(window: ReadWindow, offset: number, length: number): Buffer | null {
  if (!window) return null;
  const from = offset - window.start;
  if (from < 0 || from + length > window.buffer.length) return null;
  return window.buffer.subarray(from, from + length);
}

function readEntryData(fd: number, entry: CentralEntry, window: ReadWindow): Uint8Array {
  const header =
    sliceWindow(window, entry.localHeaderOffset, LOCAL_HEADER_FIXED_SIZE) ??
    readChunk(fd, entry.localHeaderOffset, LOCAL_HEADER_FIXED_SIZE);
  if (header.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
    throw new ZipFormatError("Malformed local file header");
  }
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const dataOffset = entry.localHeaderOffset + LOCAL_HEADER_FIXED_SIZE + nameLength + extraLength;

  const raw =
    sliceWindow(window, dataOffset, entry.compressedSize) ??
    readChunk(fd, dataOffset, entry.compressedSize);
  // Copied, never handed out as a view: `raw` may be a slice of the shared
  // read window, and returning it would pin those megabytes alive for as long
  // as any caller keeps one small XML part.
  if (entry.method === METHOD_STORE) return new Uint8Array(raw);
  if (entry.method === METHOD_DEFLATE) return inflateEntry(raw, entry.uncompressedSize);
  throw new ZipFormatError(`Unsupported compression method ${entry.method}`);
}

/**
 * `inflateSync` without an `out` buffer has to guess the output size and grow
 * it as it goes, and that guessing is most of the cost of a *small* entry:
 * measured at ~16 µs of fixed overhead per call, which over the ~800 parts of
 * a 400-slide deck is most of a frame. The central directory already knows
 * the exact size, so it is handed over and the whole growth loop disappears
 * (1.9 ms → 0.4 ms over 120 parts) — this is how fflate's own `unzipSync`
 * manages to be faster per entry than its public single-entry API.
 *
 * A central directory that lies about the size makes fflate throw; that falls
 * back to letting it work the size out, rather than losing the part.
 */
function inflateEntry(raw: Buffer, uncompressedSize: number): Uint8Array {
  // A hostile archive of a few KB inflates to gigabytes (398 KB to 400 MB in main, measured: 2026-11-10 review,
  // agent6-04). No part of a deck or a Bible module comes near this — a video is stored, not deflated.
  if (uncompressedSize > MAX_INFLATED_BYTES) throw new ZipFormatError(`An entry of ${uncompressedSize} bytes`);
  if (uncompressedSize > 0) {
    try {
      return inflateSync(raw, { out: new Uint8Array(uncompressedSize) });
    } catch {
      /* fall through */
    }
  }
  // The directory lied about the size: inflated a piece at a time, never past the cap.
  const pieces: Uint8Array[] = [];
  let total = 0;
  const inflater = new Inflate((piece) => {
    total += piece.length;
    if (total > MAX_INFLATED_BYTES) throw new ZipFormatError("An entry past the inflate cap");
    pieces.push(piece);
  });
  inflater.push(raw, true);
  const out = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}

const MAX_INFLATED_BYTES = 256 * 1024 * 1024;

/**
 * Inflates every entry of `filePath` whose name satisfies `wanted`, and
 * nothing else — the archive itself is never fully read. Entries that are
 * encrypted or use a compression method other than store/deflate are skipped
 * rather than throwing: one odd part must not cost a deck its timings.
 *
 * Throws `ZipFormatError` when the file is not a readable zip at all, which
 * is the same shape of failure `unzipSync` produced and which every caller
 * already treats as "no metadata available".
 */
export function readZipEntries(
  filePath: string,
  wanted: (name: string) => boolean,
): Record<string, Uint8Array> {
  const fd = fs.openSync(filePath, "r");
  try {
    const { size } = fs.fstatSync(fd);
    if (size < EOCD_MIN_SIZE) throw new ZipFormatError("File too small to be a zip");

    const { centralDirOffset, centralDirSize, entryCount } = locateCentralDirectory(fd, size);
    const directory = readChunk(fd, centralDirOffset, centralDirSize);
    const entries = parseCentralDirectory(directory, entryCount, wanted);

    const readable = [...entries].filter(
      ([, entry]) =>
        (entry.flags & FLAG_ENCRYPTED) === 0 &&
        (entry.method === METHOD_STORE || entry.method === METHOD_DEFLATE),
    );
    const window = openReadWindow(
      fd,
      readable.map(([, entry]) => entry),
      size,
    );

    const result: Record<string, Uint8Array> = {};
    for (const [name, entry] of readable) {
      try {
        result[name] = readEntryData(fd, entry, window);
      } catch {
        /* One unreadable part is not a reason to lose the rest. */
      }
    }
    return result;
  } finally {
    fs.closeSync(fd);
  }
}
