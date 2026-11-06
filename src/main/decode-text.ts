import { TextDecoder } from "node:util";

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
export function decodeText(bytes: Uint8Array): string {
  const bom =
    bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : undefined;
  // The declaration is ASCII in every encoding it can name but UTF-16's, so
  // reading the head as latin1 is safe.
  const declared =
    bom ?? /encoding\s*=\s*["']([\w.:-]+)["']/i.exec(Buffer.from(bytes.subarray(0, 200)).toString("latin1"))?.[1];
  for (const label of [declared, "utf-8"]) {
    if (!label) continue;
    try {
      // A UTF-8 or UTF-16 mark is dropped by the decoder itself.
      return new TextDecoder(label, { fatal: true }).decode(bytes);
    } catch {
      // A label Node does not know, or bytes that are not what it says: the next guess.
    }
  }
  return new TextDecoder("windows-1252").decode(bytes);
}
