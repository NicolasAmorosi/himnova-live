import { isEngineUrl } from "@shared/urls";
import type { AudioTrackPush, MediaStatus, MediaTarget, ProjectionOutput } from "@shared/types/projection";

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

/** What a running engine session plays and was last told (`engine-sessions.ts`); `engine` is a `MediaEngine`. */
export type EngineSession = {
  engine: { setPaused(paused: boolean): void; setVolume(volume: number): void; setLoop(loop: boolean): void } | null;
  url: string;
  epoch: number;
  paused: boolean;
  volume: number;
  loop: boolean;
};

/** Whether a running session keeps its engine for `want`: the same file in the same epoch only pauses,
 *  resumes or changes its level, so BLACK/LOGO keep its position. Anything else is a new file in a new
 *  engine — GO LIVE again is a new epoch (owner, 2026-10-30). */
export function keepsSession(session: { url: string; epoch: number }, want: { url: string; epoch: number } | null): boolean {
  return want !== null && want.epoch === session.epoch && want.url === session.url;
}

/** A live session already playing its file: only what can change without a new epoch. */
export function applyToSession(session: EngineSession, want: { paused: boolean; volume: number; loop?: boolean }): void {
  if (want.paused !== session.paused) session.engine?.setPaused(want.paused);
  if (want.volume !== session.volume) session.engine?.setVolume(want.volume);
  if (want.loop !== undefined && want.loop !== session.loop) session.engine?.setLoop(want.loop);
  session.paused = want.paused;
  session.volume = want.volume;
  session.loop = want.loop ?? session.loop;
}

/** A live session's engine report as the control window hears it (`media-status`), the way the projector's
 *  own elements report theirs: its end is what moves «Al terminar» and takes an ended video off the air. */
export function liveMediaStatus(
  target: MediaTarget,
  epoch: number,
  status: { time: number; duration: number; paused: boolean; ended: boolean },
): MediaStatus {
  return {
    target,
    epoch,
    currentTimeSeconds: status.time,
    durationSeconds: status.duration,
    paused: status.paused,
    ended: status.ended,
  };
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
