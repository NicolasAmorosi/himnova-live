import fs from "node:fs";
import { inflateSync } from "node:zlib";
import { openOle } from "../ppt-binary";

/**
 * A picture, font or sound of a legacy deck, named the way a `.pptx` part is
 * named — so the same `worship://deck/<id>/part/<part>` serves both. The name
 * says where the bytes are and how to get them out; nothing is extracted to
 * disk:
 *
 *   `ppt/<stream>/<offset>/<length>/<codec>.<ext>`
 *
 * `stream` is `d` (the `PowerPoint Document` stream: inline BLIPs, fonts,
 * sounds) or `p` (`Pictures`); `codec` is `raw`, `z` (a metafile, zlib
 * compressed) or `dib` (a bitmap without its file header).
 */
export type BinaryPart = { stream: "d" | "p"; offset: number; length: number; codec: "raw" | "z" | "dib"; ext: string };

export const isBinaryPart = (part: string): boolean => part.startsWith("ppt/");

export function encodePart(p: BinaryPart): string {
  return `ppt/${p.stream}/${p.offset}/${p.length}/${p.codec}.${p.ext}`;
}

export function decodePart(part: string): BinaryPart | null {
  const m = /^ppt\/([dp])\/(\d+)\/(\d+)\/(raw|z|dib)\.([a-z0-9]+)$/.exec(part);
  if (!m) return null;
  return { stream: m[1] as "d" | "p", offset: Number(m[2]), length: Number(m[3]), codec: m[4] as BinaryPart["codec"], ext: m[5]! };
}

/** Parts can be large (a sound): no more than this is read for one. */
const MAX_PART_BYTES = 256 * 1024 * 1024;

/** The bytes of a part, ready to serve, or `null` when the file no longer has
 *  them where the name says. */
export function readBinaryPart(file: string, part: string): Uint8Array | null {
  const p = decodePart(part);
  if (!p || p.length <= 0 || p.length > MAX_PART_BYTES) return null;
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const ole = openOle(fd, fs.fstatSync(fd).size);
    if (!ole) return null;
    const raw = ole.readStreamRange(p.stream === "d" ? "PowerPoint Document" : "Pictures", p.offset, p.length);
    if (!raw) return null;
    if (p.codec === "z") return new Uint8Array(inflateSync(raw));
    if (p.codec === "dib") return dibToBmp(raw);
    return new Uint8Array(raw);
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** A device-independent bitmap as a `.bmp` file: the 14-byte file header in
 *  front, with the offset to the pixels after the info header and palette. */
function dibToBmp(dib: Buffer): Uint8Array | null {
  if (dib.length < 16) return null;
  const headerSize = dib.readUInt32LE(0);
  const bitCount = headerSize >= 16 ? dib.readUInt16LE(14) : 0;
  const compression = headerSize >= 20 ? dib.readUInt32LE(16) : 0;
  let colors = headerSize >= 36 ? dib.readUInt32LE(32) : 0;
  if (colors === 0 && bitCount > 0 && bitCount <= 8) colors = 1 << bitCount;
  const masks = compression === 3 && headerSize === 40 ? 12 : 0;
  const out = Buffer.alloc(14 + dib.length);
  out.write("BM", 0, "latin1");
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(14 + headerSize + masks + colors * 4, 10);
  dib.copy(out, 14);
  return new Uint8Array(out);
}
