/**
 * How the NDI window's own `<video>` follows the projector's, the one the room hears.
 *
 * Electron gives each window its own renderer, so a Chromium video is decoded twice: the projector's, with the sound
 * NDI captures from the OS, and the NDI window's, whose picture NDI sends. Each starts when its own pipeline is ready,
 * and by the start that offset is fixed for the whole play: measured 2026-11-10 over NDI, the sound came −10…+23 ms
 * after its picture in three starts of five and +227 / +311 ms in the other two. So the NDI copy follows the
 * projector's reported position (`media-status`, ~4 a second): within a frame it plays at its own pace; past it,
 * slower or faster, and only a jump past a second (the operator seeked) is a seek.
 *
 * Ahead and behind are not the same. A copy ahead slows down, which only repeats frames, so it may slow down hard: at
 * most 10 % (until 2026-11-12) every Chromium start reached NDI with its sound +109…+246 ms late, still +13…+128 ms a
 * second later — 2–3 s of lips ahead of the voice (measured over NDI, 6 starts). It is always the copy that starts
 * ahead. A copy behind speeds up, which skips frames: at most 10 %.
 */

/** Past this, the copy jumps: an operator's seek or restart, not drift. */
export const FOLLOW_SEEK_SECONDS = 1;
/** Within this, the copy plays at its own pace: a status report itself is a few ms old. */
const IN_STEP_SECONDS = 0.012;
/** A copy ahead: its drift corrected in about this long, down to half speed. With reports ~250 ms apart, 0.23 s ahead
 *  is in step in ~0.75 s and never overshoots by more than the in-step margin. */
const AHEAD_CATCH_UP_SECONDS = 0.3;
const MAX_SLOW_DOWN = 0.5;
/** A copy behind: in about a second, at most 10 % faster. */
const BEHIND_CATCH_UP_SECONDS = 1;
const MAX_SPEED_UP = 0.1;

/**
 * `own − projector` in seconds, a looping video's wrap taken as the short way round: the projector back at 0.1 s
 * while the copy is still at 9.95 s of a 10 s clip is 0.15 s behind, not 9.85 s ahead.
 */
export function followDrift(own: number, projector: number, durationSeconds: number, loop: boolean): number {
  const drift = own - projector;
  if (!loop || !(durationSeconds > 0)) return drift;
  const half = durationSeconds / 2;
  return ((((drift + half) % durationSeconds) + durationSeconds) % durationSeconds) - half;
}

/** What the copy does about a drift: seek to the projector's position, or play at this rate. */
export function followAction(drift: number): { rate: number } | { seek: true } {
  if (Math.abs(drift) > FOLLOW_SEEK_SECONDS) return { seek: true };
  if (Math.abs(drift) < IN_STEP_SECONDS) return { rate: 1 };
  return drift > 0
    ? { rate: 1 - Math.min(MAX_SLOW_DOWN, drift / AHEAD_CATCH_UP_SECONDS) }
    : { rate: 1 + Math.min(MAX_SPEED_UP, -drift / BEHIND_CATCH_UP_SECONDS) };
}

/** Applies `followAction` to the NDI window's element against the projector's last report. */
export function followProjector(
  element: HTMLMediaElement,
  projectorSeconds: number,
  durationSeconds: number,
  loop: boolean,
): void {
  const action = followAction(followDrift(element.currentTime, projectorSeconds, durationSeconds, loop));
  if ("seek" in action) {
    element.currentTime = projectorSeconds;
    element.playbackRate = 1;
  } else if (element.playbackRate !== action.rate) element.playbackRate = action.rate;
}
