import { nativeImage } from "electron";
import crypto from "node:crypto";
import { renameWithRetry } from "../fs-retry";
import fs from "node:fs";
import path from "node:path";
import { thumbCacheDir, thumbCachePath } from "../paths";
import { MEDIA_THUMB_MAX_AGE_MS, MEDIA_THUMB_MAX_BYTES, MEDIA_THUMB_VERSION, MEDIA_THUMB_WIDTH } from "@shared/constants";
import type { MediaAsset } from "@shared/types/media";
import { grabFrame, inspectorWorks } from "./engine-inspect";
import { ThumbSlots, type Turn } from "./thumb-slots";

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
 * The media engine draws every one, photos and videos, on every system (owner, 2026-11-18): each in a process of its
 * own (`engine-inspect.ts`), so nothing here decodes on main. Before, Linux decoded photos on main with `nativeImage`
 * (a 12 MP photo held it 107 to 160 ms and came out lying down, R8 of the 2.10.0 audit) and macOS and Windows asked
 * the OS thumbnailer, which could not read AVI, WMV or MKV. With no engine (Linux without libmpv) there is none.
 */

/** Generations allowed to run at once: each is an engine process, so this is a limit on *bursts*. Four fills a
 *  screenful quickly without starting a process per tile. */
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
type Pending = { promise: Promise<string | null>; controller: AbortController; waiting: number; turn: Turn };
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
/** Newest ask first (`ThumbSlots`): what is on screen before what was scrolled past. */
const slots = new ThumbSlots(MAX_CONCURRENT);

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

/** Whether this image file can actually be decoded: the logo picker's check. The engine, like the thumbnails; where
 *  it cannot start (Linux without libmpv), `nativeImage`, once per logo picked, or no logo would ever pass. */
export async function canDecodeImage(filePath: string): Promise<boolean> {
  if (await grabFrame(filePath, 16, 0)) return true;
  return !inspectorWorks() && !nativeImage.createFromPath(filePath).isEmpty();
}

/** Encodes one asset to a JPEG buffer, or null when this kind/platform/file
 *  simply has no thumbnail to offer (which is a normal answer, not an error). */
async function renderThumbnail(asset: MediaAsset): Promise<Buffer | null> {
  // `audio` has nothing to show, and a `ppt` deliberately does not come
  // through here at all: its authoritative thumbnail is the first slide of
  // its converted deck (`worship://deck/<deckId>/1/thumb`), which the tile
  // already receives from `deck:statuses`.
  if (asset.kind === "image") return grabFrame(asset.path, MEDIA_THUMB_WIDTH, 0);
  if (asset.kind !== "video") return null;
  // One second in, past the black most clips open on; from the start when that found nothing (a clip shorter than
  // that, or an MPEG-TS whose seek decodes no picture).
  return (await grabFrame(asset.path, MEDIA_THUMB_WIDTH, 1)) ?? grabFrame(asset.path, MEDIA_THUMB_WIDTH, 0);
}

async function generate(
  asset: MediaAsset,
  cachePath: string,
  key: string,
  signal: AbortSignal | undefined,
  turn: Turn,
): Promise<string | null> {
  await slots.acquire(turn);
  try {
    // Checked after the wait, not before it: a tile that walked away while its
    // turn was queued has nothing left to draw. Electron 44 never aborts a
    // `protocol.handle` request's signal, so a scroll does not retire its own
    // queue; `ThumbSlots` serves the newest ask first instead.
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
      await renameWithRetry(tmpPath, cachePath);
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
    slots.release();
    // Hand the event loop back before the next waiter starts: free insurance
    // against a burst of encodes, the one part of a thumbnail done on main.
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
  if (existing) {
    // A tile back on screen while its generation still waits: it joins the newest ask.
    slots.bump(existing.turn);
    return join(existing, signal);
  }

  const controller = new AbortController();
  const turn: Turn = { at: Date.now() };
  const pending: Pending = {
    promise: generate(asset, cachePath, key, controller.signal, turn).finally(() => {
      inFlight.delete(key);
    }),
    controller,
    waiting: 0,
    turn,
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
