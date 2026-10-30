import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getSlidesRepo } from "../services/repos";
import { renameWithRetry } from "../fs-retry";
import { broadcast } from "../services/broadcast";
import { currentDecoderSupport } from "./conversion-service";
import { encoderThreads, ffmpegAvailable, probeMedia, runFfmpeg } from "./ffmpeg";
import { conversionArgs, encodeEverything, parseProbe, planPlayback } from "./media-compat";
import { engineAvailable } from "./media-engine";

/**
 * A video or soundtrack embedded in a `.pptx` that Chromium cannot play — a
 * `.wmv` on a slide, a WMA as the deck's music — made playable inside the
 * deck's own cache directory, next to the extracted original.
 *
 * Done lazily, the first time per launch a deck is opened, rather than as part
 * of its conversion: that is what fixes decks converted BEFORE this existed
 * without bumping `SLIDES_CONVERTER_VERSION`, which would reconvert every deck
 * in the library (~1235 of them) to fix the handful that have such a clip.
 *
 * The row is updated in place, so the clip's id and url never change and the
 * renderer only needs to re-read the deck (`deck-updated`). Being inside the
 * content-addressed cache, the converted clip is evicted with its deck.
 *
 * MIDI is left alone: it is a score, not a recording, and ffmpeg has no
 * synthesizer to turn it into sound.
 *
 * Since step 1.3 of the engine plan (2026-10-30) such a clip is not converted
 * when the build has the media engine: it is marked for the engine instead, in
 * memory, as `conversion-service` marks a library file — the decision depends
 * on this machine and is made again every launch. Only a build with no engine
 * still converts.
 */

/** An extension the extractor did not recognize is saved as `.bin` and is
 *  still probed: ffprobe reads the content, not the name. */
const UNCONVERTIBLE_EXT = new Set(["mid", "midi"]);

/** Clip rows already looked at this launch — a deck is opened many times. */
const checked = new Set<string>();
/** The clips the media engine plays (`engineClipUrl`), by `<kind>:<id>`. */
const engineClips = new Set<string>();
let chain: Promise<void> = Promise.resolve();
/** Aborted on quit (`stopDeckClips`). Without it, `killAllFfmpeg` made the
 *  remux fail and the fallback below started a fresh encode AFTER the kill,
 *  one that outlived the app. */
const shutdown = new AbortController();

type Clip = { kind: "video" | "audio"; id: number; dir: string; file: string; ext: string; playable: boolean };

/** The file an earlier build's playable copy (`<n>.playable.mp4`) was made
 *  from: the one next to it with the same `<n>`, as `pptx-metadata` named it. */
function originalOf(clip: Clip): string | null {
  const copy = /^(.+)\.playable\.(?:mp4|m4a)$/.exec(clip.file);
  if (!copy) return null;
  return fs.readdirSync(clip.dir).find((file) => file.startsWith(`${copy[1]}.`) && !file.includes(".playable.")) ?? null;
}

async function healClip(found: Clip): Promise<boolean> {
  const decoders = currentDecoderSupport();
  if (!decoders) return false;
  // A clip an earlier build converted goes back to its original, which the engine plays: one path
  // (owner, 2026-10-30). The copy stays on disk until the conversion goes (plan step 1.4).
  const original = engineAvailable() ? originalOf(found) : null;
  const clip = original ? { ...found, file: original, ext: path.extname(original).slice(1), playable: false } : found;
  const input = path.join(clip.dir, clip.file);
  const probe = parseProbe(await probeMedia(input));
  if (!probe) return false;
  const plan = planPlayback(probe, clip.kind, decoders);
  if (plan.kind === "native") {
    if (clip.playable) return false;
    // Flagged unplayable by its extension (an `.mkv`), playable by content.
    getSlidesRepo().updateClip(clip.kind, clip.id, clip.file, clip.ext, fs.statSync(input).size);
    return true;
  }
  if (engineAvailable()) {
    if (original) getSlidesRepo().updateClip(clip.kind, clip.id, clip.file, clip.ext, fs.statSync(input).size, false);
    engineClips.add(`${clip.kind}:${clip.id}`);
    console.info(`[engine] slide clip ${clip.file}`);
    return true;
  }

  const ext = clip.kind === "audio" ? "m4a" : "mp4";
  const file = `${path.parse(clip.file).name}.playable.${ext}`;
  const output = path.join(clip.dir, file);
  const part = `${output}.part`;
  const { signal } = shutdown;
  try {
    try {
      await runFfmpeg(conversionArgs(input, part, probe, plan, encoderThreads()), { signal });
    } catch (error) {
      const encoded = encodeEverything(plan);
      if (signal.aborted || encoded.kind === "native") throw error;
      await runFfmpeg(conversionArgs(input, part, probe, encoded, encoderThreads()), { signal });
    }
    await renameWithRetry(part, output);
  } catch (error) {
    await fsp.rm(part, { force: true }).catch(() => undefined);
    console.warn(`[convert] slide clip failed: ${input}`, error);
    return false;
  }
  getSlidesRepo().updateClip(clip.kind, clip.id, file, ext, fs.statSync(output).size);
  console.info(`[convert] slide clip ${clip.file} → ${file}`);
  return true;
}

async function healDeck(deckId: number): Promise<void> {
  const repo = getSlidesRepo();
  const deck = repo.getDeckById(deckId);
  if (!deck) return;
  const clips: Clip[] = [
    ...repo.listVideos(deckId).map((row) => ({
      kind: "video" as const,
      id: row.id,
      dir: path.join(deck.cacheDir, "video"),
      file: row.videoFile,
      ext: row.ext,
      playable: row.playable === 1,
    })),
    ...repo.listAudio(deckId).map((row) => ({
      kind: "audio" as const,
      id: row.id,
      dir: path.join(deck.cacheDir, "audio"),
      file: row.audioFile,
      ext: row.ext,
      playable: row.playable === 1,
    })),
  ].filter((clip) => {
    const key = `${clip.kind}:${clip.id}`;
    if (checked.has(key) || UNCONVERTIBLE_EXT.has(clip.ext)) return false;
    checked.add(key);
    return true;
  });

  let changed = false;
  for (const clip of clips) {
    // An already-playable `.mp4` can still hold an MPEG-4 part 2 picture —
    // the same silent black-with-sound case as a library file.
    if (await healClip(clip)) changed = true;
  }
  if (changed) broadcast("deck-updated", { deckId });
}

/** Whether the media engine plays this clip, for the deck's DTO. */
export function isEngineClip(kind: "audio" | "video", id: number): boolean {
  return engineClips.has(`${kind}:${id}`);
}

/** Called whenever a deck's authoritative DTO is built. Cheap when there is
 *  nothing to do; serialized, so two decks never encode at once. */
export function healDeckClips(deckId: number): void {
  if (shutdown.signal.aborted || !ffmpegAvailable() || !currentDecoderSupport()) return;
  chain = chain
    .then(() => healDeck(deckId))
    .catch((error: unknown) => console.warn("[convert] slide clips failed", error));
}

/** `before-quit`: nothing new starts, and what runs is cancelled. */
export function stopDeckClips(): void {
  shutdown.abort();
}
