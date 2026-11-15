/**
 * The stage screen's rules, as pure functions (`tests/renderer/stage.test.ts`): which layout shows, which colour
 * the countdown is, and what it reads. Shared by the stage window and the stage panel's monitor, which draw the
 * same `StageView`.
 */
import { formatSignedSeconds, timerDisplaySeconds } from "./timer";
import type { CountdownClock, StageCountdown, StageLayout, StageLayoutChoice, StopwatchClock } from "./types/stage";

const OVERRUN_FORMAT = { hour12: false, showSeconds: true, hideZeroHours: true, overrun: true } as const;

/**
 * «Auto» is the preacher's layout, unless what is live has a next slide the musicians follow: a song, a
 * presentation (PowerPoint, PDF…) or a verse of the chapter open in the Bible tab — its last slide included, so the
 * last chorus stays large (owner, 2026-11-13). A hand-picked one stays.
 */
export function resolveStageLayout(choice: StageLayoutChoice, followed: boolean): StageLayout {
  if (choice !== "auto") return choice;
  return followed ? "musicians" : "preacher";
}

/** Milliseconds left: negative past zero. */
export function countdownRemainingMs(clock: CountdownClock, now: number): number {
  return clock.state === "running" ? clock.endsAtMs - now : clock.remainingMs;
}

/**
 * The thresholds for a countdown of `totalMs`: the operator's (amber 5:00 and red 1:00 by default), but never more
 * than a fifth and a twentieth of the length, so a ten-minute count turns amber at 2:00 and red at 0:30 instead of
 * starting amber.
 */
export function stageThresholds(totalMs: number, warnMs: number, alertMs: number): { warnMs: number; alertMs: number } {
  return { warnMs: Math.min(warnMs, totalMs / 5), alertMs: Math.min(alertMs, totalMs / 20) };
}

export type CountdownTone = "normal" | "warn" | "alert" | "over";

/** Its colour: by what is left as the stage shows it (whole seconds, rounded up), so the colour and the digits
 *  change on the same frame. */
export function countdownTone(countdown: StageCountdown, now: number): CountdownTone {
  if (countdown.clock.mode === "stopwatch") return "normal";
  const shown = timerDisplaySeconds(countdown.clock, now, OVERRUN_FORMAT) * 1000;
  if (shown <= 0) return "over";
  if (shown <= countdown.alertMs) return "alert";
  return shown <= countdown.warnMs ? "warn" : "normal";
}

/** `28:41`, `1:05:00`, and past zero `+2:13`: it keeps counting, never stops nor disappears. */
export function formatCountdown(clock: CountdownClock | StopwatchClock, now: number): string {
  const seconds = timerDisplaySeconds(clock, now, OVERRUN_FORMAT);
  const text = formatSignedSeconds(seconds, OVERRUN_FORMAT);
  return seconds < 0 ? `+${text.slice(1)}` : text;
}
