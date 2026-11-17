import fs from "node:fs";
import fsp from "node:fs/promises";
import { convertedMediaDir } from "../paths";
import { getConversionsRepo, getMediaRepo } from "../services/repos";
import { broadcast } from "../services/broadcast";
import type { ConversionCandidate } from "../db/repositories/conversions.repo";
import { ffmpegAvailable, killAllFfmpeg, probeMedia } from "./ffmpeg";
import { engineAvailable, engineGaveUp, onEngineGaveUp } from "./media-engine";
import {
  ENGINE_PLAYS_EVERY_PICTURE,
  MEDIA_PROBE_VERSION,
  normalizeProbe,
  parseProbe,
  playsNatively,
  playsOnEngine,
  type MediaProbe,
} from "./media-compat";
import type { DecoderSupport } from "@shared/types/media";

/**
 * Which library videos and audios the media engine plays (`engineAssetUrl`): the ones Chromium
 * cannot decode, and on Windows every video (`media-compat.ts` decides which). Everything else stays on
 * `<video>`/`<audio>`.
 * Plan §6, step 1: the engine replaced the conversion to a playable copy (step 1.4, 2026-11-02).
 *
 * The decision is kept in memory and made again every launch: one input to it — can this GPU decode
 * HEVC? — belongs to the machine, not to the file. What is persisted is only the probe
 * (`media_conversions`), stamped with the bytes it describes.
 *
 * A file with an extension Chromium does not open goes to the engine the moment it is seen, before
 * ffprobe has looked at it: an AVI dropped on the library plays at once instead of after the rest
 * of a 300-file folder has been probed. The probe then decides, and gives the engine's audio its
 * length (`probedDuration`).
 *
 * A build with no engine plays everything through Chromium, and what it cannot decode fails like a
 * damaged file (owner, 2026-11-02). Nothing is probed there: nothing would change.
 *
 * Reconciling waits for `setDecoderSupport`: until the control window has said whether this GPU
 * decodes HEVC, nothing can be decided about an HEVC file.
 */

/** Extensions Chromium opens at all. */
const LIKELY_NATIVE_EXT = new Set([
  ...["mp4", "m4v", "mov", "3gp", "mkv", "webm", "ogv"],
  ...["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac", "weba"],
]);

/** Coalesces the burst of "the library changed" calls an import makes. */
const RECONCILE_DEBOUNCE_MS = 300;

let decoders: DecoderSupport | null = null;
const engineAssets = new Set<number>();
/** Files whose engine died under them (it exited, or its GPU failed: not the file) and that Chromium plays: back on
 *  `<video>`/`<audio>` for the rest of the session (owner, 2026-11-17). */
const refused = new Set<number>();
/** Rows whose probe said "unreadable", re-probed once this launch: a timeout
 *  or a file still being copied must not be taken for a broken file forever. */
const reprobed = new Set<number>();
let reconciling = false;
let reconcileAgain = false;
let reconcileTimer: NodeJS.Timeout | null = null;
let shutDown = false;

function setEngine(assetId: number, engine: boolean): void {
  if (engineAssets.has(assetId) === engine) return;
  if (engine) engineAssets.add(assetId);
  else engineAssets.delete(assetId);
  broadcast("engine-asset-changed", { assetId, engine });
}

function probeIsCurrent(c: ConversionCandidate): boolean {
  return (
    c.probe !== null &&
    c.probe.probeVersion === MEDIA_PROBE_VERSION &&
    c.probe.sourceSize === c.sizeBytes &&
    c.probe.sourceMtimeMs === c.mtimeMs
  );
}

function storedProbe(c: ConversionCandidate): MediaProbe | null {
  if (!c.probe?.probeJson) return null;
  try {
    return normalizeProbe(JSON.parse(c.probe.probeJson));
  } catch {
    return null;
  }
}

/** By the probe once there is one; by the kind and the extension until then, and for a file ffprobe cannot read. */
function needsEngine(c: ConversionCandidate, caps: DecoderSupport): boolean {
  const probe = probeIsCurrent(c) ? storedProbe(c) : null;
  // Every picture on Windows until the engine fails for good, or under this very file: what Chromium plays is then
  // Chromium's again (owner, 2026-11-17).
  const everyPicture = ENGINE_PLAYS_EVERY_PICTURE && !engineGaveUp() && !refused.has(c.id);
  if (probe) return playsOnEngine(probe, c.kind, caps, everyPicture);
  return (everyPicture && c.kind === "video") || !LIKELY_NATIVE_EXT.has(c.ext);
}

/**
 * A live engine died under this library file (`engine-exit`, `engine-gpu`). If its probe says Chromium plays it, it
 * goes back to Chromium for the rest of the session and the renderer re-points what is live at the same position
 * (`engine-asset-changed`, `effects/engine-assets-sync.ts`): true. False when Chromium cannot, and then the failure
 * is the operator's, as before.
 */
export function engineFailedOn(assetId: number): boolean {
  if (decoders === null) return false;
  const [c] = getConversionsRepo().candidates(assetId);
  const probe = c && probeIsCurrent(c) ? storedProbe(c) : null;
  if (!c || !probe || !playsNatively(probe, c.kind, decoders)) return false;
  refused.add(assetId);
  setEngine(assetId, false);
  return true;
}

async function probeAndRecord(c: ConversionCandidate): Promise<ConversionCandidate | null> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(c.path);
  } catch {
    // Vanished since the library saw it: the sweep, or the next listing of its linked folder, marks it missing.
    return null;
  }
  const probe = parseProbe(await probeMedia(c.path));
  // The app quit while ffprobe ran: the database is already closed.
  if (shutDown) return null;
  // Stamped with what the LIBRARY believes about the file when it has an
  // answer, so the stamp matches the row and this does not re-probe on every
  // reconcile until the sweep catches up with an edit.
  const sourceSize = c.sizeBytes ?? stat.size;
  const sourceMtimeMs = c.mtimeMs ?? Math.trunc(stat.mtimeMs);
  const probeJson = probe ? JSON.stringify(probe) : null;
  try {
    getConversionsRepo().recordProbe(c.id, sourceSize, sourceMtimeMs, MEDIA_PROBE_VERSION, probeJson);
  } catch (error) {
    // The asset was deleted (or merged away by a relocate) while ffprobe ran:
    // its FK is gone. One file, not the whole pass.
    console.warn(`[engine] could not record the probe of ${c.path}`, error);
    return null;
  }
  return { ...c, probe: { sourceSize, sourceMtimeMs, probeVersion: MEDIA_PROBE_VERSION, probeJson } };
}

async function reconcileOnce(caps: DecoderSupport): Promise<void> {
  const candidates = getConversionsRepo().candidates();

  // Removed or gone missing since the last pass. Not a row a relocate merged away: what is on the air under it plays
  // on as it went out, and the renderer hears of the merge only once the whole move is followed; told first, it
  // re-pointed an engine video on air at a `<video>` Chromium cannot open (2026-11-15 audit, D4).
  const present = new Set(candidates.map((c) => c.id));
  for (const id of [...engineAssets]) {
    if (!present.has(id) && getMediaRepo().survivingId(id) === id) setEngine(id, false);
  }

  const unprobed: ConversionCandidate[] = [];
  for (const c of candidates) {
    setEngine(c.id, needsEngine(c, caps));
    const unreadable = probeIsCurrent(c) && c.probe?.probeJson === null;
    if (!probeIsCurrent(c) || (unreadable && !reprobed.has(c.id))) {
      if (unreadable) reprobed.add(c.id);
      unprobed.push(c);
    }
  }
  if (!ffmpegAvailable()) return;
  for (const c of unprobed) {
    if (shutDown) return;
    const probed = await probeAndRecord(c);
    if (probed) setEngine(c.id, needsEngine(probed, caps));
  }
}

async function reconcile(): Promise<void> {
  if (shutDown || decoders === null || !engineAvailable()) return;
  if (reconciling) {
    reconcileAgain = true;
    return;
  }
  reconciling = true;
  try {
    do {
      reconcileAgain = false;
      await reconcileOnce(decoders);
    } while (reconcileAgain && !shutDown);
  } catch (error) {
    console.warn("[engine] reconcile failed", error);
  } finally {
    reconciling = false;
  }
}

function scheduleReconcile(delayMs = RECONCILE_DEBOUNCE_MS): void {
  if (shutDown) return;
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    void reconcile();
  }, delayMs);
}

/** Startup. The playable copies builds before step 1.4 made go: nothing plays them any more. */
export function initEngineAssets(): void {
  onEngineGaveUp(() => {
    // Only Windows plays a picture Chromium could on the engine: elsewhere nothing moves, and the files only the
    // engine plays say their own failure when they are played.
    if (ENGINE_PLAYS_EVERY_PICTURE) broadcast("engine-fallback", undefined);
    scheduleReconcile(0);
  });
  void fsp
    .rm(convertedMediaDir, { recursive: true, force: true })
    .catch((error: unknown) => console.warn("[engine] could not delete the old converted copies", error));
  if (!ffmpegAvailable()) console.warn("[engine] bundled FFmpeg not found — run scripts/fetch-binaries.ts");
}

/** From the control window at startup. The first report starts everything; a
 *  later identical one (a reloaded renderer) changes nothing. */
export function setDecoderSupport(caps: DecoderSupport): void {
  const changed = decoders === null || decoders.hevc !== caps.hevc || decoders.hevcMain10 !== caps.hevcMain10;
  decoders = caps;
  if (changed) scheduleReconcile(0);
}

/** What the control window reported, or null before its first report. */
export function currentDecoderSupport(): DecoderSupport | null {
  return decoders;
}

/** Something about the library's videos or audios may have changed. */
export function notifyMediaChanged(): void {
  scheduleReconcile();
}

/** Every library asset the engine plays. */
export function listEngineAssets(): number[] {
  return [...engineAssets];
}

/** Seconds, from the stored probe. */
export function probedDuration(assetId: number): number | null {
  const c = getConversionsRepo().candidates(assetId)[0];
  return (c && storedProbe(c)?.durationSec) ?? null;
}

/** The asset was deleted. */
export function forgetEngineAsset(assetId: number): void {
  setEngine(assetId, false);
}

/** `before-quit`: synchronous, like every other shutdown chore. */
export function shutdownEngineAssets(): void {
  shutDown = true;
  if (reconcileTimer) clearTimeout(reconcileTimer);
  killAllFfmpeg();
}
