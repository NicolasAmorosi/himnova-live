import fs from "node:fs";
import path from "node:path";
import { getSlidesRepo } from "../services/repos";
import { broadcast } from "../services/broadcast";
import { currentDecoderSupport } from "./engine-assets";
import { ffmpegAvailable, probeMedia } from "./ffmpeg";
import { parseProbe, playsNatively } from "./media-compat";
import { engineAvailable } from "./media-engine";

/**
 * A video or soundtrack embedded in a `.pptx` that Chromium cannot play — a
 * `.wmv` on a slide, a WMA as the deck's music — is played by the media engine
 * (step 1.3 of the engine plan, 2026-10-30). The decision depends on this
 * machine, so it is kept in memory and made again every launch, the first time
 * a deck is opened, like `engine-assets.ts` does for a library file.
 *
 * Until step 1.4 (2026-11-02) such a clip was converted into a playable copy
 * next to the original; `revertPlayableCopies` takes every row back to its
 * original at startup and deletes the copy. A build with no engine plays the
 * clip through Chromium, and it fails like a damaged file (owner, 2026-11-02).
 *
 * MIDI is left alone: it is a score, not a recording, and neither Chromium nor
 * the engine has a synthesizer to turn it into sound.
 */

/** An extension the extractor did not recognize is saved as `.bin` and is
 *  still probed: ffprobe reads the content, not the name. */
const UNPLAYABLE_EXT = new Set(["mid", "midi"]);

/** Clip rows already looked at this launch — a deck is opened many times. */
const checked = new Set<string>();
/** The clips the media engine plays (`engineClipUrl`), by `<kind>:<id>`. */
const engineClips = new Set<string>();
let chain: Promise<void> = Promise.resolve();
let stopped = false;

type Clip = { kind: "video" | "audio"; id: number; dir: string; file: string; ext: string; playable: boolean };

/** The file a playable copy (`<n>.playable.mp4`) was made from: the one next to
 *  it with the same `<n>`, as `pptx-metadata` named it. */
function originalOf(dir: string, copy: string): string | null {
  const n = /^(.+)\.playable\.(?:mp4|m4a)$/.exec(copy)?.[1];
  if (n === undefined) return null;
  return fs.readdirSync(dir).find((file) => file.startsWith(`${n}.`) && !file.includes(".playable.")) ?? null;
}

/** Startup, before any deck is opened: every clip on a playable copy goes back to its original, which
 *  only the engine plays, and the copy is deleted. A copy whose original is gone stays as it is. */
export function revertPlayableCopies(): void {
  const repo = getSlidesRepo();
  let reverted = 0;
  for (const clip of repo.clipsOnPlayableCopies()) {
    const dir = path.join(clip.cacheDir, clip.kind);
    try {
      const original = originalOf(dir, clip.file);
      if (!original) continue;
      const bytes = fs.statSync(path.join(dir, original)).size;
      repo.updateClip(clip.kind, clip.id, original, path.extname(original).slice(1), bytes, false);
      fs.rmSync(path.join(dir, clip.file), { force: true });
      reverted += 1;
    } catch (error) {
      console.warn(`[engine] could not revert the playable copy ${clip.file}`, error);
    }
  }
  if (reverted > 0) console.info(`[engine] ${reverted} slide clip(s) back on their original`);
}

async function healClip(clip: Clip): Promise<boolean> {
  const decoders = currentDecoderSupport();
  if (!decoders) return false;
  const input = path.join(clip.dir, clip.file);
  const probe = parseProbe(await probeMedia(input));
  // The app quit while ffprobe ran: the database may already be closed.
  if (!probe || stopped) return false;
  if (playsNatively(probe, clip.kind, decoders)) {
    if (clip.playable) return false;
    // Flagged unplayable by its extension (an `.mkv`), playable by content.
    getSlidesRepo().updateClip(clip.kind, clip.id, clip.file, clip.ext, fs.statSync(input).size);
    return true;
  }
  if (!engineAvailable()) return false;
  engineClips.add(`${clip.kind}:${clip.id}`);
  console.info(`[engine] slide clip ${clip.file}`);
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
    if (checked.has(key) || UNPLAYABLE_EXT.has(clip.ext)) return false;
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
 *  nothing to do; serialized, so two decks never probe at once. */
export function healDeckClips(deckId: number): void {
  if (stopped || !ffmpegAvailable() || !currentDecoderSupport()) return;
  chain = chain
    .then(() => healDeck(deckId))
    .catch((error: unknown) => console.warn("[engine] slide clips failed", error));
}

/** `before-quit`: nothing new starts. A probe still running is killed by `killAllFfmpeg`. */
export function stopDeckClips(): void {
  stopped = true;
}
