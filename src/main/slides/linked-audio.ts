import fs from "node:fs";
import path from "node:path";
import { AUDIO_EXT, containerKind } from "./pptx-metadata";
import { readZipEntries } from "./zip-reader";
import { readBinaryExternalPaths } from "./ppt-binary";

/**
 * Old church hymnal decks (`.pps`/`.ppt`) rarely embed their soundtrack —
 * they point at an external `.mp3` that lived next to the file on whoever's
 * Windows machine made it. So it is resolved straight from the original file,
 * once, against whatever now sits beside it.
 *
 * Four rules, in order of confidence:
 *  1. The file's own hint — the external link it recorded, matched by
 *     *basename* against the deck's folder (the recorded path is someone
 *     else's Windows machine; only the filename can still be right).
 *  2. The PowerPoint convention: `<same base name>.<audio ext>`.
 *  3. Partial containment between a loose comparison key of the deck's name
 *     and each candidate's — the deck and its audio share *some* substring
 *     of their title (see `comparisonKey`). There is deliberately no "only
 *     audio file in the folder" fallback anymore: a folder holding one deck
 *     with audio and a sibling deck without one used to hand that unrelated
 *     audio to the silent deck just because it was alone in the folder.
 *  4. `null` — nothing matched, let the operator assign it by hand.
 */
/**
 * Directory listings, cached for a couple of seconds.
 *
 * The parameterized `dirCache` this replaces was never passed by any caller,
 * so a first pass over a linked folder of 600 decks re-listed the SAME
 * 1200-entry directory 600 times — one synchronous `readdirSync` per deck, on
 * the thread that serves the projection window. A batch is the only thing
 * fast enough to hit this window, which is the point: the TTL is far shorter
 * than the time it takes a person to drop an `.mp3` into the folder and click
 * a deck, so a newly-added file is still found on the next real open.
 */
const DIR_CACHE_TTL_MS = 2_000;
/** A hard cap as well as a TTL: a sweep across many folders must not turn
 *  this into a second copy of the library in memory. */
const DIR_CACHE_MAX = 32;
const dirCache = new Map<string, { at: number; entries: string[] }>();

function listAudioDir(dir: string): string[] | null {
  const now = Date.now();
  const hit = dirCache.get(dir);
  if (hit && now - hit.at < DIR_CACHE_TTL_MS) return hit.entries;

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    dirCache.delete(dir);
    return null;
  }
  // Map iteration is insertion-ordered, so the first key is the oldest.
  if (dirCache.size >= DIR_CACHE_MAX && !dirCache.has(dir)) {
    const oldest = dirCache.keys().next().value;
    if (oldest !== undefined) dirCache.delete(oldest);
  }
  dirCache.set(dir, { at: now, entries });
  return entries;
}

export function resolveLinkedAudio(presentationPath: string): string | null {
  const dir = path.dirname(presentationPath);
  const entries = listAudioDir(dir);
  if (!entries) return null;
  const audioFiles = entries.filter((name) => AUDIO_EXT.has(extOf(name)));
  if (audioFiles.length === 0) return null;

  const byNormalizedName = new Map(audioFiles.map((name) => [normalize(name), name]));

  const hint = extractAudioHintBasename(presentationPath);
  if (hint) {
    const match = byNormalizedName.get(normalize(hint));
    if (match) return path.join(dir, match);
  }

  const base = path.basename(presentationPath, path.extname(presentationPath));
  for (const ext of AUDIO_EXT) {
    const match = byNormalizedName.get(normalize(`${base}.${ext}`));
    if (match) return path.join(dir, match);
  }

  const byPartialName = matchByPartialName(base, audioFiles);
  if (byPartialName) return path.join(dir, byPartialName);

  return null;
}

const MIN_MATCH_CHARS = 4;

/** Rule 3: the deck and one of the folder's audio files share *some*
 *  substring of their title, once both are reduced to a loose comparison
 *  key. Ties resolve to the exact-key match first, then to the longest key
 *  (the most specific title); a tie between two equally-long, distinct keys
 *  is genuinely ambiguous and returns `null` rather than guessing. */
function matchByPartialName(deckBase: string, audioFiles: string[]): string | null {
  const deckKey = comparisonKey(deckBase);
  if (deckKey.length < MIN_MATCH_CHARS) return null;

  const candidates: { name: string; key: string }[] = [];
  for (const name of audioFiles) {
    const key = comparisonKey(path.basename(name, path.extname(name)));
    if (key.length < MIN_MATCH_CHARS) continue;
    if (deckKey.includes(key) || key.includes(deckKey)) candidates.push({ name, key });
  }
  if (candidates.length === 0) return null;

  const exact = candidates.find((c) => c.key === deckKey);
  if (exact) return exact.name;

  candidates.sort((a, b) => b.key.length - a.key.length);
  const [longest, runnerUp] = candidates;
  if (runnerUp && runnerUp.key.length === longest!.key.length && runnerUp.key !== longest!.key) {
    return null;
  }
  return longest!.name;
}

/** Loose comparison key: NFC → strip diacritics → lowercase → alphanumerics
 *  only. `"001 Cantad alegres al Señor"` → `"001cantadalegresalsenor"`.
 *  Unlike `normalize()` below, which compares whole file names for an exact
 *  match, this compares the *content* of two names across whatever
 *  separators (spaces, dashes, numbering) happen to differ between them. */
function comparisonKey(base: string): string {
  return base
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function extOf(fileName: string): string {
  return path.extname(fileName).replace(/^\./, "").toLowerCase();
}

/** File names round-trip differently across filesystems (macOS favors NFD,
 *  Windows/the .pps favor NFC) — comparing raw bytes misses the exact match
 *  the church actually has on disk. */
function normalize(fileName: string): string {
  return fileName.normalize("NFC").toLowerCase();
}

/** Only the basename of whatever external audio path the deck itself recorded
 *  — never the path, which points at a Windows machine that isn't this one. */
function extractAudioHintBasename(presentationPath: string): string | null {
  const kind = containerKind(presentationPath);
  if (kind === "binary") return extractHintFromBinary(presentationPath);
  if (kind === "ooxml") return extractHintFromOoxml(presentationPath);
  return null;
}

const AUDIO_EXT_PATTERN = [...AUDIO_EXT].join("|");
// A run of printable characters ending in a known audio extension — loose on
// purpose, this is a hint to look up by basename, never a path we open.
const AUDIO_NAME_RE = new RegExp(`[^\\\\/:*?"<>|\\x00-\\x1f]{1,240}\\.(?:${AUDIO_EXT_PATTERN})`, "i");

/** Read in bounded chunks, not the whole file: a compound-file `.pps` can
 *  carry tens of MB of embedded media, and the hint this is looking for is
 *  at most 240 characters — materializing the entire file as two full-size
 *  strings (`utf16le` + `latin1`) was allocating roughly 3x the file's size
 *  in memory, synchronously, on the main thread, for every deck that needed
 *  this resolved. */
const HINT_SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
/** Overlap between consecutive chunks, comfortably larger than the longest
 *  possible hint at 2 bytes/char (UTF-16LE) — a hint straddling a chunk
 *  boundary still lands whole inside the next chunk's read. */
const HINT_SCAN_OVERLAP_BYTES = 512;

/** Legacy `.ppt`/`.pps` (OLE2) store their linked-media path as a UTF-16LE
 *  string somewhere in the compound file — there's no structured record
 *  worth parsing for a hint this soft, so scan the raw bytes both as
 *  UTF-16LE and Windows-1252 text, in bounded chunks rather than all at once. */
function extractHintFromBinary(filePath: string): string | null {
  // The record that holds the link, when the file has one: milliseconds,
  // where the scan below is most of a second for a hymn.
  const recorded = readBinaryExternalPaths(filePath)?.find((target) => AUDIO_EXT.has(extOf(target)));
  if (recorded) return path.win32.basename(recorded);

  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(HINT_SCAN_CHUNK_BYTES);
    let offset = 0;
    while (offset < size) {
      const length = Math.min(HINT_SCAN_CHUNK_BYTES, size - offset);
      const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
      if (bytesRead <= 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      for (const encoding of ["utf16le", "latin1"] as const) {
        const text = chunk.toString(encoding);
        const match = AUDIO_NAME_RE.exec(text);
        if (match) return path.win32.basename(match[0]);
      }
      if (offset + bytesRead >= size) break;
      offset += Math.max(bytesRead - HINT_SCAN_OVERLAP_BYTES, 1);
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Modern `.pptx`/`.ppsx` link external audio via a `Relationship` with
 *  `TargetMode="External"` in a slide's `_rels` part. Read as text, not
 *  through the full XML parser: this is a best-effort hint, and a relaxed
 *  attribute-order-agnostic regex is enough to find it. */
function extractHintFromOoxml(filePath: string): string | null {
  let entries;
  try {
    // By offset, never the whole archive: this runs from
    // `MediaRepo.ensureLinkedAudio`, i.e. on a deck load, and a `.pptx`'s
    // `_rels` parts are a few KB inside what can be hundreds of MB of media.
    entries = readZipEntries(
      filePath,
      (name) => name.includes("_rels/") && name.endsWith(".rels"),
    );
  } catch {
    return null;
  }
  for (const [name, data] of Object.entries(entries)) {
    if (!name.includes("slides/_rels")) continue;
    const xml = Buffer.from(data).toString("utf8");
    for (const relMatch of xml.matchAll(/<Relationship\b[^>]*\/>/gi)) {
      const tag = relMatch[0];
      if (!/TargetMode\s*=\s*"External"/i.test(tag)) continue;
      const targetMatch = /Target\s*=\s*"([^"]+)"/i.exec(tag);
      if (!targetMatch) continue;
      const target = targetMatch[1]!;
      if (!AUDIO_EXT.has(extOf(target))) continue;
      return path.win32.basename(safeDecode(target));
    }
  }
  return null;
}

/** A link with a stray `%`, or a Latin-1 escape such as `%F1` («ñ» the way old
 *  Office wrote it), is not valid UTF-8 percent-encoding and makes
 *  `decodeURIComponent` throw — which, uncaught on the deck's open path, made
 *  that presentation impossible to open again. The raw text is the better
 *  guess. */
function safeDecode(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}
