import { TextDecoder } from "node:util";

/** What a file's bytes were read as: the decoder's own name for the encoding
 *  (`utf-8`, `utf-16le`, `windows-1252`…) and whether a byte-order mark led. */
export type ReadText = { text: string; encoding: string; bom: boolean };

/**
 * Bytes to text, honouring what the file says it is: its byte-order mark, else
 * its XML declaration's `encoding`, else UTF-8 when the bytes are valid UTF-8,
 * else Windows-1252 — what an old file written on Windows is.
 *
 * This is the difference between «Ó Deus de Amor» and «� Deus de Amor» on the
 * projector. Old files are common in both libraries this reads: much of the
 * Zefania and OSIS bible catalogue is `encoding="ISO-8859-1"`, and OpenLP 2.0
 * wrote OpenLyrics as `encoding='windows-1252'` (the HASD hymnal, 2026-11-05).
 * A declared encoding is trusted over a guess, but a file that declares UTF-8
 * and is not still reads as Windows-1252 instead of losing every accent.
 */
export function readText(bytes: Uint8Array): ReadText {
  const bom =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
          ? "utf-8"
          : undefined;
  // The declaration is ASCII in every encoding it can name but UTF-16's, so
  // reading the head as latin1 is safe.
  const declared =
    bom ?? /encoding\s*=\s*["']([\w.:-]+)["']/i.exec(Buffer.from(bytes.subarray(0, 200)).toString("latin1"))?.[1];
  for (const label of [declared, "utf-8"]) {
    if (!label) continue;
    try {
      // A UTF-8 or UTF-16 mark is dropped by the decoder itself.
      const decoder = new TextDecoder(label, { fatal: true });
      return { text: decoder.decode(bytes), encoding: decoder.encoding, bom: bom !== undefined && bom === decoder.encoding };
    } catch {
      // A label Node does not know, or bytes that are not what it says: the next guess.
    }
  }
  return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252", bom: false };
}

export const decodeText = (bytes: Uint8Array): string => readText(bytes).text;

/** Each encoding's character → byte, built once: every byte decoded alone and
 *  inverted. Exact for a single-byte encoding; for a multi-byte one it covers
 *  only the bytes that stand alone (ASCII), so anything else is «cannot». */
const byteTables = new Map<string, Map<string, number>>();

function byteTable(encoding: string): Map<string, number> {
  let table = byteTables.get(encoding);
  if (!table) {
    table = new Map();
    const decoder = new TextDecoder(encoding);
    for (let byte = 0; byte <= 0xff; byte += 1) {
      const char = decoder.decode(Uint8Array.of(byte));
      if (char.length === 1 && char !== "�" && !table.has(char)) table.set(char, byte);
    }
    byteTables.set(encoding, table);
  }
  return table;
}

/**
 * Text back to bytes in `encoding` (as `readText` names it), with its mark
 * when it had one — so text read and written untouched is the same bytes.
 * `null` when the text has a character that encoding cannot hold.
 */
export function encodeText(text: string, encoding: string, bom: boolean): Uint8Array | null {
  if (encoding === "utf-8") return Buffer.concat([Buffer.from(bom ? [0xef, 0xbb, 0xbf] : []), Buffer.from(text, "utf8")]);
  if (encoding === "utf-16le" || encoding === "utf-16be") {
    const bytes = Buffer.from(`${bom ? "﻿" : ""}${text}`, "utf16le");
    return encoding === "utf-16be" ? bytes.swap16() : bytes;
  }
  const table = byteTable(encoding);
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const byte = table.get(text[index]!);
    if (byte === undefined) return null;
    out[index] = byte;
  }
  return out;
}
