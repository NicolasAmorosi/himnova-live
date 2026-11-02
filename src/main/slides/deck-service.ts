import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { screen } from "electron";
import {
  SLIDES_CONVERTER_VERSION,
  SLIDES_MAX_RENDER_WIDTH,
  SLIDES_MIN_ADVANCE_MS,
  SLIDES_MIN_RENDER_WIDTH,
  SLIDES_NATIVE_VERSION,
  SLIDES_MODEL_VERSION,
} from "@shared/constants";
import type { DeckDTO, DeckProgress } from "@shared/types/deck";
import type { SlideTransition } from "@shared/types/transition";
import { deckCacheDir, slidesCacheDir, slidesTempDir, sofficeProfileDir } from "../paths";
import { getMediaRepo, getSettingsRepo, getSlidesRepo } from "../services/repos";
import { broadcast } from "../services/broadcast";
import type { DeckRow, NewAudio, NewSlide, NewVideo } from "../db/repositories/slides.repo";
import { SlideError, isSlideError } from "./errors";
import {
  cachedSofficeError,
  convertBatchToPdf,
  convertBatchToPptx,
  convertTimeoutFor,
  convertTimeoutForBatch,
  convertToPdf,
  convertToPptx,
  killRunningSoffice,
  locateSoffice,
  reapOrphanedSoffice,
  requireSoffice,
  resetSofficeProfile,
  warmProfile,
} from "./libreoffice";
import {
  containerKind,
  extractAudioParts,
  placeAudio,
  extractVideoParts,
  readPresentationMeta,
  type PresentationMeta,
} from "./pptx-metadata";
import { readBinaryDeck, readBinarySlideTimings, type BinaryDeck } from "./ppt-binary";
import { encodeSlideLayers } from "./native-deck";
import { readPptx, type PptxRead } from "./pptx-deck";
import { rasterizePdf, shutdownRasterizer } from "./rasterizer";
import { hashFile } from "../media/content-hash";
import { healDeckClips, isEngineClip, revertPlayableCopies } from "../media/deck-clips";
import { removeQuietly, renameWithRetry } from "../fs-retry";
import { mt } from "../i18n";

// ---------------------------------------------------------------------------
// Render target
// ---------------------------------------------------------------------------

export type RenderTarget = {
  width: number;
  format: "webp" | "png";
  quality: number;
};

export function resolveRenderTarget(): RenderTarget {
  const settings = getSettingsRepo();
  const configuredMax = settings.get("slides.maxRenderWidth");
  const format = settings.get("slides.imageFormat");

  let physicalWidth = configuredMax;
  try {
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const preferredId = settings.get("projection.displayId");
    const preferred =
      preferredId !== null ? displays.find((d) => d.id === preferredId) : undefined;
    const target = preferred ?? displays.find((d) => d.id !== primary.id) ?? primary;
    physicalWidth = Math.round(target.bounds.width * target.scaleFactor);
  } catch {
    // screen isn't available before app.whenReady; the configured default is fine.
  }

  const width = Math.min(
    SLIDES_MAX_RENDER_WIDTH,
    Math.max(SLIDES_MIN_RENDER_WIDTH, Math.min(physicalWidth, configuredMax)),
  );
  return { width, format, quality: format === "webp" ? 0.92 : 1 };
}

/** Only re-render when the cached image is meaningfully smaller than the
 *  target — upscaling a 1920 image by 25% is invisible on a projector and not
 *  worth a multi-minute reconversion five minutes before a service. */
function needsRerender(cachedWidth: number, target: RenderTarget): boolean {
  return cachedWidth < target.width * 0.75;
}

function assertFreeSpace(sourceSize: number): void {
  try {
    const stats = fs.statfsSync(slidesCacheDir);
    const free = stats.bavail * stats.bsize;
    const required = Math.max(500 * 1024 * 1024, sourceSize * 6);
    if (free < required) {
      throw new SlideError(
        "DISK_FULL",
        mt("slides.diskFull"),
      );
    }
  } catch (error) {
    if (isSlideError(error)) throw error;
    // statfsSync isn't available everywhere; not a reason to block.
  }
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/** Progress is a push, and only a push. The last value per asset used to be
 *  kept in a map here so `deck:progress` could be asked for it — a channel
 *  with no consumer anywhere in the renderer, which left this process holding
 *  a write-only map. The renderer's deck store is fed by `deck-progress` and
 *  is the only place that value is read. */
function emitProgress(next: DeckProgress): void {
  broadcast("deck-progress", next);
}

/** Per-page progress, for the ONE deck the operator is waiting on.
 *
 *  A background prewarm deliberately gets no per-page events: a folder of 600
 *  decks at ~30 slides each is ~18.000 IPC messages, every one of them a
 *  `set()` in the renderer's deck store that clones a record holding an entry
 *  per deck seen so far — quadratic work, during a service, for a number
 *  nobody is reading tile by tile. The aggregate `prewarm-progress` channel
 *  exists precisely to cover that case, and it only helps if the per-item
 *  channel stays quiet. State transitions (converting/ready/failed) are still
 *  emitted for every job, background included: that is what a tile's badge and
 *  its skeleton are driven by. */
function emitPageProgress(job: Job, next: DeckProgress): void {
  if (job.priority === "background") return;
  emitProgress(next);
}

// ---------------------------------------------------------------------------
// Queue — one conversion at a time, two priority lanes
// ---------------------------------------------------------------------------

/** `interactive` is anything the operator is waiting on right now (a preview,
 *  GO LIVE); `background` is a prewarm — an explicit add, a visible tile, or
 *  a "Prepare folder" batch. Exactly one conversion runs at a time either
 *  way (see the comment on `pump`), but an interactive job always jumps the
 *  queue ahead of background work, and can soft-preempt a background job
 *  already running. */
export type JobPriority = "interactive" | "background";
/** Why a background job was enqueued. Two jobs of it: it lets
 *  `setVisiblePrewarm` replace only its own kind of job and a batch cancel
 *  touch only its own jobId — and it *orders* background work, through
 *  `BACKGROUND_LANES` below. */
export type PrewarmScope = "program" | "explicit" | "visible" | "batch";

/** Background lanes, drained in this order.
 *
 *  - `program`: a deck sitting in the order of service. The operator put it
 *    there, so it is the background work most likely to be needed next — it
 *    must not wait behind 600 decks of a "Prepare folder" batch.
 *  - `explicit`: a file just added to the library (`+`, drag & drop).
 *  - `visible`: a tile currently on screen in the library grid.
 *  - `batch`: a whole folder/view being prepared on purpose.
 *
 *  Separate FIFO lanes rather than a priority field with a comparator: the
 *  ordering is then a property of the data structure, O(1), and stable within
 *  a lane — nobody can accidentally make it unstable later. */
const BACKGROUND_LANES = ["program", "explicit", "visible", "batch"] as const;

export type PrepareOptions = {
  force?: boolean;
  priority?: JobPriority;
  scope?: PrewarmScope;
  /** Tags a background job as belonging to one "Prepare folder/view" batch,
   *  so `cancelBackgroundJobs(jobId)` can cancel just that batch. */
  prewarmJobId?: string;
};

type Job = {
  assetId: number;
  force: boolean;
  priority: JobPriority;
  scope: PrewarmScope | null;
  prewarmJobId: string | undefined;
  controller: AbortController;
  promise: Promise<DeckDTO>;
  resolve: (dto: DeckDTO) => void;
  reject: (error: unknown) => void;
  startedAt: number;
  /** Set by `tryPreemptForInteractive` right before aborting a running
   *  background job — tells `pump`'s catch to re-run this same job (same
   *  promise) instead of surfacing `CANCELED` to whoever is awaiting it. */
  preempted: boolean;
  preemptCount: number;
};

const inFlight = new Map<number, Job>();
const interactiveQueue: Job[] = [];
const backgroundQueue: Record<PrewarmScope, Job[]> = {
  program: [],
  explicit: [],
  visible: [],
  batch: [],
};
let running = false;
let runningJob: Job | null = null;
let consecutiveTimeouts = 0;

// ---------------------------------------------------------------------------
// Batch pre-warming — `warmBatchPdfCache` fills these before a chunk of
// background jobs runs; `runConversion`/`prepareDeck` consume and release
// them one-shot. See `warmBatchPdfCache`'s own comment for why this lives
// beside the queues instead of inside a single conversion.
// ---------------------------------------------------------------------------

const precomputedPdfByAsset = new Map<number, string>();
const precomputedPptxByAsset = new Map<number, string>();
/** The `(size, mtime)` of the source a batch pre-computed from. A file edited
 *  between the batch and its own turn must not get the old file's slides. */
const precomputedStampByAsset = new Map<number, string>();

function stampOf(stat: fs.Stats): string {
  return `${stat.size}-${Math.trunc(stat.mtimeMs)}`;
}

/** Whatever a batch pre-computed for this asset, if it still describes the
 *  bytes on disk. */
function precomputedFor(assetId: number, stat: fs.Stats): { pdf?: string; pptx?: string } {
  if (precomputedStampByAsset.get(assetId) !== stampOf(stat)) return {};
  const pdf = precomputedPdfByAsset.get(assetId);
  const pptx = precomputedPptxByAsset.get(assetId);
  return { ...(pdf ? { pdf } : {}), ...(pptx ? { pptx } : {}) };
}

/** One shared temp directory can back several assets' precomputed files at
 *  once (everything one batch `soffice` invocation produced) — it's only
 *  safe to delete once every asset in the batch has either consumed its
 *  file or given up on it. */
type BatchDirRef = { dir: string; remaining: Set<number> };
const batchDirByAsset = new Map<number, BatchDirRef>();

/** The in-flight batch `soffice` invocation, if any.
 *
 *  A batch call is one process for a whole chunk, so it belongs to no single
 *  `Job` and no single job's `AbortSignal` can stop it. Without this handle it
 *  could only be waited out — and `runSoffice` serializes every invocation
 *  against the shared profile, so an interactive `deck:ensure` arriving one
 *  millisecond after a chunk started would queue behind the ENTIRE chunk
 *  (`convertTimeoutForBatch` allows up to half an hour). That is the exact
 *  failure mode preemption exists to prevent, reintroduced one level down. */
let batchWarmController: AbortController | null = null;

/** Stops the running batch warm-up, if any. Best-effort by construction:
 *  `convertBatchToPdf`/`convertBatchToPptx` keep whatever files LibreOffice
 *  already wrote, so an aborted chunk loses its remaining files, not its
 *  progress. Honours `slides.preemptBackground` for the same reason
 *  `tryPreemptForInteractive` does — see `soffice-shared-profile-race.md`. */
function abortBatchWarm(): void {
  if (!batchWarmController) return;
  if (getSettingsRepo().get("slides.preemptBackground") === false) return;
  batchWarmController.abort();
}

function registerBatchDir(dir: string, assetIds: readonly number[]): void {
  const ref: BatchDirRef = { dir, remaining: new Set(assetIds) };
  for (const assetId of assetIds) batchDirByAsset.set(assetId, ref);
}

/** A batch that stopped early (cancelled, cache full) never reaches the rest
 *  of its chunk: their slots — up to twenty PDFs in `.tmp` — are released
 *  here instead of waiting for the next launch's sweep. */
export function releasePrecomputed(assetIds: readonly number[]): void {
  for (const assetId of assetIds) releaseBatchDirFor(assetId);
}

/** Idempotent — safe to call more than once for the same assetId (every exit
 *  path of `runConversion`/`prepareDeck` calls this defensively) and a no-op
 *  for an assetId that was never part of a batch. */
function releaseBatchDirFor(assetId: number): void {
  const ref = batchDirByAsset.get(assetId);
  if (!ref) return;
  batchDirByAsset.delete(assetId);
  ref.remaining.delete(assetId);
  precomputedPdfByAsset.delete(assetId);
  precomputedPptxByAsset.delete(assetId);
  precomputedStampByAsset.delete(assetId);
  if (ref.remaining.size === 0) removeQuietly(ref.dir);
}

/** A background job always has a scope; `null` only happens for interactive
 *  work, which never reaches these lanes. `batch` is the safe default: the
 *  slowest lane, so a scope nobody declared can't jump ahead of one somebody
 *  did. */
function laneOf(job: Job): Job[] {
  return backgroundQueue[job.scope ?? "batch"];
}

function enqueueBackground(job: Job): void {
  laneOf(job).push(job);
}

/** Next background job to run: strict lane order, FIFO inside a lane. */
function dequeueBackground(): Job | undefined {
  for (const lane of BACKGROUND_LANES) {
    const job = backgroundQueue[lane].shift();
    if (job) return job;
  }
  return undefined;
}

/** Removes a still-queued job from whichever lane holds it. `false` means it
 *  wasn't queued — it is the one running, or already finished. */
function removeFromBackground(job: Job): boolean {
  const lane = laneOf(job);
  const index = lane.indexOf(job);
  if (index < 0) return false;
  lane.splice(index, 1);
  return true;
}

/** Every queued background job, lane order preserved. */
function queuedBackgroundJobs(): Job[] {
  return BACKGROUND_LANES.flatMap((lane) => backgroundQueue[lane]);
}

function hasQueuedBackground(...lanes: readonly PrewarmScope[]): boolean {
  return lanes.some((lane) => backgroundQueue[lane].length > 0);
}

let lastPreemptAt = 0;
/** A background job must have been running at least this long before it's
 *  worth interrupting — the cheap cache hits resolve in milliseconds anyway
 *  (and, since `prepareDeck` now checks `tryCacheHit` up front, never even
 *  reach here), and aborting one mid-`soffice` call is the only case that
 *  matters. Lowered from 1.5s once the cache-hit-before-queue change
 *  (`prepareDeck`) meant this only ever fires on a genuine conversion — the
 *  operator hitting GO LIVE on something that's actually still converting
 *  shouldn't wait a full 1.5s of background work before being prioritized. */
const PREEMPT_MIN_RUNTIME_MS = 600;
/** Caps how often *any* preemption can happen — an operator clicking rapidly
 *  through several decks must not turn into a chain of aborted conversions.
 *  Lowered alongside `PREEMPT_MIN_RUNTIME_MS` for the same reason. */
const PREEMPT_MIN_INTERVAL_MS = 3_000;
/** A background job preempted this many times is dropped instead of
 *  re-queued again, so a busy operator can't livelock it forever. */
const PREEMPT_MAX_ATTEMPTS = 2;

/** Soft-preempts the currently running background job in favor of an
 *  incoming interactive one — see `.claude/knowledge/soffice-shared-profile-race.md`
 *  for why this is deliberately rare and bounded rather than instant: killing
 *  `soffice` mid-conversion can leave its profile locked and time out every
 *  conversion after it. `slides.preemptBackground` (default on) is the
 *  escape hatch to disable this entirely without a release if that ever
 *  turns out to be too aggressive in practice. */
function tryPreemptForInteractive(incomingAssetId: number): void {
  // First, and unconditionally: a batch warm-up holds the shared `soffice`
  // chain for its whole chunk, so it has to be stopped even when there is no
  // per-job conversion to preempt (the chunk's own `soffice` IS what the
  // interactive job would otherwise wait behind).
  abortBatchWarm();
  if (getSettingsRepo().get("slides.preemptBackground") === false) return;
  const job = runningJob;
  if (!job || job.priority !== "background" || job.assetId === incomingAssetId) return;
  const now = Date.now();
  if (now - job.startedAt < PREEMPT_MIN_RUNTIME_MS) return;
  if (now - lastPreemptAt < PREEMPT_MIN_INTERVAL_MS) return;
  if (job.preemptCount >= PREEMPT_MAX_ATTEMPTS) return;
  lastPreemptAt = now;
  job.preempted = true;
  job.controller.abort();
}

/** LibreOffice isn't reentrant against one UserInstallation, and rasterizing
 *  already saturates a core — so exactly one job runs at a time: interactive
 *  jobs first, then background work in `BACKGROUND_LANES` order. */
async function pump(): Promise<void> {
  if (running) return;
  const job = interactiveQueue.shift() ?? dequeueBackground();
  if (!job) return;

  running = true;
  runningJob = job;
  job.startedAt = Date.now();
  try {
    const dto = await runConversion(job);
    job.resolve(dto);
    inFlight.delete(job.assetId);
  } catch (error) {
    if (job.preempted && job.preemptCount < PREEMPT_MAX_ATTEMPTS) {
      // Our own soft-preemption aborted this run — not a real failure. Retry
      // the SAME job (same promise, same `inFlight` entry) at the back of
      // the background queue instead of rejecting whoever is awaiting it.
      job.preempted = false;
      job.preemptCount += 1;
      job.controller = new AbortController();
      // The operator may have opened this very deck while the preemption was
      // landing (the job was still inside `hashFile`, which does not watch the
      // signal): `prepareDeck` then made it interactive. Requeued behind the
      // batch in a background lane, it waited for the batch — and a visible
      // or batch cancel could have cancelled it under the operator.
      if (job.priority === "interactive") interactiveQueue.unshift(job);
      else enqueueBackground(job);
    } else {
      inFlight.delete(job.assetId);
      job.reject(error);
    }
  } finally {
    running = false;
    runningJob = null;
    void pump();
  }
}

/** Idempotent per assetId: a second call while a conversion is in flight
 *  joins the same job rather than queuing another. A `background` job asked
 *  for again as `interactive` (the operator opened something the prewarm was
 *  already converting) is promoted in place — moved to the front of the
 *  interactive queue if still waiting, or left running but now immune to
 *  preemption if it already started. */
export function prepareDeck(assetId: number, opts: PrepareOptions = {}): Promise<DeckDTO> {
  if (shuttingDown) return Promise.reject(new SlideError("CANCELED", mt("slides.shuttingDown")));
  if (!inFlight.has(assetId)) {
    // Before the cache and before the queue: a deck read straight from its
    // source never waits behind a LibreOffice conversion, and never needs
    // LibreOffice at all — this is the whole hymnal, and every `.pptx`.
    const sourcePath = getMediaRepo().getPathById(assetId);
    const own = sourcePath ? sourceDeck(assetId, sourcePath, opts.force ?? false) : null;
    if (own) {
      releaseBatchDirFor(assetId);
      // `null`: a `.pptx` the reader couldn't open after all — LibreOffice's.
      return own.then((dto) => dto ?? prepareConverted(assetId, opts));
    }
  }
  return prepareConverted(assetId, opts);
}

/** A deck that isn't read from its source: the cache, else LibreOffice's queue. */
function prepareConverted(assetId: number, opts: PrepareOptions): Promise<DeckDTO> {
  if (shuttingDown) return Promise.reject(new SlideError("CANCELED", mt("slides.shuttingDown")));
  const priority = opts.priority ?? "interactive";

  // Checked before anything else, even before `inFlight`: a deck that's
  // already ready must resolve immediately, with zero queueing and zero
  // "converting" state — never wait behind whatever background prewarm job
  // happens to be running right now. This is what makes GO LIVE instant on
  // an already-prewarmed deck regardless of queue depth.
  if (!inFlight.has(assetId)) {
    const sourcePath = getMediaRepo().getPathById(assetId);
    if (sourcePath) {
      const cacheHit = tryCacheHit(assetId, sourcePath, opts.force ?? false);
      if (cacheHit) {
        // A deck that a batch warmed a PDF for but that turned out to
        // already be ready (e.g. another job converted it in the meantime)
        // must still release that PDF, or its shared batch dir never gets
        // cleaned up.
        releaseBatchDirFor(assetId);
        return Promise.resolve(cacheHit);
      }
      // Background work never queues for a LibreOffice the last sweep found
      // missing. Every tile scrolled into view, every deck in the schedule and
      // every file just imported used to enqueue a job that read the whole
      // file to hash it, flashed a progress bar on its tile and swept the disk
      // for `soffice` again, only to fail. The operator opening a deck still
      // goes through `requireSoffice`, which looks again — that is how a
      // LibreOffice installed mid-session is found.
      const missing = priority === "background" ? cachedSofficeError() : null;
      if (missing && containerKind(sourcePath) !== "pdf") {
        releaseBatchDirFor(assetId);
        return Promise.reject(missing);
      }
    }
  }

  const existing = inFlight.get(assetId);
  if (existing) {
    if (priority === "interactive") {
      if (existing.priority === "background") {
        // Set before moving: a job that is already RUNNING can't be requeued,
        // but flipping its priority makes it immune to preemption, which is
        // the whole point of asking for it interactively.
        existing.priority = "interactive";
        if (removeFromBackground(existing)) interactiveQueue.push(existing);
      }
      tryPreemptForInteractive(assetId);
    } else if (existing.priority === "background") {
      promoteBackgroundLane(existing, opts.scope ?? "batch");
    }
    return existing.promise;
  }

  let resolve!: (dto: DeckDTO) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<DeckDTO>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const job: Job = {
    assetId,
    force: opts.force ?? false,
    priority,
    scope: opts.scope ?? null,
    prewarmJobId: opts.prewarmJobId,
    controller: new AbortController(),
    promise,
    resolve,
    reject,
    startedAt: 0,
    preempted: false,
    preemptCount: 0,
  };
  inFlight.set(assetId, job);
  if (priority === "interactive") interactiveQueue.push(job);
  else enqueueBackground(job);
  if (priority === "interactive") tryPreemptForInteractive(assetId);
  void pump();
  return promise;
}

/** Moves a queued background job into a faster lane. Only ever forward: a
 *  deck asked for twice keeps the best claim it was ever given, so scrolling
 *  past a tile can't demote something the operator put in the schedule. */
function promoteBackgroundLane(job: Job, scope: PrewarmScope): void {
  const current = BACKGROUND_LANES.indexOf(job.scope ?? "batch");
  const wanted = BACKGROUND_LANES.indexOf(scope);
  if (wanted >= current) return;
  // A job that is already running can't be requeued; recording the better
  // scope still matters, because a soft-preemption requeues it by lane.
  const wasQueued = removeFromBackground(job);
  job.scope = scope;
  if (wasQueued) enqueueBackground(job);
}

/** Enqueues background conversions for assets that aren't already converted —
 *  never cancels anything. Used for everything the operator asked for by
 *  name: a file added to the library (`explicit`) and a deck placed in the
 *  order of service (`program`, which outranks every other background lane).
 *
 *  A deck that is already in flight is NOT skipped: `prepareDeck` dedupes it
 *  and, crucially, promotes it out of a slower lane. Skipping it here is what
 *  used to leave a deck that had been queued by a folder batch stuck behind
 *  599 others after the operator dropped it into the schedule.
 *
 *  Looks up every asset's status in one query instead of `getDeck()` (a
 *  SELECT + `fs.existsSync` per asset) in the loop — a folder-sized call
 *  here must not cost hundreds of filesystem stats on the main thread just
 *  to decide what's already done. */
export function prewarmExplicit(assetIds: readonly number[], scope: PrewarmScope = "explicit"): void {
  const statuses = getSlidesRepo().statusesByAsset(assetIds);
  for (const assetId of assetIds) {
    if (statuses.get(assetId)?.status === "ready") continue;
    prepareDeck(assetId, { priority: "background", scope }).catch(() => undefined);
  }
}

/** Replaces the "visible in the library grid right now" background set:
 *  cancels queued-but-not-yet-running `visible`-scope jobs whose asset
 *  scrolled out of view, then enqueues the ones that scrolled in. A job
 *  already running is left to finish — a real conversion in progress is
 *  never wasted just because a scroll passed it by. */
export function setVisiblePrewarm(assetIds: readonly number[]): void {
  const wanted = new Set(assetIds);
  // Only the `visible` lane: a deck that was promoted out of it (into the
  // schedule's lane) is no longer this function's to cancel.
  const lane = backgroundQueue.visible;
  for (let i = lane.length - 1; i >= 0; i--) {
    const job = lane[i]!;
    if (wanted.has(job.assetId)) continue;
    lane.splice(i, 1);
    settleCanceledJob(job, mt("slides.noLongerVisible"));
  }
  const statuses = getSlidesRepo().statusesByAsset(assetIds);
  for (const assetId of assetIds) {
    if (inFlight.has(assetId)) continue;
    if (statuses.get(assetId)?.status === "ready") continue;
    prepareDeck(assetId, { priority: "background", scope: "visible" }).catch(() => undefined);
  }
}

/** Cancels background jobs — every one, or just those tagged with
 *  `prewarmJobId` (one "Prepare folder/view" batch). A queued job is
 *  rejected immediately; a running one is aborted and resolves through the
 *  normal `pump` failure path. */
export function cancelBackgroundJobs(prewarmJobId?: string): void {
  const matches = (job: Job) =>
    job.priority === "background" && (prewarmJobId === undefined || job.prewarmJobId === prewarmJobId);

  for (const job of queuedBackgroundJobs()) {
    if (!matches(job)) continue;
    removeFromBackground(job);
    job.controller.abort();
    settleCanceledJob(job, mt("slides.prewarmCanceled"));
  }
  if (runningJob && matches(runningJob)) {
    runningJob.preempted = false;
    runningJob.controller.abort();
  }
  // A batch `soffice` invocation is not tied to any single job's signal (one
  // process covers a whole chunk), so cancelling the batch has to abort it
  // explicitly — otherwise the chunk keeps converting for minutes after the
  // operator pressed cancel, holding the shared `sofficeChain` the whole time.
  abortBatchWarm();
}

/** Settles a job that was pulled out of a queue before it ever ran.
 *
 *  Dropping a queued job WITHOUT doing this is not a leak, it is a trap: the
 *  entry left behind in `inFlight` makes every later `prepareDeck(assetId)`
 *  return that dead promise — and, because the up-front cache-hit shortcut is
 *  guarded by `if (!inFlight.has(assetId))`, it doesn't even get to answer
 *  from the cache. That asset becomes unprojectable for the rest of the
 *  session. A running job needs none of this: aborting it makes
 *  `runConversion` throw and `pump`'s catch does exactly the same cleanup. */
function settleCanceledJob(job: Job, message: string): void {
  inFlight.delete(job.assetId);
  releaseBatchDirFor(job.assetId);
  job.reject(new SlideError("CANCELED", message));
  // The same push a RUNNING job's cancellation gets from `runConversion`. The
  // control window ignores this rejection on purpose and waits for main's
  // word, so without it a deck cancelled while still in line stayed on
  // «Getting ready to convert…» forever.
  emitProgress({ assetId: job.assetId, status: "stale", done: 0, total: 0, error: message });
}

export function cancel(assetId: number): void {
  const job = inFlight.get(assetId);
  if (!job) return;
  // A real cancel, even if a preemption got there first: otherwise `pump`
  // takes the abort for its own and requeues the job the operator cancelled.
  job.preempted = false;
  job.controller.abort();
  const interactiveIndex = interactiveQueue.indexOf(job);
  const wasQueued = interactiveIndex >= 0;
  if (wasQueued) interactiveQueue.splice(interactiveIndex, 1);
  if (wasQueued || removeFromBackground(job)) {
    settleCanceledJob(job, mt("slides.canceled"));
  }
}

export function cancelAll(): void {
  const queued = [...interactiveQueue, ...queuedBackgroundJobs()];
  interactiveQueue.length = 0;
  for (const lane of BACKGROUND_LANES) backgroundQueue[lane].length = 0;
  for (const job of inFlight.values()) {
    job.preempted = false;
    job.controller.abort();
  }
  // Unconditional, unlike `abortBatchWarm()`: this is shutdown, so the
  // `slides.preemptBackground` escape hatch doesn't apply.
  batchWarmController?.abort();
  // The running job (if any) settles through `pump`; everything that never
  // started has to be settled here or its awaiter hangs forever.
  for (const job of queued) settleCanceledJob(job, mt("slides.canceled"));
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function emptyMeta(): PresentationMeta {
  return { slideCount: 0, slideSizeEmu: null, slides: [], audio: [], video: [], skippedVideoParts: [] };
}

/** Assembles the DTO for a `ready` deck row, folding in the asset's *linked*
 *  soundtrack (an external file, resolved per media asset — see
 *  `linked-audio.ts`) as the fallback when the deck itself carries no
 *  embedded/transition audio.
 *
 *  `resolve` (default `true`) re-resolves the link first, so a stale or
 *  never-set `linked_audio_path` gets picked up without forcing a
 *  reconversion — every caller in this file wants that, since it's already
 *  paying for a real conversion or cache hit. `getDeck` (a cache-only,
 *  called-on-every-render lookup) passes `resolve: false`: for a `.ppt`/`.pps`
 *  that never had this resolved yet (e.g. imported by the fast batch import
 *  in `library-import.ts`, or pre-warmed in bulk), resolving means reading
 *  the whole file into memory — exactly the cost that must never happen just
 *  because a tile scrolled into view. `deck:get`'s DTO is "the best we
 *  currently know"; `deck:ensure`'s is authoritative. */
function toDeckDTO(row: DeckRow, assetId: number, opts?: { resolve?: boolean }): DeckDTO {
  const mediaRepo = getMediaRepo();
  if (opts?.resolve !== false) mediaRepo.ensureLinkedAudio(assetId);
  // A `.wmv` on a slide or a WMA soundtrack: handed to the media engine (or,
  // with no engine, converted) in the background, and announced with
  // `deck-updated` once it is. On `getDeck` too: which clips the engine plays
  // is only known in memory, so a deck cached by an earlier launch and opened
  // with a bare peek would otherwise lose them until something ensured it.
  // Cheap after the first time per launch (`checked`).
  healDeckClips(row.id);
  return getSlidesRepo().toDTO(row, assetId, mediaRepo.linkedAudioPathById(assetId), isEngineClip);
}

/** LibreOffice rounds an advance time to whole seconds on its way through
 *  `.pptx`, so two readings of the same slide can legitimately differ by up to
 *  half a second. Anything past a full second is not rounding — it means the
 *  two readings are not describing the same slide. */
const TIMING_AGREEMENT_TOLERANCE_MS = 1000;

/**
 * Fills in the auto-advance times LibreOffice's PPTX export threw away.
 *
 * The export only writes a `<p:transition>` element when the slide has a
 * visual transition EFFECT, and `advTm` is an attribute of that element — so a
 * slide set to "no transition, advance after 27 s" comes back with no timing
 * at all. Measured on the user's hymnal: 222 of 1226 decks affected, 208 of
 * them losing every slide's timing. LibreOffice's own import is fine (the
 * same file exported to `.odp` has every `presentation:duration`), which is
 * why re-reading the source is enough and no second conversion is needed.
 *
 * **Gap-filling only, and self-checked.** A value the `.pptx` already carries
 * is left alone, and before filling anything the two readings are compared on
 * every slide where both have a number: they come from completely independent
 * paths, so if the binary reader's idea of presentation order were wrong, they
 * would disagree. One disagreement and the whole merge is abandoned — a deck
 * that silently advances on the WRONG slide's timing during a service is worse
 * than one that does not advance at all. (Validated over the user's 673
 * converted hymnal decks: 4940 slides where both had a value, zero
 * disagreements, 976 gaps filled.)
 */
function mergeBinaryTimings(meta: PresentationMeta, sourcePath: string): PresentationMeta {
  const binary = readBinarySlideTimings(sourcePath);
  if (!binary || binary.length !== meta.slides.length) return meta;

  for (const [index, slide] of meta.slides.entries()) {
    const fromBinary = binary[index]?.autoAdvanceMs;
    if (slide.autoAdvanceMs === null || fromBinary === null || fromBinary === undefined) continue;
    if (Math.abs(slide.autoAdvanceMs - fromBinary) > TIMING_AGREEMENT_TOLERANCE_MS) {
      console.warn(
        `[slides] binary timings disagree with the converted .pptx at slide ${index + 1} ` +
          `(${fromBinary}ms vs ${slide.autoAdvanceMs}ms) — not merging: ${sourcePath}`,
      );
      return meta;
    }
  }

  let filled = 0;
  const slides = meta.slides.map((slide, index) => {
    if (slide.autoAdvanceMs !== null) return slide;
    const fromBinary = binary[index]?.autoAdvanceMs;
    if (fromBinary === null || fromBinary === undefined) return slide;
    filled += 1;
    return { ...slide, autoAdvanceMs: Math.max(SLIDES_MIN_ADVANCE_MS, fromBinary) };
  });

  if (filled === 0) return meta;
  console.info(
    `[slides] recovered ${filled} auto-advance time(s) from the source binary that the .pptx export dropped: ${sourcePath}`,
  );
  return { ...meta, slides };
}

/** Reads timings/audio out of the source. Legacy binary .ppt/.pps carry no
 *  OOXML, so they get a second LibreOffice pass to .pptx purely to recover
 *  them — that round-trip preserves advTm and is the difference between parity
 *  and no parity on the old decks churches actually have. */
async function readMetadata(
  sourcePath: string,
  tempDir: string,
  sizeBytes: number,
  signal: AbortSignal,
  precomputedPptxPath?: string,
): Promise<{ meta: PresentationMeta; timingsSource: "ooxml" | "ooxml-converted" | "none"; parsedFrom: string }> {
  const kind = containerKind(sourcePath);

  // A PDF carries no presentation structure at all: no transitions, so no
  // auto-advance, and no media parts, so no embedded soundtrack. Stated as its
  // own branch rather than left to the fallthrough below, because "there is
  // nothing to read" is a fact about the format here, not a parse that failed.
  // A *linked* sibling .mp3 still resolves for it, like any other deck.
  if (kind === "pdf") {
    return { meta: emptyMeta(), timingsSource: "none", parsedFrom: sourcePath };
  }

  if (kind === "ooxml") {
    try {
      return { meta: readPresentationMeta(sourcePath), timingsSource: "ooxml", parsedFrom: sourcePath };
    } catch {
      // LibreOffice often recovers files our parser rejects — convert anyway.
      return { meta: emptyMeta(), timingsSource: "none", parsedFrom: sourcePath };
    }
  }

  if (kind === "binary") {
    try {
      // A background batch may already have produced this deck's .pptx
      // upgrade in one shared `soffice` invocation covering the whole
      // batch — reuse it instead of paying for a second, single-file one.
      let pptx: string;
      if (precomputedPptxPath && fs.existsSync(precomputedPptxPath)) {
        pptx = precomputedPptxPath;
      } else {
        const upgradeDir = path.join(tempDir, "upgrade");
        fs.mkdirSync(upgradeDir, { recursive: true });
        pptx = await convertToPptx({
          sourcePath,
          outDir: upgradeDir,
          timeoutMs: convertTimeoutFor(sizeBytes),
          signal,
        });
      }
      return {
        // The `.pptx` is authoritative for structure and embedded audio, but
        // NOT for auto-advance — LibreOffice drops the time whenever the slide
        // has no visual transition to hang it on. The source binary still has
        // it; see `mergeBinaryTimings`.
        meta: mergeBinaryTimings(readPresentationMeta(pptx), sourcePath),
        timingsSource: "ooxml-converted",
        parsedFrom: pptx,
      };
    } catch (error) {
      if (isSlideError(error) && error.slideCode === "CANCELED") throw error;
      // A failed upgrade pass must never block the main conversion.
      console.warn(
        `[slides] .ppt/.pps → .pptx upgrade pass failed, auto-advance and embedded audio disabled for this deck: ${String(error)}`,
      );
      return { meta: emptyMeta(), timingsSource: "none", parsedFrom: sourcePath };
    }
  }

  // .odp stores timings under a different schema (presentation:transition-*),
  // out of scope for now — documented rather than silently wrong.
  return { meta: emptyMeta(), timingsSource: "none", parsedFrom: sourcePath };
}

/** The cheapest possible hit: same asset, same size+mtime, still on disk and
 *  current — no hashing, no filesystem walk beyond one `statSync` and one
 *  `existsSync`. Pulled out of `runConversion` so `prepareDeck` can call it
 *  BEFORE a job ever touches `inFlight`/the queues: a deck prewarmed a
 *  minute ago used to still queue behind whatever background conversion was
 *  running when the operator hit GO LIVE, because this check only ran once
 *  the job reached the front of the queue. Checking it up front means an
 *  already-ready deck never announces "converting" and never waits on
 *  anything. `runConversion` still calls this too, for the (normal, not a
 *  bug) case where the deck finished converting while this job was sitting
 *  in the queue behind another one. */
function tryCacheHit(assetId: number, sourcePath: string, force: boolean): DeckDTO | null {
  if (force) return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    return null;
  }
  const target = resolveRenderTarget();
  const slidesRepo = getSlidesRepo();
  const usable = (row: DeckRow): boolean =>
    row.status === "ready" &&
    row.converterVersion === SLIDES_CONVERTER_VERSION &&
    row.imageFormat === target.format &&
    !needsRerender(row.renderWidth, target) &&
    fs.existsSync(row.cacheDir);

  // No "converting" emission on either path — a cache hit must never announce
  // work that isn't happening (this used to fire unconditionally at the top of
  // `runConversion`, which is what produced a false "converting… N of N" flash
  // for an already-ready deck).
  const hit = (row: DeckRow): DeckDTO => {
    slidesRepo.touchDeck(row.id);
    if (row.transitionsRead === 0) readTransitionsInto(row);
    const dto = toDeckDTO(row, assetId);
    emitProgress({ assetId, status: "ready", done: dto.slideCount, total: dto.slideCount, error: null });
    return dto;
  };

  // 1. This asset's own row, validated by size+mtime — no hashing, no
  //    filesystem walk beyond the `statSync` above and one `existsSync`.
  const byAsset = slidesRepo.findDeckByAsset(assetId);
  if (
    byAsset &&
    byAsset.sourceSizeBytes === stat.size &&
    byAsset.sourceMtimeMs === Math.trunc(stat.mtimeMs) &&
    usable(byAsset)
  ) {
    return hit(byAsset);
  }

  // The stamp below is validated against the asset row's `(size, mtime)`, so
  // the row has to describe the file on disk first — or a deck edited in place
  // matches its own old digest.
  getMediaRepo().refreshStat(assetId, stat.size, Math.trunc(stat.mtimeMs));

  // 2. The deck this asset's BYTES belong to, via its stamped content hash.
  //    Without this, a duplicate file (the same hymn in two folders — 555 of
  //    them in the library that motivated `N3`) fell all the way through to
  //    `runConversion`, which re-read the whole file just to recompute a
  //    digest the asset already carries, only to end in `relinkDeck`. The
  //    stamp is invalidated by size+mtime in SQL, so a file edited behind our
  //    back never matches here.
  //
  //    It still relinks: `mediaAssetId` is what `findDeckByAsset` and
  //    `projection.ts`'s eviction pin read, and leaving it pointing at the
  //    other copy would trade this bug for that one. What has changed is that
  //    nothing DEPENDS on the relink any more — `statusesByAsset` asks by
  //    content, so the asset that just lost the row keeps reporting `ready`.
  const byContent = slidesRepo.findDeckByAssetContent(assetId, target.width, target.format);
  if (byContent && usable(byContent)) {
    const mtimeMs = Math.trunc(stat.mtimeMs);
    slidesRepo.relinkDeck(byContent.id, assetId, sourcePath, stat.size, mtimeMs);
    return hit({
      ...byContent,
      mediaAssetId: assetId,
      sourcePath,
      sourceSizeBytes: stat.size,
      sourceMtimeMs: mtimeMs,
    });
  }
  return null;
}

/**
 * Reads the transitions of a deck converted before this build read them, from
 * its source — no reconversion, the images are fine. Aligned on the visible
 * slides, like the timings; when the counts disagree the deck keeps the cuts it
 * always had, and either way it is not asked again.
 */
function readTransitionsInto(row: DeckRow): void {
  let transitions: (SlideTransition | null)[] | null = null;
  try {
    const kind = containerKind(row.sourcePath);
    const slides =
      kind === "binary"
        ? readBinarySlideTimings(row.sourcePath)
        : kind === "ooxml"
          ? readPresentationMeta(row.sourcePath).slides
          : null;
    const visible = slides?.filter((slide) => !slide.hidden).map((slide) => slide.transition) ?? null;
    if (visible && visible.length === row.slideCount) transitions = visible;
  } catch {
    // Unreadable now: it keeps its cuts.
  }
  getSlidesRepo().setSlideTransitions(row.id, transitions);
}

// ---------------------------------------------------------------------------
// Native decks — read straight from the source, nothing converted or copied
// ---------------------------------------------------------------------------

/** Binary decks read once and found not to be ones `readBinaryDeck` draws, by
 *  path, with the `(size, mtime)` they were read at: a deck LibreOffice has to
 *  draw is not re-read on every open, and one edited since is read again. */
const notNativeStamp = new Map<string, string>();

/** One read per asset at a time. The preview effect and GO LIVE arrive within
 *  milliseconds of each other, and two inserts of the same deck replace each
 *  other's row — and the deck id in the urls the first caller already holds. */
const nativeInFlight = new Map<number, Promise<DeckDTO>>();

function isUsableNative(row: DeckRow, stat: fs.Stats): boolean {
  return (
    row.imageFormat === "native" &&
    row.status === "ready" &&
    row.converterVersion === SLIDES_NATIVE_VERSION &&
    row.sourceSizeBytes === stat.size &&
    row.sourceMtimeMs === Math.trunc(stat.mtimeMs)
  );
}

function readyNative(row: DeckRow, assetId: number): DeckDTO {
  getSlidesRepo().touchDeck(row.id);
  const dto = toDeckDTO(row, assetId);
  emitProgress({ assetId, status: "ready", done: dto.slideCount, total: dto.slideCount, error: null });
  return dto;
}

/**
 * The deck read straight from its source, when it is one: already on record
 * (answered synchronously) or being read now. `null` sends the caller on to
 * LibreOffice — a deck that is not a legacy binary, or one `readBinaryDeck`
 * refuses.
 */
function nativeDeck(assetId: number, sourcePath: string, force: boolean): Promise<DeckDTO> | null {
  const stat = fs.statSync(sourcePath, { throwIfNoEntry: false });
  if (!stat) return null;
  const inFlightRead = nativeInFlight.get(assetId);
  if (inFlightRead) return inFlightRead;

  const slidesRepo = getSlidesRepo();
  const mtimeMs = Math.trunc(stat.mtimeMs);
  if (!force) {
    const own = slidesRepo.findSourceDeckByAsset(assetId, "native");
    if (own && isUsableNative(own, stat)) return Promise.resolve(readyNative(own, assetId));
    if (notNativeStamp.get(sourcePath) === stampOf(stat)) return null;
  }
  // By content, never by extension — and before anything that writes: every
  // `.pptx` and PDF passes through here on its way to the cache.
  if (containerKind(sourcePath) !== "binary") return null;

  if (!force) {
    // The same bytes through another library entry — the same hymn in two
    // folders. The stamp has to describe the file on disk first, or a deck
    // edited in place matches its own old digest.
    getMediaRepo().refreshStat(assetId, stat.size, mtimeMs);
    const shared = slidesRepo.findDeckByAssetContent(assetId, 0, "native");
    if (shared && shared.status === "ready" && shared.converterVersion === SLIDES_NATIVE_VERSION) {
      slidesRepo.relinkDeck(shared.id, assetId, sourcePath, stat.size, mtimeMs);
      return Promise.resolve(
        readyNative({ ...shared, mediaAssetId: assetId, sourcePath, sourceSizeBytes: stat.size, sourceMtimeMs: mtimeMs }, assetId),
      );
    }
  }

  const read = readBinaryDeck(sourcePath);
  if (!read || "unsupported" in read) {
    notNativeStamp.set(sourcePath, stampOf(stat));
    if (read) console.info(`[slides] drawn by LibreOffice, not read natively (${read.unsupported}): ${sourcePath}`);
    return null;
  }
  const promise = recordNativeDeck(assetId, sourcePath, stat, read.deck).finally(() =>
    nativeInFlight.delete(assetId),
  );
  nativeInFlight.set(assetId, promise);
  return promise;
}

async function recordNativeDeck(assetId: number, sourcePath: string, stat: fs.Stats, deck: BinaryDeck): Promise<DeckDTO> {
  const slidesRepo = getSlidesRepo();
  const mtimeMs = Math.trunc(stat.mtimeMs);
  // The identity every status question is answered by (`statusesByAsset`),
  // exactly as for a converted deck.
  const contentHash = await hashFile(sourcePath);
  getMediaRepo().setContentHash(assetId, contentHash, stat.size, mtimeMs);

  const slides: NewSlide[] = deck.slides.map((slide, index) => ({
    slideIndex: index + 1,
    imageFile: "",
    thumbFile: "",
    // The slide at 96 dpi: what a video rect would be measured against, were
    // a legacy deck ever to carry one.
    widthPx: Math.round(deck.width / 6),
    heightPx: Math.round(deck.height / 6),
    bytes: 0,
    advanceMs: slide.autoAdvanceMs === null ? null : Math.max(SLIDES_MIN_ADVANCE_MS, slide.autoAdvanceMs),
    advanceOnClick: slide.advanceOnClick,
    transition: slide.transition,
    hidden: false,
    title: null,
    notes: null,
    layers: encodeSlideLayers({ width: deck.width, height: deck.height, layers: slide.layers }),
  }));

  const deckId = slidesRepo.insertDeck(
    {
      contentHash,
      renderWidth: 0,
      imageFormat: "native",
      converterVersion: SLIDES_NATIVE_VERSION,
      mediaAssetId: assetId,
      sourcePath,
      sourceSizeBytes: stat.size,
      sourceMtimeMs: mtimeMs,
      cacheDir: "",
      aspectRatio: `${deck.width}:${deck.height}`,
      timingsSource: "binary",
      bytesOnDisk: 0,
    },
    slides,
    [],
  );

  // What LibreOffice drew of these same bytes is a copy nobody needs any more
  // (decided by the owner, 2026-10-26). One the projector is showing keeps
  // its images until the next launch: some may still be on their way there.
  const freed = slidesRepo.deleteSupersededBySource(allPinnedDeckIds(), contentHash);
  if (freed > 0) console.info(`[slides] read natively, ${freed} converted copy(ies) deleted: ${sourcePath}`);

  const row = slidesRepo.getDeckById(deckId);
  if (!row) throw new SlideError("RASTER_FAILED", mt("slides.deckUnreadable"));
  const dto = toDeckDTO(row, assetId);
  emitProgress({ assetId, status: "ready", done: dto.slideCount, total: dto.slideCount, error: null });
  return dto;
}

// ---------------------------------------------------------------------------
// Model decks — a .pptx drawn from its model (SlideView), nothing rasterized
// ---------------------------------------------------------------------------

/** `.pptx` files the reader could not open at all, by path and the
 *  `(size, mtime)` they were tried at: LibreOffice gets them (it recovers files
 *  our parser rejects), and they are not re-read on every open. */
const notModelStamp = new Map<string, string>();

/** One read per asset at a time — see `nativeInFlight`. */
const modelInFlight = new Map<number, Promise<DeckDTO | null>>();

function isUsableModel(row: DeckRow, stat: fs.Stats): boolean {
  return (
    row.imageFormat === "model" &&
    row.status === "ready" &&
    row.converterVersion === SLIDES_MODEL_VERSION &&
    row.sourceSizeBytes === stat.size &&
    row.sourceMtimeMs === Math.trunc(stat.mtimeMs) &&
    (row.cacheDir === "" || fs.existsSync(row.cacheDir))
  );
}

/** The deck read straight from its source, native or model, when it is one:
 *  `null` sends the caller on to the cache and LibreOffice — and so does a
 *  promise that settles `null`, a `.pptx` the reader (on its worker thread)
 *  turned out not to be able to open. */
function sourceDeck(assetId: number, sourcePath: string, force: boolean): Promise<DeckDTO | null> | null {
  return nativeDeck(assetId, sourcePath, force) ?? modelDeck(assetId, sourcePath, force);
}

/**
 * A `.pptx` (any OOXML presentation), read by `src/main/slides/pptx/` into a
 * model per slide that `SlideView` draws: no LibreOffice, no images on disk.
 * Decided by the owner on 2026-10-26: the switch is total — what the reader
 * can't draw exactly is approximated, never sent to LibreOffice. Only a file
 * it can't open as a presentation at all still goes there.
 */
function modelDeck(assetId: number, sourcePath: string, force: boolean): Promise<DeckDTO | null> | null {
  const stat = fs.statSync(sourcePath, { throwIfNoEntry: false });
  if (!stat) return null;
  const inFlightRead = modelInFlight.get(assetId);
  if (inFlightRead) return inFlightRead;

  const slidesRepo = getSlidesRepo();
  const mtimeMs = Math.trunc(stat.mtimeMs);
  if (!force) {
    const own = slidesRepo.findSourceDeckByAsset(assetId, "model");
    if (own && isUsableModel(own, stat)) return Promise.resolve(readyNative(own, assetId));
    if (notModelStamp.get(sourcePath) === stampOf(stat)) return null;
  }
  if (containerKind(sourcePath) !== "ooxml") return null;

  if (!force) {
    getMediaRepo().refreshStat(assetId, stat.size, mtimeMs);
    const shared = slidesRepo.findDeckByAssetContent(assetId, 0, "model");
    if (shared && shared.status === "ready" && shared.converterVersion === SLIDES_MODEL_VERSION) {
      slidesRepo.relinkDeck(shared.id, assetId, sourcePath, stat.size, mtimeMs);
      return Promise.resolve(
        readyNative({ ...shared, mediaAssetId: assetId, sourcePath, sourceSizeBytes: stat.size, sourceMtimeMs: mtimeMs }, assetId),
      );
    }
  }

  const promise = readPptx(sourcePath)
    .then((read) => {
      if (!read || read.slides.every((slide) => slide.hidden)) {
        notModelStamp.set(sourcePath, stampOf(stat));
        return null;
      }
      return recordModelDeck(assetId, sourcePath, stat, read);
    })
    .finally(() => modelInFlight.delete(assetId));
  modelInFlight.set(assetId, promise);
  return promise;
}

async function recordModelDeck(assetId: number, sourcePath: string, stat: fs.Stats, deck: PptxRead): Promise<DeckDTO> {
  const slidesRepo = getSlidesRepo();
  const mtimeMs = Math.trunc(stat.mtimeMs);
  const contentHash = await hashFile(sourcePath);
  getMediaRepo().setContentHash(assetId, contentHash, stat.size, mtimeMs);

  // Timings, transitions, sound and video come from the same reading of the
  // OOXML a converted deck used; the model is only how the slides look. Both
  // number slides in presentation order, hidden ones included, so the visible
  // ones line up by position — and when they don't, the timings go, as for a
  // converted deck: advancing on another slide's timing is worse than not.
  // Read on the worker thread with the model (`pptx-worker.ts`).
  const meta = deck.meta ?? emptyMeta();
  const visibleModels = deck.slides.filter((slide) => !slide.hidden);
  const visibleMeta = meta.slides.filter((slide) => !slide.hidden);
  const timingsUsable = visibleMeta.length === visibleModels.length;
  if (!timingsUsable && meta.slides.length > 0) {
    console.warn(`[slides] ${visibleMeta.length} timed slides vs ${visibleModels.length} drawn — auto-advance disabled: ${sourcePath}`);
  }

  const slides: NewSlide[] = visibleModels.map((slide, position) => {
    const timing = timingsUsable ? visibleMeta[position] : undefined;
    return {
      slideIndex: position + 1,
      imageFile: "",
      thumbFile: "",
      // The slide at 96 dpi: what an embedded video's rect is measured against.
      widthPx: Math.round(deck.width / 9525),
      heightPx: Math.round(deck.height / 9525),
      bytes: 0,
      advanceMs: timing?.autoAdvanceMs ?? null,
      advanceOnClick: timing?.advanceOnClick ?? true,
      transition: timing?.transition ?? null,
      hidden: false,
      title: timing?.title ?? null,
      notes: timing?.notes ?? null,
      layers: slide.layers,
    };
  });

  // ponytail: sound and video embedded in the deck are still extracted into a
  // cache folder, exactly as for a converted deck — served from the .pptx by
  // range once the media engine replaces `deck-clips.ts` (plan, phase 3).
  const cacheDir = deckCacheDir(contentHash, 0, "model");
  removeQuietly(cacheDir);
  // Each sound on the slides it plays on (`placeAudio`), counted among the
  // slides drawn — which only the timings that lined up can say.
  const visibleOoxml = timingsUsable ? visibleMeta.map((slide) => slide.slideIndex) : null;
  const audio: NewAudio[] = extractAudioParts(sourcePath, meta.audio, path.join(cacheDir, "audio")).flatMap((extracted) => {
    const placed = placeAudio(extracted, visibleOoxml);
    if (!placed) return [];
    return [
      {
        audioFile: extracted.file,
        ext: extracted.ext,
        bytes: extracted.bytes,
        origin: extracted.origin,
        ...placed,
        loop: extracted.loop,
        volume: extracted.volume,
        playable: extracted.playable,
      },
    ];
  });
  const videos: NewVideo[] = [];
  if (meta.video.length > 0 && timingsUsable) {
    const positionByOoxml = new Map<number, number>();
    visibleMeta.forEach((slide, position) => positionByOoxml.set(slide.slideIndex, position + 1));
    for (const extracted of extractVideoParts(sourcePath, meta.video, path.join(cacheDir, "video"))) {
      const slideIndex = positionByOoxml.get(extracted.slideIndex);
      if (slideIndex === undefined) continue;
      videos.push({
        slideIndex,
        videoFile: extracted.file,
        ext: extracted.ext,
        bytes: extracted.bytes,
        rect: extracted.rect,
        loop: extracted.loop,
        volume: extracted.volume,
        playable: extracted.playable,
      });
    }
  }
  const bytesOnDisk = audio.reduce((total, track) => total + track.bytes, 0) + videos.reduce((total, video) => total + video.bytes, 0);
  const ownsFolder = audio.length > 0 || videos.length > 0;
  if (!ownsFolder) removeQuietly(cacheDir);

  const deckId = slidesRepo.insertDeck(
    {
      contentHash,
      renderWidth: 0,
      imageFormat: "model",
      converterVersion: SLIDES_MODEL_VERSION,
      mediaAssetId: assetId,
      sourcePath,
      sourceSizeBytes: stat.size,
      sourceMtimeMs: mtimeMs,
      cacheDir: ownsFolder ? cacheDir : "",
      aspectRatio: `${deck.width}:${deck.height}`,
      timingsSource: timingsUsable && meta.slides.length > 0 ? "ooxml" : "none",
      bytesOnDisk,
    },
    slides,
    audio,
    videos,
  );

  // What LibreOffice drew of these same bytes is a copy nobody needs any more,
  // as for a native deck (owner, 2026-10-26).
  const freed = slidesRepo.deleteSupersededBySource(allPinnedDeckIds(), contentHash);
  if (freed > 0) console.info(`[slides] drawn from its model, ${freed} converted copy(ies) deleted: ${sourcePath}`);

  const row = slidesRepo.getDeckById(deckId);
  if (!row) throw new SlideError("RASTER_FAILED", mt("slides.deckUnreadable"));
  const dto = toDeckDTO(row, assetId);
  emitProgress({ assetId, status: "ready", done: dto.slideCount, total: dto.slideCount, error: null });
  return dto;
}

async function runConversion(job: Job): Promise<DeckDTO> {
  const { assetId, force, controller } = job;
  const signal = controller.signal;
  const slidesRepo = getSlidesRepo();
  const mediaRepo = getMediaRepo();

  const sourcePath = mediaRepo.getPathById(assetId);
  if (!sourcePath) {
    releaseBatchDirFor(assetId);
    throw new SlideError("SOURCE_MISSING", mt("slides.notInLibrary"));
  }
  if (!fs.existsSync(sourcePath)) {
    releaseBatchDirFor(assetId);
    throw new SlideError("SOURCE_MISSING", mt("slides.sourceGone", { path: sourcePath }));
  }

  // A job queued before this deck was read — or edited into one we read —
  // still never goes to LibreOffice for it.
  const own = await sourceDeck(assetId, sourcePath, force);
  if (own) {
    releaseBatchDirFor(assetId);
    return own;
  }

  const cacheHit = tryCacheHit(assetId, sourcePath, force);
  if (cacheHit) {
    releaseBatchDirFor(assetId);
    return cacheHit;
  }

  const stat = fs.statSync(sourcePath);
  const target = resolveRenderTarget();

  emitProgress({ assetId, status: "converting", done: 0, total: 0, error: null });

  try {
    assertFreeSpace(stat.size);
  } catch (error) {
    releaseBatchDirFor(assetId);
    throw error;
  }

  // 2. Content-addressed hit: the same bytes, converted through another
  //    library entry or before the file was moved/copied.
  const contentHash = await hashFile(sourcePath);
  // Stamp the asset with the digest we just paid for. It is the identity every
  // status question is answered by (`statusesByAsset`), so writing it here is
  // what keeps the startup backfill from ever having to re-read a file that a
  // conversion already opened — and what makes a newly imported deck answer
  // correctly the moment it is converted, rather than at the next launch.
  mediaRepo.setContentHash(assetId, contentHash, stat.size, Math.trunc(stat.mtimeMs));
  if (!force) {
    const byIdentity = slidesRepo.findDeckByIdentity(contentHash, target.width, target.format);
    if (
      byIdentity &&
      byIdentity.status === "ready" &&
      byIdentity.converterVersion === SLIDES_CONVERTER_VERSION &&
      fs.existsSync(byIdentity.cacheDir)
    ) {
      const mtimeMs = Math.trunc(stat.mtimeMs);
      slidesRepo.relinkDeck(byIdentity.id, assetId, sourcePath, stat.size, mtimeMs);
      const dto = toDeckDTO(
        { ...byIdentity, mediaAssetId: assetId, sourcePath, sourceSizeBytes: stat.size, sourceMtimeMs: mtimeMs },
        assetId,
      );
      emitProgress({ assetId, status: "ready", done: dto.slideCount, total: dto.slideCount, error: null });
      releaseBatchDirFor(assetId);
      return dto;
    }
  }

  // 3. Real conversion, into a temp dir that only becomes the cache dir once
  //    every single file is written.
  const jobDir = path.join(slidesTempDir, randomUUID());
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    // Asked for first, and only here: a missing LibreOffice has to fail before
    // the work rather than halfway through it (a legacy deck swept for it
    // twice, once per pass), but not before the content-addressed hit above,
    // which projects a duplicate without it. Inside the `try`, so the failure
    // is announced like any other and never leaves a tile «converting».
    if (containerKind(sourcePath) !== "pdf") await requireSoffice();

    const pdfDir = path.join(jobDir, "pdf");
    fs.mkdirSync(pdfDir, { recursive: true });

    // Sequential, not `Promise.all`: for a legacy binary deck, `readMetadata`
    // launches a second `soffice` (the .ppt/.pps → .pptx upgrade pass) — see
    // the serialization comment on `runSoffice` in `libreoffice.ts` for why
    // that no longer races the PDF conversion, but running them one after the
    // other keeps this call site honest about the shared resource either way.
    // Both steps prefer whatever a background batch already produced for
    // this asset (`warmBatchPdfCache`) over spawning their own `soffice` call.
    const metaResult = await readMetadata(
      sourcePath,
      jobDir,
      stat.size,
      signal,
      precomputedFor(assetId, stat).pptx,
    );
    // A PDF source IS the intermediate format, so it goes to the rasterizer
    // untouched — no `soffice`, and therefore no LibreOffice requirement for
    // this deck at all. Round-tripping it would route the file through Draw's
    // PDF *importer* and re-render every glyph; see `deckRequiresSoffice`.
    const precomputedPdf = precomputedFor(assetId, stat).pdf;
    let pdfPath: string;
    if (containerKind(sourcePath) === "pdf") {
      pdfPath = sourcePath;
    } else {
      pdfPath =
        precomputedPdf && fs.existsSync(precomputedPdf)
          ? precomputedPdf
          : await convertToPdf({
              sourcePath,
              outDir: pdfDir,
              timeoutMs: convertTimeoutFor(stat.size),
              signal,
            });
      // Only meaningful when `soffice` actually ran: this counter is what
      // `resetSofficeProfile` watches, and a PDF that never launched it must
      // not clear a streak of real LibreOffice timeouts.
      consecutiveTimeouts = 0;
    }

    const imagesDir = path.join(jobDir, "images");
    const pages = await rasterizePdf({
      pdfPath,
      outDir: imagesDir,
      targetWidth: target.width,
      format: target.format,
      quality: target.quality,
      signal,
      onPage: (_page, total) =>
        emitPageProgress(job, {
          assetId,
          status: "converting",
          done: _page.index,
          total,
          error: null,
        }),
    });

    if (pages.length === 0) {
      throw new SlideError("RASTER_FAILED", mt("slides.noSlides"));
    }

    // LibreOffice does NOT export hidden slides to the PDF (verified against a
    // real deck), so the PDF pages line up with the VISIBLE slides — matching
    // against the full OOXML list would shift every timing by one per hidden
    // slide. Counts can still disagree for other reasons (an animated slide
    // split across pages), and in that case timings are dropped entirely:
    // silently misaligned auto-advance is far worse than none at all.
    const { meta, timingsSource } = metaResult;
    const visibleSlides = meta.slides.filter((slide) => !slide.hidden);
    const timingsUsable = timingsSource !== "none" && visibleSlides.length === pages.length;
    const effectiveTimingsSource = timingsUsable ? timingsSource : "none";

    if (timingsSource !== "none" && !timingsUsable) {
      console.warn(
        `[slides] timing/page count mismatch (${visibleSlides.length} visible slides vs ${pages.length} pages) — auto-advance disabled for this deck`,
      );
    }

    const slides: NewSlide[] = pages.map((page) => {
      const timing = timingsUsable ? visibleSlides[page.index - 1] : undefined;
      return {
        slideIndex: page.index,
        imageFile: page.file,
        thumbFile: page.thumbFile,
        widthPx: page.widthPx,
        heightPx: page.heightPx,
        bytes: page.bytes,
        advanceMs: timing?.autoAdvanceMs ?? null,
        advanceOnClick: timing?.advanceOnClick ?? true,
        transition: timing?.transition ?? null,
        hidden: timing?.hidden ?? false,
        title: timing?.title ?? null,
        notes: timing?.notes ?? null,
        layers: null,
      };
    });

    // Audio embedded in the file itself, independent of whether the timings
    // lined up — a deck with mismatched slide/page counts still loses only
    // its auto-advance, not its soundtrack. The other audio source (a linked
    // sibling file, e.g. an old hymnal's external .mp3) is deliberately NOT
    // handled here: `slide_decks` is keyed by content hash and shared across
    // library entries, but a sibling file depends on the *folder* the source
    // currently lives in — baking it into the cache would let the first
    // conversion's folder impose its audio on every other entry that happens
    // to share the same deck bytes. It lives on `media_assets.linkedAudioPath`
    // instead and is resolved per-asset (see `linked-audio.ts` and
    // `MediaRepo.ensureLinkedAudio`), served by reference, never copied.
    const audioDir = path.join(jobDir, "audio");
    const audio: NewAudio[] = [];

    if (meta.audio.length > 0) {
      // Placed by the same page mapping as the videos below; when the counts
      // disagree, every sound is the deck's music from the first page, as it
      // always was.
      const visibleOoxml =
        visibleSlides.length === pages.length ? visibleSlides.map((slide) => slide.slideIndex) : null;
      for (const extracted of extractAudioParts(metaResult.parsedFrom, meta.audio, audioDir)) {
        const placed = placeAudio(extracted, visibleOoxml);
        if (!placed) continue;
        audio.push({
          audioFile: extracted.file,
          ext: extracted.ext,
          bytes: extracted.bytes,
          origin: extracted.origin,
          ...placed,
          loop: extracted.loop,
          volume: extracted.volume,
          playable: extracted.playable,
        });
      }
    }

    // Video embedded in a slide. Its index has to cross from the OOXML's own
    // slide numbering (hidden slides included) into PAGE numbering, which is
    // what `deck_slides` stores — the same shift that would misalign a timing,
    // except a misplaced video is not a slide arriving a beat early: it is a
    // clip playing over the wrong slide, in front of the congregation. So the
    // mapping is built from the same `visibleSlides` list, and when the counts
    // disagree the videos are abandoned outright rather than approximated.
    // Same discipline as `mergeBinaryTimings`.
    const videoDir = path.join(jobDir, "video");
    const videos: NewVideo[] = [];

    if (meta.video.length > 0) {
      const pageIndexByOoxmlIndex = new Map<number, number>();
      visibleSlides.forEach((slide, position) => pageIndexByOoxmlIndex.set(slide.slideIndex, position + 1));
      const mappable = visibleSlides.length === pages.length;

      if (!mappable) {
        console.warn(
          `[slides] ${meta.video.length} embedded video(s) dropped — ${visibleSlides.length} visible slides vs ${pages.length} pages, so no slide they could be placed on with certainty`,
        );
      } else {
        for (const extracted of extractVideoParts(metaResult.parsedFrom, meta.video, videoDir)) {
          const slideIndex = pageIndexByOoxmlIndex.get(extracted.slideIndex);
          // A video on a HIDDEN slide has no page to live on. Not an error:
          // the slide itself was never rendered either.
          if (slideIndex === undefined) continue;
          videos.push({
            slideIndex,
            videoFile: extracted.file,
            ext: extracted.ext,
            bytes: extracted.bytes,
            rect: extracted.rect,
            loop: extracted.loop,
            volume: extracted.volume,
            playable: extracted.playable,
          });
        }
      }
    }

    if (meta.skippedVideoParts.length > 0) {
      console.info(
        `[slides] ${meta.skippedVideoParts.length} embedded video part(s) skipped (not usable): ${meta.skippedVideoParts.join(", ")}`,
      );
    }

    // Commit: move the finished artifacts into place, then insert in one tx.
    // Retried: the WebPs were written milliseconds ago, and on Windows the
    // antivirus or the indexer still has some of them open.
    const finalDir = deckCacheDir(contentHash, target.width, target.format);
    removeQuietly(finalDir);
    fs.mkdirSync(path.dirname(finalDir), { recursive: true });
    await renameWithRetry(imagesDir, finalDir);
    if (fs.existsSync(audioDir)) {
      await renameWithRetry(audioDir, path.join(finalDir, "audio"));
    }
    if (fs.existsSync(videoDir)) {
      await renameWithRetry(videoDir, path.join(finalDir, "video"));
    }

    const aspectRatio = meta.slideSizeEmu
      ? `${meta.slideSizeEmu.cx}:${meta.slideSizeEmu.cy}`
      : null;

    // Every byte in `finalDir` was written by this function, and each writer
    // already reported its size — so the total is a sum, not a directory walk.
    // It used to be `dirSize(finalDir)`: a recursive `readdirSync` plus one
    // `statSync` per file, i.e. ~800 synchronous stats after a 400-slide
    // conversion, on the thread that serves the projection window.
    const bytesOnDisk =
      pages.reduce((total, page) => total + page.bytes + page.thumbBytes, 0) +
      audio.reduce((total, track) => total + track.bytes, 0) +
      videos.reduce((total, video) => total + video.bytes, 0);

    const deckId = getSlidesRepo().insertDeck(
      {
        contentHash,
        renderWidth: target.width,
        imageFormat: target.format,
        converterVersion: SLIDES_CONVERTER_VERSION,
        mediaAssetId: assetId,
        sourcePath,
        sourceSizeBytes: stat.size,
        sourceMtimeMs: Math.trunc(stat.mtimeMs),
        cacheDir: finalDir,
        aspectRatio,
        timingsSource: effectiveTimingsSource,
        bytesOnDisk,
        // A background (prewarm) conversion is "converted just in case", not
        // "used" — backdated past `evictIfOverCap`'s 24h grace so a folder
        // prewarmed and never actually opened is the FIRST thing eviction
        // reclaims, not something immune to it for a full day. Opening it for
        // real calls `touchDeck` (the cache-hit paths above) and promotes it
        // to the front of the LRU like any other real use.
        ...(job.priority === "background" ? { lastUsedAt: Date.now() - 25 * 60 * 60 * 1000 } : {}),
      },
      slides,
      audio,
      videos,
    );

    const row = getSlidesRepo().getDeckById(deckId);
    if (!row) throw new SlideError("RASTER_FAILED", mt("slides.deckUnreadable"));

    const dto = toDeckDTO(row, assetId);
    emitProgress({ assetId, status: "ready", done: dto.slideCount, total: dto.slideCount, error: null });
    evictIfOverCap();
    return dto;
  } catch (error) {
    if (isSlideError(error) && error.slideCode === "SOFFICE_TIMEOUT") {
      consecutiveTimeouts += 1;
      // A profile our own killed process left locked keeps timing out forever.
      if (consecutiveTimeouts >= 2) {
        resetSofficeProfile();
        consecutiveTimeouts = 0;
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    emitProgress({
      assetId,
      status: isSlideError(error) && error.slideCode === "CANCELED" ? "stale" : "failed",
      done: 0,
      total: 0,
      error: message,
    });
    throw error;
  } finally {
    // A failure never leaves garbage behind — and a cleanup that throws here
    // (a file a dying `soffice` still holds on Windows) must not replace the
    // result: a deck already inserted and announced `ready` was then
    // reported to its caller as failed.
    removeQuietly(jobDir);
    // Whether this asset's precomputed PDF/pptx was actually used above or
    // this deck fell back to converting its own, its slot in the shared
    // batch dir (if any) is spent either way.
    releaseBatchDirFor(assetId);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Pre-converts a chunk of background (prewarm) decks' PDFs — and, for
 *  legacy `.ppt`/`.pps`, their `.pptx` timing/audio upgrade — with ONE
 *  `soffice` invocation covering the whole chunk instead of one per file.
 *  This is what makes preparing a folder of hundreds of decks minutes
 *  instead of tens of minutes: LibreOffice's own startup cost, not the
 *  per-file conversion, is what dominates at that scale (see
 *  `libreoffice.ts`'s `convertBatchToPdf`/`convertBatchToPptx`).
 *
 *  Purely an optimization: it populates `precomputedPdfByAsset`/
 *  `precomputedPptxByAsset`, which `runConversion` prefers over its own
 *  single-file `soffice` calls when present — every asset here still goes
 *  through the normal `prepareDeck`/queue/preemption machinery afterward,
 *  unchanged. A file this call fails to produce (interrupted batch, name
 *  mangled beyond matching) just falls back to that normal single-file path,
 *  so a failure here never blocks a conversion, only slows it back down to
 *  what it already was.
 *
 *  Deliberately skips warming while an interactive job is running or
 *  waiting: a batch `soffice` invocation is one process for every file in
 *  it, so soft-preempting it (the operator hitting GO LIVE mid-batch) would
 *  throw away every file's progress, not just one — the opposite of what
 *  preemption is for. The caller (`prewarm-service.ts`) simply proceeds to
 *  convert this chunk's decks one at a time in that case, exactly as before
 *  this optimization existed.
 *
 *  The same reasoning covers the two prioritized background lanes: a deck in
 *  the order of service must not wait a whole chunk's batch conversion, and
 *  preempting the batch to let it through would be worse than not batching. */
export async function warmBatchPdfCache(assetIds: readonly number[]): Promise<void> {
  if (shuttingDown) return;
  if (assetIds.length === 0) return;
  if (interactiveQueue.length > 0 || runningJob?.priority === "interactive") return;
  if (hasQueuedBackground("program", "explicit")) return;

  const mediaRepo = getMediaRepo();
  const statuses = getSlidesRepo().statusesByAsset(assetIds);
  const items: { assetId: number; sourcePath: string; stat: fs.Stats }[] = [];
  for (const assetId of assetIds) {
    if (inFlight.has(assetId)) continue;
    if (statuses.get(assetId)?.status === "ready") continue;
    const sourcePath = mediaRepo.getPathById(assetId);
    if (!sourcePath) continue;
    // Read here instead: the job that follows joins this same read.
    const native = sourceDeck(assetId, sourcePath, false);
    if (native) {
      native.catch(() => undefined);
      continue;
    }
    try {
      const stat = fs.statSync(sourcePath);
      items.push({ assetId, sourcePath, stat });
      precomputedStampByAsset.set(assetId, stampOf(stat));
    } catch {
      // Vanished — the per-file path will report SOURCE_MISSING as usual.
    }
  }
  if (items.length === 0) return;

  const batchDir = path.join(slidesTempDir, randomUUID());
  fs.mkdirSync(batchDir, { recursive: true });
  const totalSize = items.reduce((sum, item) => sum + item.stat.size, 0);
  const timeoutMs = convertTimeoutForBatch(totalSize, items.length);
  const controller = new AbortController();
  batchWarmController = controller;

  try {
    const legacy = items.filter((item) => containerKind(item.sourcePath) === "binary");
    if (legacy.length > 0) {
      const upgradeDir = path.join(batchDir, "upgrade");
      fs.mkdirSync(upgradeDir, { recursive: true });
      try {
        const pptxByPath = await convertBatchToPptx({
          sourcePaths: legacy.map((item) => item.sourcePath),
          outDir: upgradeDir,
          timeoutMs,
          signal: controller.signal,
        });
        for (const item of legacy) {
          const pptx = pptxByPath.get(item.sourcePath);
          if (pptx) precomputedPptxByAsset.set(item.assetId, pptx);
        }
      } catch {
        // Best-effort — every legacy deck falls back to its own upgrade pass.
      }
    }

    // A PDF is already the output of this step, so it is left out of the batch
    // rather than handed to `soffice` — which would re-render it through Draw.
    // `runConversion` rasterizes it straight from its source path, so there is
    // nothing to pre-compute for it and nothing lost by skipping it here.
    const convertible = items.filter((item) => containerKind(item.sourcePath) !== "pdf");
    if (convertible.length > 0) {
      const pdfDir = path.join(batchDir, "pdf");
      fs.mkdirSync(pdfDir, { recursive: true });
      try {
        const pdfByPath = await convertBatchToPdf({
          sourcePaths: convertible.map((item) => item.sourcePath),
          outDir: pdfDir,
          timeoutMs,
          signal: controller.signal,
        });
        for (const item of convertible) {
          const pdf = pdfByPath.get(item.sourcePath);
          if (pdf) precomputedPdfByAsset.set(item.assetId, pdf);
        }
      } catch {
        // Best-effort — every deck falls back to its own PDF conversion.
      }
    }
  } catch {
    // Defensive: warming must never fail the caller's real conversion.
  } finally {
    if (batchWarmController === controller) batchWarmController = null;
  }

  registerBatchDir(
    batchDir,
    items.map((item) => item.assetId),
  );
}

/** Cache-only read: safe to call while merely rendering a list. */
export function getDeck(assetId: number): DeckDTO | null {
  const repo = getSlidesRepo();
  const sourcePath = getMediaRepo().getPathById(assetId);
  const stat = sourcePath ? fs.statSync(sourcePath, { throwIfNoEntry: false }) : undefined;

  const native = repo.findSourceDeckByAsset(assetId, "native");
  if (native && stat && isUsableNative(native, stat)) return toDeckDTO(native, assetId, { resolve: false });
  const model = repo.findSourceDeckByAsset(assetId, "model");
  if (model && stat && isUsableModel(model, stat)) return toDeckDTO(model, assetId, { resolve: false });
  // A .pptx goes to the reader first (`deck:ensure`), for the same reason a
  // legacy deck does.
  if (sourcePath && stat && notModelStamp.get(sourcePath) !== stampOf(stat) && containerKind(sourcePath) === "ooxml") {
    return null;
  }
  // A legacy deck goes to the reader first (`deck:ensure`). Answering with
  // what LibreOffice drew of it before would put urls on screen that the read
  // is about to retire.
  if (sourcePath && stat && notNativeStamp.get(sourcePath) !== stampOf(stat) && containerKind(sourcePath) === "binary") {
    return null;
  }

  const row = repo.findDeckByAsset(assetId);
  if (!row || row.status !== "ready" || row.imageFormat === "native" || row.imageFormat === "model") return null;
  // Not a hit for `tryCacheHit` either, so `ensure` reconverts it — and the new
  // row REPLACES this one (same identity, same cache dir). A deck that went
  // live off this peek lost, mid-service, every slide Chromium had not loaded
  // yet: `worship://deck/<old id>/n` answered 404 under the projector.
  if (row.converterVersion !== SLIDES_CONVERTER_VERSION) return null;
  if (!fs.existsSync(row.cacheDir)) return null;
  // A source edited in place is not a hit — the same size+mtime check as
  // `tryCacheHit`. Without it the renderer, which peeks before it ensures,
  // never ensured at all: an announcements deck fixed during the week
  // previewed AND went live with last week's slides. A source that cannot be
  // stat'ed keeps the cached deck; telling it missing is the sweeper's job.
  if (stat && (row.sourceSizeBytes !== stat.size || row.sourceMtimeMs !== Math.trunc(stat.mtimeMs))) return null;
  return toDeckDTO(row, assetId, { resolve: false });
}

export function cacheStats(): { deckCount: number; bytesOnDisk: number; maxBytes: number } {
  const repo = getSlidesRepo();
  return {
    deckCount: repo.deckCount(),
    bytesOnDisk: repo.totalBytes(),
    maxBytes: cacheMaxBytes(),
  };
}

/**
 * Empties the slide cache completely and answers with what is left.
 *
 * Running conversions are cancelled first: a job that finishes after the wipe
 * would insert a deck row pointing at a directory this just deleted, and the
 * cache would come back non-empty seconds after the operator emptied it.
 *
 * Nothing is spared — not even a pinned deck. Pins exist to stop *eviction*
 * from taking something out from under the projector; an explicit "empty the
 * cache" is the operator saying to do exactly that, and main is in no position
 * to second-guess it (it cannot tell what is live under an overlay). The
 * control window is what warns, because it is the side that knows.
 */
export function clearCache(): { deckCount: number; bytesOnDisk: number; maxBytes: number } {
  cancelBackgroundJobs();
  getSlidesRepo().deleteAllDecks();
  return cacheStats();
}

/** The half of `cacheStats` a background batch asks for between assets: two
 *  numbers, one aggregate query and an in-memory setting. `cacheStats` itself
 *  also counts rows, which that caller never reads. */
export function cacheUsage(): { bytesOnDisk: number; maxBytes: number } {
  return { bytesOnDisk: getSlidesRepo().totalBytes(), maxBytes: cacheMaxBytes() };
}

function cacheMaxBytes(): number {
  return getSettingsRepo().get("slides.cacheMaxMb") * 1024 * 1024;
}

/** Deck ids that must never be evicted, grouped by why — the deck currently
 *  on the projector, and the decks referenced by the loaded/saved program.
 *  Each reason owns its own set so `programs:load` doesn't have to know
 *  whether something is also currently live, and vice versa; eviction just
 *  unions all of them. */
export type PinReason = "projected" | "program";
const pinnedByReason = new Map<PinReason, Set<number>>();

export function pinDecks(reason: PinReason, deckIds: readonly number[]): void {
  pinnedByReason.set(reason, new Set(deckIds));
}

function allPinnedDeckIds(): number[] {
  const all = new Set<number>();
  for (const set of pinnedByReason.values()) {
    for (const id of set) all.add(id);
  }
  return [...all];
}

/** One page of eviction candidates. Big enough that the common case (a few
 *  decks over) is a single query, small enough that it never materializes the
 *  whole cache. */
const EVICTION_PAGE = 64;

export function evictIfOverCap(): void {
  const repo = getSlidesRepo();
  const maxBytes = getSettingsRepo().get("slides.cacheMaxMb") * 1024 * 1024;
  let total = repo.totalBytes();
  if (total <= maxBytes) return;

  const graceCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const pinned = allPinnedDeckIds();
  for (;;) {
    const page = repo.lruCandidates(pinned, graceCutoff, EVICTION_PAGE);
    if (page.length === 0) return;
    for (const row of page) {
      if (total <= maxBytes) return;
      total -= row.bytesOnDisk;
      repo.deleteDeck(row.id);
    }
    if (page.length < EVICTION_PAGE) return;
  }
}

/** Startup housekeeping: a crash skips before-quit entirely, so orphan and
 *  half-finished state is reconciled here rather than on shutdown. */
export function sweepCache(): void {
  const repo = getSlidesRepo();

  fs.rmSync(slidesTempDir, { recursive: true, force: true });
  fs.mkdirSync(slidesTempDir, { recursive: true });

  // First: everything below deletes decks by the folder their row names, and
  // a copied profile's rows name the original profile's folders.
  const adopted = repo.adoptCacheRoot(slidesCacheDir);
  if (adopted.rebased + adopted.forgotten > 0) {
    console.info(`[slides] adopted a copied profile's cache: ${adopted.rebased} deck(s) rebased, ${adopted.forgotten} forgotten`);
  }

  repo.deleteUnfinished();

  // Converted copies a native deck replaced while they were on the projector
  // (`recordNativeDeck`): nothing is on it now.
  const superseded = repo.deleteSupersededBySource([]);
  if (superseded > 0) console.info(`[slides] deleted ${superseded} converted deck(s) now read natively`);

  // Children whose deck row is gone. Never expected (the FK cascades), found
  // in the wild anyway — see `deleteOrphanDeckChildren`. Logged rather than
  // silent: a non-zero count here is the only signal that whatever produces
  // them is still alive.
  const orphans = repo.deleteOrphanDeckChildren();
  if (orphans > 0) console.warn(`[slides] swept ${orphans} orphan deck child row(s)`);

  const known = new Set(repo.allDeckDirs());
  try {
    for (const entry of fs.readdirSync(slidesCacheDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".tmp") continue;
      const full = path.join(slidesCacheDir, entry.name);
      if (!known.has(full)) fs.rmSync(full, { recursive: true, force: true });
    }
  } catch {
    /* best-effort */
  }

  // After the adoption above: it reads each deck's folder.
  revertPlayableCopies();
}

export async function initSlidesSubsystem(): Promise<void> {
  // Everything below is synchronous filesystem work — three `mkdirSync`, a
  // recursive `rm` of the temp dir, a `readdir` of the whole slides cache and
  // an eviction pass. The caller starts this with `void`, which only defers
  // from the FIRST await: without this one the "non-blocking" init ran, in
  // full, on the same tick that was supposed to be opening the window. One
  // event-loop turn is all it takes to let the window get created first.
  await new Promise<void>((resolve) => setImmediate(resolve));

  for (const dir of [slidesCacheDir, slidesTempDir, sofficeProfileDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  try {
    sweepCache();
    evictIfOverCap();
  } catch (error) {
    console.warn("[slides] cache sweep failed", error);
  }

  // Before anything touches the shared profile: a crash of the previous run
  // skipped `before-quit`, and a `soffice` still holding that profile's lock
  // makes every conversion this session fail silently.
  await reapOrphanedSoffice();

  await locateSoffice({ force: true });
  await warmProfile();
}

/** Set by `shutdownSlides`: from then on nothing may start a `soffice`. A
 *  «Prepare folder» batch counted the job `cancelAll` rejected as failed and
 *  went on to the next asset, which could launch a new `soffice` that
 *  outlived the app and held the profile's lock into the next launch. */
let shuttingDown = false;

export function shutdownSlides(): void {
  shuttingDown = true;
  cancelAll();
  killRunningSoffice();
  shutdownRasterizer();
}
