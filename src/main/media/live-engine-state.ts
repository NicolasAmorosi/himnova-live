import { isEngineUrl } from "@shared/urls";
import type { AudioTrackPush, ProjectionOutput } from "@shared/types/projection";

/** What a live engine video session has to be right now (`engine-sessions.ts`). */
export type LiveEngineState = {
  url: string;
  epoch: number;
  startAtSeconds: number;
  paused: boolean;
  volume: number;
  loop: boolean;
};

/**
 * The live session, from the last output the projector was sent and whether the projector exists:
 * `null` unless the full-screen video is one only the engine plays.
 *
 * Pure, so the rule is tested where the rest of the suite lives. It is the `shouldPlay` the
 * projector's own `<video>` follows (`LiveVideo`: not covered by BLACK/LOGO, not paused by the
 * operator), plus the projector itself: the sound comes from the engine now, so closing the
 * projector has to silence it the way closing its window silenced a `<video>` (owner, 2026-10-30).
 */
export function liveEngineState(output: ProjectionOutput | null, projectorOpen: boolean): LiveEngineState | null {
  const video = output?.videoUnderlay;
  if (!output || !video || !isEngineUrl(video.url)) return null;
  return {
    url: video.url,
    epoch: video.epoch,
    startAtSeconds: video.startAtSeconds,
    paused: video.paused || output.kind !== "video" || !projectorOpen,
    volume: video.volume,
    loop: video.loop,
  };
}

/**
 * The live slide's own clip, by the same rule as `liveEngineState`: `SlideVideoLayer` plays it while
 * the slide is the output and the operator has not paused it, and it loops when the file says so.
 * An ended clip stays on its slide, and the engine (mpv's `keep-open`) holds its last frame — so
 * uncovering it does not play it again, as uncovering an ended `<video>` did not.
 */
export function liveEngineSlideVideo(output: ProjectionOutput | null, projectorOpen: boolean): LiveEngineState | null {
  const video = output?.slideVideo;
  if (!output || !video || !isEngineUrl(video.url)) return null;
  return {
    url: video.url,
    epoch: video.epoch,
    startAtSeconds: video.startAtSeconds,
    paused: video.paused || output.kind !== "slide" || !projectorOpen,
    volume: video.volume,
    loop: video.loop,
  };
}

/** A live song's video background (`SongVideo`), when the engine plays it: silent, looping, and
 *  paused — never stopped — under BLACK/LOGO or with no projector, like the slide's clip. */
export function liveEngineSongVideo(output: ProjectionOutput | null, projectorOpen: boolean): LiveEngineState | null {
  const video = output?.songVideo;
  if (!output || !video || !isEngineUrl(video.url)) return null;
  return {
    url: video.url,
    epoch: video.epoch,
    startAtSeconds: 0,
    paused: output.kind !== "song" || !projectorOpen,
    volume: 0,
    loop: true,
  };
}

/**
 * The live audio tracks the engine plays, from the last `AudioTrackPush[]`: only those with an engine
 * url, each paused as well while there is no projector. The control window already folded BLACK/LOGO
 * into the deck soundtrack's `paused`, and a standalone track ignores them on purpose
 * (`projection-sync.ts`); closing the projector silenced every `<audio>` with its window, and the
 * engine's tracks do the same (owner, 2026-10-30).
 */
export function liveEngineAudio(tracks: AudioTrackPush[], projectorOpen: boolean): AudioTrackPush[] {
  return tracks
    .filter((track) => isEngineUrl(track.url))
    .map((track) => ({ ...track, paused: track.paused || !projectorOpen }));
}

/** How long a live session that should play may keep the same position before it is nudged. */
export const ENGINE_STALL_MS = 3_000;
export type StallWatch = { time: number; since: number; nudged: boolean };

/**
 * A live session that should be playing but whose position stopped. Twice in ~110 E2E runs a WMA
 * resumed after the projector was reopened stayed where it was (`media-engine.spec`), never on demand:
 * the commands reach the engine in order, so the stall is inside it. Nudged once per stall —
 * `resume` when the engine says it is still paused, else `seek` to where it is, which restarts
 * mpv's decoding and audio output — and main logs it, so a real one leaves a trace.
 */
export function watchStall(
  prev: StallWatch | null,
  status: { time: number; paused: boolean; ended: boolean },
  wantPaused: boolean,
  now: number,
): { next: StallWatch | null; nudge: "resume" | "seek" | null } {
  if (wantPaused || status.ended) return { next: null, nudge: null };
  if (!prev || prev.time !== status.time) return { next: { time: status.time, since: now, nudged: false }, nudge: null };
  if (prev.nudged || now - prev.since < ENGINE_STALL_MS) return { next: prev, nudge: null };
  return { next: { ...prev, nudged: true }, nudge: status.paused ? "resume" : "seek" };
}
