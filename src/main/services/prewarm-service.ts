import { randomUUID } from "node:crypto";
import type { DeckStatusSummary, PrewarmProgress } from "@shared/types/deck";
import { slideModelUrl, slideThumbUrl } from "@shared/urls";
import { broadcast } from "./broadcast";
import { getSlidesRepo } from "./repos";
import { cacheUsage, cancelBackgroundJobs, prepareDeck } from "../slides/deck-service";

/** How full the cache is allowed to get from prewarming alone before a batch
 *  stops enqueueing more — converting 600 decks just to immediately evict
 *  500 of them wastes minutes of CPU and a pile of disk writes for nothing.
 *  Interactive conversions (the operator opening something for real) are
 *  never subject to this — only a background batch checks it, between
 *  assets. */
const CACHE_BUDGET_FRACTION = 0.8;

function cacheOverBudget(): boolean {
  const { bytesOnDisk, maxBytes } = cacheUsage();
  return bytesOnDisk >= maxBytes * CACHE_BUDGET_FRACTION;
}

type BatchState = { jobId: string; canceled: boolean };
const activeBatches = new Map<string, BatchState>();

/** One assetId → its deck's status and first-slide thumbnail, for assets that
 *  have a deck row at all (an asset never opened has no row and no entry
 *  here). One `IN (...)` query for the whole grid instead of a `getDeck()`
 *  (SELECT + `existsSync`) per asset.
 *
 *  The `thumbUrl` is what replaced the library grid's old `useDeckThumb` hook,
 *  which fired one `deck:get` per PPT tile — hundreds of round-trips to draw
 *  one screen. It is only ever non-null for a `ready` deck: a deck still
 *  converting has no slide 1 to point at, and asserting a URL that 404s would
 *  make the tile flash a broken image on its way to being right. */
export function deckStatuses(assetIds: readonly number[]): Record<number, DeckStatusSummary> {
  const statuses = getSlidesRepo().statusesByAsset(assetIds);
  const result: Record<number, DeckStatusSummary> = {};
  for (const [assetId, { deckId, status, drawnFromModel }] of statuses) {
    // A `stale` row (older converter) still has every image on disk — it is
    // reconverted for what it may be missing, not because its slides are bad.
    const hasImages = status === "ready" || status === "stale";
    // A deck drawn from its model has no image to point at: the tile draws
    // its first slide's model instead (and only a current one: a stale model
    // may not be what this build draws).
    result[assetId] = drawnFromModel
      ? { status, thumbUrl: null, modelUrl: status === "ready" ? slideModelUrl(deckId, 1) : null }
      : { status, thumbUrl: hasImages ? slideThumbUrl(deckId, 1) : null, modelUrl: null };
  }
  return result;
}

/** Starts one tracked background batch over `assetIds` — already-ready decks
 *  are counted as `skipped` and never touched. Returns immediately with the
 *  real total (post-skip); the conversions themselves run asynchronously,
 *  reported through `prewarm-progress`. */
export function startPrewarmBatch(assetIds: readonly number[], label: string): { jobId: string; total: number } {
  const jobId = randomUUID();
  const state: BatchState = { jobId, canceled: false };
  activeBatches.set(jobId, state);

  const statuses = getSlidesRepo().statusesByAsset(assetIds);
  const pending = assetIds.filter((id) => statuses.get(id)?.status !== "ready");
  const progress: PrewarmProgress = {
    jobId,
    label,
    total: pending.length,
    done: 0,
    skipped: assetIds.length - pending.length,
    failed: 0,
    currentAssetId: null,
    status: "running",
  };
  broadcast("prewarm-progress", progress);

  void runBatch(state, pending, progress);
  return { jobId, total: pending.length };
}

async function runBatch(state: BatchState, assetIds: number[], progress: PrewarmProgress): Promise<void> {
  for (let i = 0; i < assetIds.length; i++) {
    if (state.canceled) {
      broadcast("prewarm-progress", { ...progress, currentAssetId: null, status: "canceled" });
      activeBatches.delete(state.jobId);
      return;
    }
    if (cacheOverBudget()) {
      broadcast("prewarm-progress", { ...progress, currentAssetId: null, status: "cache-full" });
      activeBatches.delete(state.jobId);
      return;
    }

    const assetId = assetIds[i]!;
    progress.currentAssetId = assetId;
    broadcast("prewarm-progress", { ...progress });
    try {
      await prepareDeck(assetId, { priority: "background", scope: "batch", prewarmJobId: state.jobId });
      progress.done += 1;
    } catch {
      // A canceled or genuinely failed conversion either way just doesn't
      // count toward "done" — the operator sees it in `failed`, and a
      // per-tile Callout (driven by `deck-progress`, unaffected by this) still
      // shows the real error if they open that deck directly afterward.
      progress.failed += 1;
    }
    broadcast("prewarm-progress", { ...progress });
  }

  broadcast("prewarm-progress", { ...progress, currentAssetId: null, status: "done" });
  activeBatches.delete(state.jobId);
}

/** On quit: every batch stops before its next asset. */
export function cancelAllPrewarmBatches(): void {
  for (const state of activeBatches.values()) state.canceled = true;
}

/** Stops enqueueing further assets in the batch and aborts whichever one of
 *  its jobs is currently in flight (queued-but-not-started ones tagged with
 *  this `jobId` are also dropped, via `cancelBackgroundJobs`). */
export function cancelPrewarmBatch(jobId: string): void {
  const state = activeBatches.get(jobId);
  if (state) state.canceled = true;
  cancelBackgroundJobs(jobId);
}
