import { useEffect, useReducer, useSyncExternalStore } from "react";
import type { MediaAsset } from "@shared/types/media";
import { api } from "@renderer/lib/api";

/** Bounded: a long service browsing a large library would otherwise keep every
 *  asset it ever looked at alive for the rest of the session. Insertion-ordered
 *  like every `Map`, so the first key is the oldest. */
const MAX_CACHED = 500;
const cache = new Map<number, MediaAsset | null>();

/**
 * How many mounted consumers are reading each id right now.
 *
 * The cap alone was not safe. This cache is read straight from the map
 * **during render** while the fetching effect only re-runs when `id` changes —
 * so an entry evicted while its consumer stayed mounted made that consumer
 * render `null` forever: a schedule row that silently lost its name and had no
 * way left to ask for it again. It takes a library bigger than the cap for
 * that to happen, and this operator's is: 1498 assets against a cap of 500.
 *
 * A reference count is what makes it impossible rather than unlikely: what is
 * on screen is never a candidate for eviction, whatever the cap says. Kept in
 * its own map rather than as a field of the entry because it outlives the
 * entry — `forgetAllMediaAssets()` empties the cache while every consumer is
 * still mounted and about to refetch.
 */
const refCounts = new Map<number, number>();

function retain(id: number): void {
  refCounts.set(id, (refCounts.get(id) ?? 0) + 1);
  // Mounting a consumer is the one moment worth counting as "used": it makes
  // eviction least-recently-USED rather than oldest-inserted, without the
  // impurity of touching the map from a render.
  touch(id);
}

function release(id: number): void {
  const next = (refCounts.get(id) ?? 0) - 1;
  if (next > 0) refCounts.set(id, next);
  else refCounts.delete(id);
}

/** Moves an id back to the end of the insertion order — `Map` has no other
 *  way to say "this one is the newest". */
function touch(id: number): void {
  if (!cache.has(id)) return;
  const asset = cache.get(id) ?? null;
  cache.delete(id);
  cache.set(id, asset);
}

/**
 * Bumped whenever an entry is invalidated, and subscribed to by every mounted
 * consumer.
 *
 * Deleting from the map alone was not enough: the fetching effect below only
 * re-runs when `id` changes, so a component already showing asset 7 kept
 * showing the stale copy until it happened to remount. That is exactly the
 * case a relocate creates — the operator repairs a missing file from the very
 * panel that is displaying "file not found", and the panel has to
 * stop saying it.
 */
let generation = 0;
const listeners = new Set<() => void>();

function subscribeToInvalidations(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function remember(id: number, asset: MediaAsset | null): void {
  if (!cache.has(id)) makeRoom();
  cache.set(id, asset);
}

/** Drops the least recently used entries that nothing is reading, until the
 *  cap has room for one more.
 *
 *  It can finish without having made any: when every remaining entry is in
 *  use, the cap is what gives way, not the entry someone is looking at. That
 *  is bounded by what can be on screen at once, not by the size of the
 *  library — a virtualized grid mounts tens of tiles, not hundreds. */
function makeRoom(): void {
  if (cache.size < MAX_CACHED) return;
  for (const id of cache.keys()) {
    if ((refCounts.get(id) ?? 0) > 0) continue;
    cache.delete(id);
    if (cache.size < MAX_CACHED) return;
  }
}

/**
 * The `library:get` in flight for each id, shared by every consumer that asks
 * meanwhile: a schedule row mounts three (label, icon and badge, thumbnail),
 * and each one fired its own request at startup and on every
 * `library-changed` (2026-11-15 audit, R29). Dropped when it settles, so a
 * failure is not kept here, and dropped by an invalidation, so a consumer
 * re-asking after a change never joins a request from before it.
 */
const inFlight = new Map<number, Promise<void>>();

function fetchAsset(id: number): Promise<void> {
  const existing = inFlight.get(id);
  if (existing) return existing;
  const request: Promise<void> = api.library
    .get(id)
    .catch((error: unknown) => {
      // Without this the id stayed uncached, so every subsequent render
      // fired the same failing request again: a rejection storm behind a
      // schedule row that simply has no name to show. Remembered as "no
      // asset", which is what the row renders for a missing one anyway;
      // `forgetMediaAsset` is how a later refresh gets a second chance.
      console.error(`[media] could not resolve asset ${id}`, error);
      return null;
    })
    .then((asset) => {
      // Superseded by an invalidation: its answer may predate the change.
      if (inFlight.get(id) !== request) return;
      inFlight.delete(id);
      remember(id, asset);
    });
  inFlight.set(id, request);
  return request;
}

/** Small id -> MediaAsset cache so playlist rows (which only store a
 *  mediaAssetId) can render a name/badge without threading the whole library
 *  list through every consumer.
 *
 * The return value is always read straight from `cache` during render —
 * never from a `useState` set only inside the effect. That state would lag
 * one render behind an id change (React doesn't run effects until after the
 * render commits), so a consumer switching from asset A to asset B would
 * momentarily see A's object under B's id. `usePreviewContent` builds a
 * `{kind:"deck", assetId}` straight from this return value, so that stale
 * tick was enough to fire a real `ensure()` conversion request for the WRONG
 * asset (e.g. a live video, mistaken for a still-loading PPT). */
export function useMediaAsset(id: number | null): MediaAsset | null {
  const [, forceRerender] = useReducer((c: number) => c + 1, 0);
  const invalidation = useSyncExternalStore(subscribeToInvalidations, () => generation);

  // Declared before the fetching effect so a consumer's id is protected from
  // eviction from the moment it mounts, including by its own fetch below.
  // Keyed on `id` alone: an invalidation must not churn the count, it only
  // empties the cache these consumers are about to refill.
  useEffect(() => {
    if (id === null) return;
    retain(id);
    return () => release(id);
  }, [id]);

  useEffect(() => {
    if (id === null || cache.has(id)) return;
    let cancelled = false;
    void fetchAsset(id).then(() => {
      if (!cancelled) forceRerender();
    });
    return () => {
      cancelled = true;
    };
    // `invalidation` is a dependency, not an unused value: it is what makes a
    // forgotten id be fetched again by the consumers that are already mounted.
  }, [id, invalidation]);

  return id !== null ? (cache.get(id) ?? null) : null;
}

/** Whatever this cache already knows about an id, for the plain functions
 *  outside React (`effects/*`) that need a file's name for a message. Never
 *  fetches: a toast is not worth a round-trip, and anything that is actually
 *  live has already been resolved by the header and the media panel. */
export function getCachedMediaAsset(id: number | null): MediaAsset | null {
  return id !== null ? (cache.get(id) ?? null) : null;
}

/** Drops an asset from the module-level cache — because it was deleted, so a
 *  stale name/thumb stops rendering for a schedule row that no longer has one,
 *  or because its row changed underneath (a relocate). Every mounted consumer
 *  re-renders and re-fetches; see `generation`. */
export function forgetMediaAsset(id: number): void {
  cache.delete(id);
  inFlight.delete(id);
  invalidate();
}

/**
 * Drops everything, for the events that say "the library changed" without
 * saying which rows — the background missing-file sweep above all.
 *
 * Without this the cache was a second, stale copy of the library that nothing
 * ever refreshed: a file that went missing mid-session stayed cached as
 * present, so the preview of a schedule row kept offering content whose file
 * was gone, and the "file not found" panel (with its Locate…
 * button) never appeared until the row happened to remount. Refetching is
 * lazy and per-id, so the cost is one `library:get` for each row actually on
 * screen, on an event that fires on an import, a sweep that found a change,
 * or a relocate — not in any loop.
 */
export function forgetAllMediaAssets(): void {
  cache.clear();
  inFlight.clear();
  invalidate();
}

function invalidate(): void {
  generation += 1;
  for (const listener of listeners) listener();
}
