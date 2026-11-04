import { nativeImage } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { thumbCacheDir, thumbCachePath } from "../paths";
import {
  MEDIA_THUMB_MAX_AGE_MS,
  MEDIA_THUMB_MAX_BYTES,
  MEDIA_THUMB_QUALITY,
  MEDIA_THUMB_VERSION,
  MEDIA_THUMB_WIDTH,
} from "@shared/constants";
import type { MediaAsset } from "@shared/types/media";
import { grabFrame } from "./ffmpeg";

/**
 * On-demand, content-keyed cache of small library thumbnails.
 *
 * It exists to kill the per-tile `<video preload="metadata">` the library grid
 * used to mount: that is a real decoding pipeline per visible tile, and a
 * folder of a few hundred videos would open several hundred of them. A JPEG a
 * few kilobytes wide costs nothing to draw and nothing to keep.
 *
 * Two rules shape everything below:
 *
 * - **Keyed by the file's bytes (path + size + mtime), never by a hash of its
 *   content.** Hashing a 4 GB MP4 to draw a 120 px tile is absurd, and
 *   size+mtime is the very identity `slide_decks` already trusts for its
 *   cheapest cache hit. `MEDIA_THUMB_VERSION` is part of the key so changing
 *   how thumbnails are made invalidates every one of them at once.
 * - **The file name IS the index.** No table, no migration, no row that can
 *   disagree with the disk. Deleting the directory is always safe.
 *
 * Which of `nativeImage`'s two routes does the work matters a great deal —
 * one of them blocks the main thread and the other does not. See
 * `renderViaOsThumbnailer` for the measurements that settled it.
 */

/** Generations allowed to run at once. The fallback route is synchronous
 *  native work on this thread, so this is a limit on *bursts*: four keeps a
 *  scroll responsive while still filling a screenful quickly. */
const MAX_CONCURRENT = 4;
/** A cache hit refreshes the file's mtime only if it is already this stale, so
 *  the startup prune can use mtime as a proxy for "last used" without paying a
 *  write on every single tile that scrolls into view. */
const TOUCH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** Files whose thumbnail could not be produced (a corrupt video, a codec the
 *  OS can't read). Remembered for the process's lifetime so scrolling past
 *  them repeatedly doesn't re-attempt an expensive decode that already failed.
 *  Bounded, because a pathological library shouldn't grow this without end. */
const MAX_REMEMBERED_FAILURES = 2_000;

/** One generation per key, shared by every tile asking for it. It is
 *  abandoned only when ALL of them have walked away: tying it to the first
 *  requester's signal meant one tile scrolling off answered 404 to every other
 *  tile waiting on the same thumbnail, which then kept its icon until it was
 *  remounted. */
type Pending = { promise: Promise<string | null>; controller: AbortController; waiting: number };
const inFlight = new Map<string, Pending>();

function join(pending: Pending, signal: AbortSignal | undefined): Promise<string | null> {
  if (signal?.aborted) return pending.promise;
  pending.waiting += 1;
  signal?.addEventListener(
    "abort",
    () => {
      pending.waiting -= 1;
      if (pending.waiting === 0) pending.controller.abort();
    },
    { once: true },
  );
  return pending.promise;
}
const failed = new Set<string>();
let running = 0;
const waiting: (() => void)[] = [];

function cacheKey(asset: MediaAsset, stat: fs.Stats): string {
  // The path is part of the key on purpose: two unrelated files can easily
  // share a size and an mtime (anything produced by the same batch export),
  // and serving one's thumbnail for the other would be a silent, baffling
  // bug. Two *copies* of the same file legitimately share a key only when
  // their paths also match, which they don't.
  const material = [
    MEDIA_THUMB_VERSION,
    MEDIA_THUMB_WIDTH,
    asset.path,
    stat.size,
    Math.trunc(stat.mtimeMs),
  ].join("|");
  return crypto.createHash("sha1").update(material).digest("hex").slice(0, 32);
}

/**
 * The slot is owned from the moment it is granted, and handed straight from
 * one holder to the next.
 *
 * The previous version incremented `running` in the *waiter*, after its
 * promise resolved — a microtask later than the `release()` that woke it. In
 * that gap `running` read one below the real occupancy, so a fresh `acquire()`
 * landing in it took a slot that was already spoken for and the limit was
 * quietly exceeded. With a synchronous fallback route that means one more
 * blocking decode on the thread serving the projection window than the number
 * that was chosen as safe.
 */
function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waiting.push(resolve);
  });
}

function release(): void {
  const next = waiting.shift();
  // Transfer, don't decrement-then-grant: `running` never dips, so no caller
  // arriving in between can overtake a queued one.
  if (next) next();
  else running -= 1;
}

/**
 * The OS thumbnailer (QuickLook on macOS, the shell's on Windows). Preferred
 * for everything, because it is the only one of the two that does its work off
 * the main thread — measured on this project's own fixtures:
 *
 * | approach                                   | 10× 4K PNG | worst main-thread stall |
 * |--------------------------------------------|-----------|-------------------------|
 * | `createFromPath` + `resize` (synchronous)  |    782 ms | the whole 782 ms        |
 * | `createThumbnailFromPath` (this)           |     35 ms | ~15 ms (idle baseline)  |
 *
 * An 80 ms synchronous stall per large image is a visible stutter in the
 * projection window, which is the one thing this whole plan exists to avoid.
 * As a bonus it also decodes formats `createFromPath` returns empty for (GIF,
 * and by the same route WebP/HEIC).
 *
 * Two traps, both found by measuring rather than by reading the docs:
 *
 * - For a file it cannot parse, it does not fail — it happily returns the
 *   **generic document icon**, at 512×512, ignoring `maxSize`. Left alone,
 *   a corrupt image would show a Finder icon in the middle of the library.
 * - `image.getSize()` reports the size that was *asked for*, not the size that
 *   came back (320×320 for a bitmap that is really 320×180), so it cannot be
 *   used to detect the above. The encoded bytes are the only honest source.
 */
async function renderViaOsThumbnailer(filePath: string): Promise<Buffer | null> {
  // Implemented only on macOS and Windows. Checked up front rather than
  // relying on the rejection, so an unsupported platform doesn't get
  // remembered as "this file is broken".
  if (process.platform !== "darwin" && process.platform !== "win32") return null;

  let image;
  try {
    image = await nativeImage.createThumbnailFromPath(filePath, {
      width: MEDIA_THUMB_WIDTH,
      height: MEDIA_THUMB_WIDTH,
    });
  } catch {
    return null; // Missing/unreadable file — the caller's fallbacks apply.
  }
  if (image.isEmpty()) return null;

  const jpeg = image.toJPEG(MEDIA_THUMB_QUALITY);
  const size = readJpegSize(jpeg);
  // Anything that ignored the constraint we passed is not a thumbnail of this
  // file's content — it is the generic icon described above.
  if (!size || size.width > MEDIA_THUMB_WIDTH || size.height > MEDIA_THUMB_WIDTH) return null;
  return jpeg;
}

/** Decode-and-shrink in-process. Blocks the main thread for the duration, so
 *  it is only ever the fallback: a platform with no OS thumbnailer, or a file
 *  that one declined. */
function renderViaResize(filePath: string): Buffer | null {
  const image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) return null;
  // Never upscale: a 64px icon blown up to 320px is both uglier and bigger
  // than the original, and `object-contain` in the tile handles the rest.
  const { width } = image.getSize();
  const sized = width > MEDIA_THUMB_WIDTH ? image.resize({ width: MEDIA_THUMB_WIDTH, quality: "good" }) : image;
  const jpeg = sized.toJPEG(MEDIA_THUMB_QUALITY);
  return jpeg.length > 0 ? jpeg : null;
}

/** Whether this image file can actually be decoded — by the OS thumbnailer
 *  (which reads GIF, WebP and BMP, and is told apart from its own generic
 *  icon) or, failing that, by `nativeImage` itself (PNG and JPEG). The logo
 *  picker's check: `nativeImage.createFromPath` alone refused every GIF, WebP
 *  and BMP the projector would have shown perfectly well. */
export async function canDecodeImage(filePath: string): Promise<boolean> {
  if (await renderViaOsThumbnailer(filePath)) return true;
  return !nativeImage.createFromPath(filePath).isEmpty();
}

/** Encodes one asset to a JPEG buffer, or null when this kind/platform/file
 *  simply has no thumbnail to offer (which is a normal answer, not an error). */
async function renderThumbnail(asset: MediaAsset): Promise<Buffer | null> {
  // `audio` has nothing to show, and a `ppt` deliberately does not come
  // through here at all: its authoritative thumbnail is the first slide of
  // its converted deck (`worship://deck/<deckId>/1/thumb`), which the tile
  // already receives from `deck:statuses`.
  if (asset.kind !== "image" && asset.kind !== "video") return null;

  const fromOs = await renderViaOsThumbnailer(asset.path);
  if (fromOs) return fromOs;

  // A video never gets decoded in-process to grab a frame: that is exactly the
  // per-tile decoding pipeline this service exists to remove. The OS declines
  // what QuickLook/the shell cannot read (AVI, WMV, MKV…), and those are the
  // very files the media engine plays, so ffmpeg grabs one in its own process.
  if (asset.kind === "video") return grabFrame(asset.path, MEDIA_THUMB_WIDTH);
  return renderViaResize(asset.path);
}

/**
 * Real pixel dimensions of a JPEG, read from its SOF segment. Needed because
 * `NativeImage.getSize()` cannot be trusted for the OS thumbnailer's output
 * (see `renderViaOsThumbnailer`). Returns null for anything that isn't a JPEG
 * whose header we can walk, which the caller treats as "don't use this".
 */
function readJpegSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1]!;
    // Standalone markers (padding, RSTn, SOI) carry no length field.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    // SOF0-SOF15 hold the frame's real dimensions. 0xc4 (DHT), 0xc8 (JPG) and
    // 0xcc (DAC) share the range but are not frame headers.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

async function generate(
  asset: MediaAsset,
  cachePath: string,
  key: string,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  await acquire();
  try {
    // Checked after the wait, not before it: a tile that scrolled off screen
    // while its turn was queued has nothing left to draw, and on the
    // synchronous fallback route generating it anyway is a main-thread stall
    // spent on a thumbnail nobody will see. This is also what bounds the
    // waiting list — a scroll through a folder of 600 retires its own queue
    // instead of leaving it to grind through every tile it passed.
    if (signal?.aborted) return null;
    const buffer = await renderThumbnail(asset);
    if (!buffer || buffer.length === 0) {
      rememberFailure(key);
      return null;
    }

    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
    // Same commit discipline as the deck cache: a reader must never observe a
    // half-written JPEG, and two generations racing on the same key must
    // resolve to one intact file rather than an interleaved one.
    const tmpPath = `${cachePath}.tmp-${crypto.randomUUID()}`;
    try {
      await fs.promises.writeFile(tmpPath, buffer);
      await fs.promises.rename(tmpPath, cachePath);
    } catch (error) {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return cachePath;
  } catch (error) {
    console.warn("[thumbs] generation failed", asset.path, error);
    rememberFailure(key);
    return null;
  } finally {
    release();
    // Hand the event loop back before the next waiter starts. Free insurance
    // on the OS-thumbnailer route; load-bearing on the synchronous fallback,
    // where a burst without a yield is exactly the kind of stall that freezes
    // the projection window.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function rememberFailure(key: string): void {
  // Evict the oldest, rather than emptying the whole set: clearing it meant
  // every file that had already failed became eligible for a fresh (expensive,
  // and still doomed) decode attempt all at once. A `Set` iterates in
  // insertion order, so its first entry is the oldest.
  while (failed.size >= MAX_REMEMBERED_FAILURES) {
    const oldest = failed.values().next();
    if (oldest.done) break;
    failed.delete(oldest.value);
  }
  failed.add(key);
}

/**
 * Path to this asset's cached thumbnail, generating it if needed, or null when
 * there is none to give. Concurrent callers for the same key share one
 * generation — a screenful of tiles asking at once is the normal case, not the
 * exception.
 */
export async function ensureThumbnail(
  asset: MediaAsset,
  signal?: AbortSignal,
): Promise<string | null> {
  if (asset.kind !== "image" && asset.kind !== "video") return null;

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(asset.path);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }

  const key = cacheKey(asset, stat);
  if (failed.has(key)) return null;
  const cachePath = thumbCachePath(key);

  try {
    const cached = await fs.promises.stat(cachePath);
    if (cached.isFile() && cached.size > 0) {
      // Keep it out of the startup prune's way without writing on every hit.
      if (Date.now() - cached.mtimeMs > TOUCH_AFTER_MS) {
        const now = new Date();
        void fs.promises.utimes(cachePath, now, now).catch(() => undefined);
      }
      return cachePath;
    }
  } catch {
    // Not cached yet — fall through and generate it.
  }

  const existing = inFlight.get(key);
  if (existing) return join(existing, signal);

  const controller = new AbortController();
  const pending: Pending = {
    promise: generate(asset, cachePath, key, controller.signal).finally(() => {
      inFlight.delete(key);
    }),
    controller,
    waiting: 0,
  };
  inFlight.set(key, pending);
  return join(pending, signal);
}

/**
 * Deletes thumbnails untouched for `maxAgeMs`, then trims whatever is left back
 * under `maxBytes`, oldest first.
 *
 * Because `size + mtime` is part of the key, editing a source file orphans its
 * old thumbnail permanently — without this the directory would only ever grow.
 * The age rule alone was not actually a bound, though: a library that keeps
 * being browsed keeps every one of its thumbnails young, so the size pass is
 * what makes this a cache rather than an archive.
 *
 * Best-effort and chunked: losing a thumbnail costs one regeneration, so
 * nothing here is worth failing startup over, and nothing here is worth a
 * stalled frame either.
 */
export async function pruneThumbCache(
  maxAgeMs: number = MEDIA_THUMB_MAX_AGE_MS,
  maxBytes: number = MEDIA_THUMB_MAX_BYTES,
): Promise<void> {
  const cutoff = Date.now() - maxAgeMs;
  let shards: fs.Dirent[];
  try {
    shards = await fs.promises.readdir(thumbCacheDir, { withFileTypes: true });
  } catch {
    return; // Nothing cached yet.
  }

  const survivors: { filePath: string; size: number; mtimeMs: number }[] = [];
  let totalBytes = 0;

  for (const shard of shards) {
    if (!shard.isDirectory()) continue;
    const shardDir = path.join(thumbCacheDir, shard.name);
    let entries: string[];
    try {
      entries = await fs.promises.readdir(shardDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const filePath = path.join(shardDir, entry);
      try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) continue;
        // `.tmp-*` leftovers from a crash mid-write are collected by the same
        // age rule; a live one is seconds old and safely below the cutoff.
        if (stat.mtimeMs < cutoff) {
          await fs.promises.unlink(filePath);
          continue;
        }
        survivors.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
        totalBytes += stat.size;
      } catch {
        // Vanished or unreadable — either way, not this function's problem.
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
  }

  if (totalBytes <= maxBytes) return;

  // Oldest first — the same "mtime is a good enough proxy for last used"
  // assumption `TOUCH_AFTER_MS` is built on.
  survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const survivor of survivors) {
    if (totalBytes <= maxBytes) break;
    try {
      await fs.promises.unlink(survivor.filePath);
      totalBytes -= survivor.size;
    } catch {
      // Already gone; nothing to reclaim and nothing to report.
    }
  }
}
