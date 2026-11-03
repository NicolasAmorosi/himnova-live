import fs from "node:fs";
import path from "node:path";
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
import { deckCacheDir, slidesCacheDir, userDataDir } from "../paths";
import { getMediaRepo, getSettingsRepo, getSlidesRepo } from "../services/repos";
import { broadcast } from "../services/broadcast";
import type { DeckRow, NewAudio, NewSlide, NewVideo } from "../db/repositories/slides.repo";
import { SlideError, isSlideError } from "./errors";
import {
  containerKind,
  extractAudioParts,
  placeAudio,
  extractVideoParts,
  type ContainerKind,
  type PresentationMeta,
} from "./pptx-metadata";
import { readBinaryDeck, sniffUnreadableDeck, type BinaryDeck, type UnreadableDeckReason } from "./ppt-binary";
import { encodeSlideLayers } from "./native-deck";
import { readPptx, type PptxRead } from "./pptx-deck";
import { readPdfPages, shutdownRasterizer, type RasterLane } from "./rasterizer";
import { hashFile } from "../media/content-hash";
import { healDeckClips, isEngineClip, revertPlayableCopies } from "../media/deck-clips";
import { removeQuietly } from "../fs-retry";
import { mt } from "../i18n";

// ---------------------------------------------------------------------------
// Render target
// ---------------------------------------------------------------------------

/** What a PDF's pages are drawn at: the projector's width, capped by
 *  Settings, and the image format chosen there. */
export type RenderTarget = {
  width: number;
  format: "webp" | "png";
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
  return { width, format };
}

/** A PDF deck read at a width meaningfully smaller than the projector's is
 *  read again at the new one; upscaling a 1920 page by 25% is invisible on a
 *  projector, and a new deck means new urls for every page in every window. */
function needsRerender(cachedWidth: number, target: RenderTarget): boolean {
  return cachedWidth < target.width * 0.75;
}

/** A file's `(size, mtime)`: what a read is remembered against. */
function stampOf(stat: fs.Stats): string {
  return `${stat.size}-${Math.trunc(stat.mtimeMs)}`;
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

// ---------------------------------------------------------------------------
// Prepare — every deck is read from its source: nothing waits in a queue
// ---------------------------------------------------------------------------

/** `interactive`: the operator is waiting on it (a preview, GO LIVE).
 *  `background`: read ahead — a file just added, a tile on screen, a deck in
 *  the order of service, a «Prepare folder» batch. Only a PDF tells them
 *  apart: it is opened by the rasterizer, where what the operator is looking
 *  at goes first (`RasterLane`). */
export type JobPriority = "interactive" | "background";

export type PrepareOptions = { force?: boolean; priority?: JobPriority };

/** Idempotent per assetId: a second call while a read is in flight joins it. */
export function prepareDeck(assetId: number, opts: PrepareOptions = {}): Promise<DeckDTO> {
  if (shuttingDown) return Promise.reject(new SlideError("CANCELED", mt("slides.shuttingDown")));
  const sourcePath = getMediaRepo().getPathById(assetId);
  if (!sourcePath) return Promise.reject(new SlideError("SOURCE_MISSING", mt("slides.notInLibrary")));
  const lane: RasterLane = opts.priority === "background" ? "later" : "now";
  return (
    sourceDeck(assetId, sourcePath, opts.force ?? false, lane) ??
    Promise.reject(new SlideError("SOURCE_MISSING", mt("slides.sourceGone", { path: sourcePath })))
  );
}

/** Reads ahead, in the background, the decks that are not read yet: a file
 *  just added, a deck put in the order of service, the tiles on screen.
 *
 *  Looks up every asset's status in one query instead of `getDeck()` (a
 *  SELECT + `fs.existsSync` per asset) in the loop — a folder-sized call
 *  here must not cost hundreds of filesystem stats on the main thread just
 *  to decide what's already done. */
export function prewarm(assetIds: readonly number[]): void {
  const statuses = getSlidesRepo().statusesByAsset(assetIds);
  for (const assetId of assetIds) {
    if (statuses.get(assetId)?.status === "ready") continue;
    prepareDeck(assetId, { priority: "background" }).catch(() => undefined);
  }
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
 *  never-set `linked_audio_path` gets picked up without reading the deck
 *  again — every caller in this file wants that, since it's already paying
 *  for a real read or cache hit. `getDeck` (a cache-only, called-on-every-
 *  render lookup) passes `resolve: false`: for a `.ppt`/`.pps` that never had
 *  this resolved yet (e.g. imported by the fast batch import in
 *  `library-import.ts`, or pre-warmed in bulk), resolving means reading the
 *  deck's external objects — exactly the cost that must never happen just
 *  because a tile scrolled into view. `deck:get`'s DTO is "the best we
 *  currently know"; `deck:ensure`'s is authoritative. */
function toDeckDTO(row: DeckRow, assetId: number, opts?: { resolve?: boolean }): DeckDTO {
  const mediaRepo = getMediaRepo();
  if (opts?.resolve !== false) mediaRepo.ensureLinkedAudio(assetId);
  // A `.wmv` on a slide or a WMA soundtrack: handed to the media engine in
  // the background, and announced with `deck-updated` once it is. On `getDeck`
  // too: which clips the engine plays is only known in memory, so a deck
  // cached by an earlier launch and opened with a bare peek would otherwise
  // lose them until something ensured it. Cheap after the first time per
  // launch (`checked`).
  healDeckClips(row.id);
  return getSlidesRepo().toDTO(row, assetId, mediaRepo.linkedAudioPathById(assetId), isEngineClip);
}

// ---------------------------------------------------------------------------
// Native decks — read straight from the source, nothing converted or copied
// ---------------------------------------------------------------------------

/** Binary decks read once and found not to be ones `readBinaryDeck` draws, by
 *  path, with the `(size, mtime)` they were read at: a deck the model reader
 *  draws is not re-read here on every open, and one edited since is read
 *  again. */
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
 * The deck read straight from its source, when it is a legacy deck made of
 * pictures: already on record (answered synchronously) or being read now.
 * `null` sends the caller on to the model reader — a deck that is not a
 * legacy binary, or one `readBinaryDeck` refuses.
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
  // deck passes through here on its way to the model reader or the cache.
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
    if (read) console.info(`[slides] drawn from its model, not read natively (${read.unsupported}): ${sourcePath}`);
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
  // exactly as for any deck.
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

  const row = slidesRepo.getDeckById(deckId);
  if (!row) throw new SlideError("RASTER_FAILED", mt("slides.deckUnreadable"));
  const dto = toDeckDTO(row, assetId);
  emitProgress({ assetId, status: "ready", done: dto.slideCount, total: dto.slideCount, error: null });
  return dto;
}

// ---------------------------------------------------------------------------
// Model decks — drawn from their model (SlideView), nothing rasterized
// ---------------------------------------------------------------------------

/** Decks no reader could open, by path, with the `(size, mtime)` they were
 *  tried at and why: not re-read on every open, and read again once edited. */
const unreadableStamp = new Map<string, { stamp: string; reason: UnreadableDeckReason }>();

/** One read per asset at a time — see `nativeInFlight`. */
const modelInFlight = new Map<number, Promise<DeckDTO>>();

const UNREADABLE_MESSAGE = {
  DECK_PASSWORD: "slides.deckPassword",
  DECK_OLD_FORMAT: "slides.deckOldFormat",
  NOT_A_PRESENTATION: "slides.notAPresentation",
} as const satisfies Record<UnreadableDeckReason, string>;

/** A deck that won't open, failed the way any deck fails: the control window
 *  says why where a failed deck shows (its panel, the PREVIEW monitor, the
 *  GO LIVE toast). Worded on every ask, in the language chosen now. */
function failUnreadable(assetId: number, reason: UnreadableDeckReason): Promise<never> {
  const error = new SlideError(reason, mt(UNREADABLE_MESSAGE[reason]));
  emitProgress({ assetId, status: "failed", done: 0, total: 0, error: error.message });
  return Promise.reject(error);
}

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

/** The deck read straight from its source — native, else its model, else a
 *  PDF — which is every deck: `null` only for a source that is gone. A deck no
 *  reader can open rejects with why. */
function sourceDeck(assetId: number, sourcePath: string, force: boolean, lane: RasterLane): Promise<DeckDTO> | null {
  return nativeDeck(assetId, sourcePath, force) ?? modelDeck(assetId, sourcePath, force) ?? pdfDeck(assetId, sourcePath, force, lane);
}

/**
 * A deck read into a model per slide that `SlideView` draws — a `.pptx` by
 * `src/main/slides/pptx/`, a legacy binary with text and an `.odp` by their
 * own readers (`pptx-worker.ts` picks by container): no images on disk.
 * Decided by the owner on 2026-10-26: what the reader can't draw exactly is
 * approximated, never refused; and on 2026-11-03: nothing is ever converted
 * by another program — a file no reader can open fails, saying why.
 */
function modelDeck(assetId: number, sourcePath: string, force: boolean): Promise<DeckDTO> | null {
  const stat = fs.statSync(sourcePath, { throwIfNoEntry: false });
  if (!stat) return null;
  const inFlightRead = modelInFlight.get(assetId);
  if (inFlightRead) return inFlightRead;

  const slidesRepo = getSlidesRepo();
  const mtimeMs = Math.trunc(stat.mtimeMs);
  if (!force) {
    const own = slidesRepo.findSourceDeckByAsset(assetId, "model");
    if (own && isUsableModel(own, stat)) return Promise.resolve(readyNative(own, assetId));
    const unreadable = unreadableStamp.get(sourcePath);
    if (unreadable?.stamp === stampOf(stat)) return failUnreadable(assetId, unreadable.reason);
  }
  const kind = containerKind(sourcePath);
  if (kind === "pdf") return null;

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
        const reason = sniffUnreadableDeck(sourcePath);
        unreadableStamp.set(sourcePath, { stamp: stampOf(stat), reason });
        return failUnreadable(assetId, reason);
      }
      return recordModelDeck(assetId, sourcePath, stat, read, kind);
    })
    .finally(() => modelInFlight.delete(assetId));
  modelInFlight.set(assetId, promise);
  return promise;
}

async function recordModelDeck(
  assetId: number,
  sourcePath: string,
  stat: fs.Stats,
  deck: PptxRead,
  kind: ContainerKind,
): Promise<DeckDTO> {
  const slidesRepo = getSlidesRepo();
  const mtimeMs = Math.trunc(stat.mtimeMs);
  const contentHash = await hashFile(sourcePath);
  getMediaRepo().setContentHash(assetId, contentHash, stat.size, mtimeMs);

  // Timings, transitions, sound and video come from the reader's
  // `PresentationMeta`; the model is only how the slides look. Both number
  // slides in presentation order, hidden ones included, so the visible ones
  // line up by position — and when they don't, the timings go: advancing on
  // another slide's timing is worse than not. Read on the worker thread with
  // the model (`pptx-worker.ts`).
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
  // cache folder — served from the .pptx by range once the media engine
  // replaces `deck-clips.ts` (plan, phase 3).
  const cacheDir = deckCacheDir(contentHash, 0, "model");
  removeQuietly(cacheDir);
  // Each sound on the slides it plays on (`placeAudio`), counted among the
  // slides drawn — which only the timings that lined up can say.
  const visibleOoxml = timingsUsable ? visibleMeta.map((slide) => slide.slideIndex) : null;
  const audio: NewAudio[] = extractAudioParts(sourcePath, meta.audio, path.join(cacheDir, "audio")).flatMap(
    (extracted) => {
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
    },
  );
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
      timingsSource: timingsUsable && meta.slides.length > 0 ? (kind === "binary" || kind === "odf" ? kind : "ooxml") : "none",
      bytesOnDisk,
    },
    slides,
    audio,
    videos,
  );

  const row = slidesRepo.getDeckById(deckId);
  if (!row) throw new SlideError("RASTER_FAILED", mt("slides.deckUnreadable"));
  const dto = toDeckDTO(row, assetId);
  emitProgress({ assetId, status: "ready", done: dto.slideCount, total: dto.slideCount, error: null });
  return dto;
}

// ---------------------------------------------------------------------------
// PDF decks — each page drawn when a window asks for it, nothing on disk
// ---------------------------------------------------------------------------

/** One read per asset at a time — see `nativeInFlight`. */
const pdfInFlight = new Map<number, Promise<DeckDTO>>();

/** A PDF deck is its page sizes at a render width and format: what it is drawn
 *  at is part of its identity, so changing either setting opens the PDF again
 *  (~25 ms) under new urls, instead of leaving pictures drawn at the old ones
 *  in the windows. */
function isUsablePdf(row: DeckRow, target: RenderTarget): boolean {
  return (
    row.status === "ready" &&
    row.cacheDir === "" &&
    row.converterVersion === SLIDES_CONVERTER_VERSION &&
    row.imageFormat === target.format &&
    !needsRerender(row.renderWidth, target)
  );
}

/**
 * A PDF: opened to read how many pages it has and their size, and each page
 * drawn by pdf.js when a window asks for it (`worship://deck/<id>/<n>`,
 * `pdfPageImage`). Decided by the owner on 2026-11-03: nothing converted and
 * nothing cached on disk. `null` when the source is gone.
 */
function pdfDeck(assetId: number, sourcePath: string, force: boolean, lane: RasterLane): Promise<DeckDTO> | null {
  const stat = fs.statSync(sourcePath, { throwIfNoEntry: false });
  if (!stat) return null;
  const inFlightRead = pdfInFlight.get(assetId);
  if (inFlightRead) return inFlightRead;

  const slidesRepo = getSlidesRepo();
  const mtimeMs = Math.trunc(stat.mtimeMs);
  const target = resolveRenderTarget();
  if (!force) {
    const own = slidesRepo.findDeckByAsset(assetId);
    if (own && own.sourceSizeBytes === stat.size && own.sourceMtimeMs === mtimeMs && isUsablePdf(own, target)) {
      return Promise.resolve(readyNative(own, assetId));
    }
    // The same bytes through another library entry. The stamp has to describe
    // the file on disk first, or a deck edited in place matches its own old
    // digest.
    getMediaRepo().refreshStat(assetId, stat.size, mtimeMs);
    const shared = slidesRepo.findDeckByAssetContent(assetId, target.width, target.format);
    if (shared && isUsablePdf(shared, target)) {
      slidesRepo.relinkDeck(shared.id, assetId, sourcePath, stat.size, mtimeMs);
      return Promise.resolve(
        readyNative({ ...shared, mediaAssetId: assetId, sourcePath, sourceSizeBytes: stat.size, sourceMtimeMs: mtimeMs }, assetId),
      );
    }
  }

  const promise = recordPdfDeck(assetId, sourcePath, stat, target, lane).finally(() => pdfInFlight.delete(assetId));
  pdfInFlight.set(assetId, promise);
  return promise;
}

async function recordPdfDeck(
  assetId: number,
  sourcePath: string,
  stat: fs.Stats,
  target: RenderTarget,
  lane: RasterLane,
): Promise<DeckDTO> {
  const slidesRepo = getSlidesRepo();
  const mtimeMs = Math.trunc(stat.mtimeMs);
  try {
    const [contentHash, pages] = await Promise.all([
      hashFile(sourcePath),
      readPdfPages({ sourcePath, sourceSizeBytes: stat.size, sourceMtimeMs: mtimeMs }, target.width, lane),
    ]);
    if (pages.length === 0) throw new SlideError("RASTER_FAILED", mt("slides.noSlides"));
    // The identity every status question is answered by (`statusesByAsset`).
    getMediaRepo().setContentHash(assetId, contentHash, stat.size, mtimeMs);

    // A PDF carries no presentation structure: no transitions, so no
    // auto-advance, and no media parts, so no embedded soundtrack. A *linked*
    // sibling .mp3 still resolves for it, per asset, like any other deck's
    // (`linked-audio.ts`).
    const slides: NewSlide[] = pages.map((page, index) => ({
      slideIndex: index + 1,
      imageFile: "",
      thumbFile: "",
      widthPx: page.widthPx,
      heightPx: page.heightPx,
      bytes: 0,
      advanceMs: null,
      advanceOnClick: true,
      transition: null,
      hidden: false,
      title: null,
      notes: null,
      layers: null,
    }));

    const deckId = slidesRepo.insertDeck(
      {
        contentHash,
        renderWidth: target.width,
        imageFormat: target.format,
        converterVersion: SLIDES_CONVERTER_VERSION,
        mediaAssetId: assetId,
        sourcePath,
        sourceSizeBytes: stat.size,
        sourceMtimeMs: mtimeMs,
        cacheDir: "",
        aspectRatio: null,
        timingsSource: "none",
        bytesOnDisk: 0,
      },
      slides,
      [],
      [],
    );

    const row = slidesRepo.getDeckById(deckId);
    if (!row) throw new SlideError("RASTER_FAILED", mt("slides.deckUnreadable"));
    const dto = toDeckDTO(row, assetId);
    emitProgress({ assetId, status: "ready", done: dto.slideCount, total: dto.slideCount, error: null });
    return dto;
  } catch (error) {
    emitProgress({
      assetId,
      status: isSlideError(error) && error.slideCode === "CANCELED" ? "stale" : "failed",
      done: 0,
      total: 0,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Cache-only read: safe to call while merely rendering a list. */
export function getDeck(assetId: number): DeckDTO | null {
  const repo = getSlidesRepo();
  const sourcePath = getMediaRepo().getPathById(assetId);
  const stat = sourcePath ? fs.statSync(sourcePath, { throwIfNoEntry: false }) : undefined;

  const native = repo.findSourceDeckByAsset(assetId, "native");
  if (native && stat && isUsableNative(native, stat)) return toDeckDTO(native, assetId, { resolve: false });
  const model = repo.findSourceDeckByAsset(assetId, "model");
  if (model && stat && isUsableModel(model, stat)) return toDeckDTO(model, assetId, { resolve: false });
  // Every other deck is read from its source (`deck:ensure`).
  if (!sourcePath || !stat || containerKind(sourcePath) !== "pdf") return null;

  const row = repo.findDeckByAsset(assetId);
  if (!row || row.status !== "ready" || row.imageFormat === "native" || row.imageFormat === "model") return null;
  // Not a hit for `pdfDeck` either, so `ensure` reads it again — and the new
  // row REPLACES this one (same identity). A deck that went live off this peek
  // lost, mid-service, every slide Chromium had not loaded yet:
  // `worship://deck/<old id>/n` answered 404 under the projector.
  if (row.converterVersion !== SLIDES_CONVERTER_VERSION || row.cacheDir !== "") return null;
  // A source edited in place is not a hit — the same size+mtime check as
  // `pdfDeck`. Without it the renderer, which peeks before it ensures, never
  // ensured at all: an announcements deck fixed during the week previewed AND
  // went live with last week's slides. Its pages are drawn from that file.
  if (row.sourceSizeBytes !== stat.size || row.sourceMtimeMs !== Math.trunc(stat.mtimeMs)) return null;
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
 * Nothing is spared — not even a pinned deck. Pins exist to stop *eviction*
 * from taking something out from under the projector; an explicit "empty the
 * cache" is the operator saying to do exactly that, and main is in no position
 * to second-guess it (it cannot tell what is live under an overlay). The
 * control window is what warns, because it is the side that knows.
 */
export function clearCache(): { deckCount: number; bytesOnDisk: number; maxBytes: number } {
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

  // First: everything below deletes decks by the folder their row names, and
  // a copied profile's rows name the original profile's folders.
  const adopted = repo.adoptCacheRoot(slidesCacheDir);
  if (adopted.rebased + adopted.forgotten > 0) {
    console.info(`[slides] adopted a copied profile's cache: ${adopted.rebased} deck(s) rebased, ${adopted.forgotten} forgotten`);
  }

  repo.deleteUnfinished();

  // What a build before 2026-11-03 drew to disk: a PDF's pages, rasterized
  // once, and the decks LibreOffice converted. Every such deck is read from
  // its source on its next open (owner: nothing converted, nothing cached).
  const rasterized = repo.deleteRasterizedDecks();
  if (rasterized > 0) console.info(`[slides] deleted ${rasterized} deck(s) drawn to disk; read from their source from now on`);
  // And LibreOffice's own profile those builds kept.
  removeQuietly(path.join(userDataDir, "soffice-profile"));

  // Children whose deck row is gone. Never expected (the FK cascades), found
  // in the wild anyway — see `deleteOrphanDeckChildren`. Logged rather than
  // silent: a non-zero count here is the only signal that whatever produces
  // them is still alive.
  const orphans = repo.deleteOrphanDeckChildren();
  if (orphans > 0) console.warn(`[slides] swept ${orphans} orphan deck child row(s)`);

  const known = new Set(repo.allDeckDirs());
  try {
    for (const entry of fs.readdirSync(slidesCacheDir, { withFileTypes: true })) {
      // `.tmp` included: where a PDF used to be rasterized.
      if (!entry.isDirectory()) continue;
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

  fs.mkdirSync(slidesCacheDir, { recursive: true });

  try {
    sweepCache();
    evictIfOverCap();
  } catch (error) {
    console.warn("[slides] cache sweep failed", error);
  }
}

/** Set by `shutdownSlides`: from then on nothing may start. A «Prepare
 *  folder» batch counted a deck the quit rejected as failed and went on to
 *  the next asset, which started new work while the app was quitting. */
let shuttingDown = false;

export function shutdownSlides(): void {
  shuttingDown = true;
  shutdownRasterizer();
}
