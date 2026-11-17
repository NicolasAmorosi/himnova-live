import type { TimerClock } from "./timer";

/**
 * The stage screen's own controls (owner, 2026-11-13): a countdown for the preacher, a message to the platform
 * and which of its two layouts it shows. Run from the work screen's stage panel, never from Settings (owner).
 */

/** «Auto» (the default) is the preacher's layout unless a song, a presentation or a chapter's verse is live
 *  (`resolveStageLayout`). «Projector» is a copy of the projector and nothing else: no countdown, no message (owner,
 *  2026-11-13), the same view Settings ▸ Screens' «Copia del proyector» locks the screen to. */
export const STAGE_LAYOUT_CHOICES = ["auto", "musicians", "preacher", "projector"] as const;
export type StageLayoutChoice = (typeof STAGE_LAYOUT_CHOICES)[number];
export type StageLayout = Exclude<StageLayoutChoice, "auto">;

export const STAGE_TEXT_SIZES = ["small", "normal", "large"] as const;
export type StageTextSize = (typeof STAGE_TEXT_SIZES)[number];

/** 12 or 24 hours; «auto» is the language's (12 in English). */
export const STAGE_CLOCK_FORMATS = ["auto", "24h", "12h"] as const;
export type StageClockFormat = (typeof STAGE_CLOCK_FORMATS)[number];

export type CountdownClock = Extract<TimerClock, { mode: "countdown" }>;
export type StopwatchClock = Extract<TimerClock, { mode: "stopwatch" }>;

/** The count as the stage draws it: an absolute mark it subtracts against its own clock each second, so a
 *  change is one push and a running count is none (the `TimerClock` design). Thresholds come resolved. The panel's
 *  countdown, or a Functions countdown or stopwatch that is live (owner, 2026-11-14), which counts up uncoloured. */
export type StageCountdown = {
  clock: CountdownClock | StopwatchClock;
  /** Amber from here down, red from `alertMs` down, in milliseconds left. */
  warnMs: number;
  alertMs: number;
};

/** One message at a time: a new one replaces it, and it stays until taken off. `seq` tells a new message from
 *  the same one pushed again: it blinks three times when it appears, and only then. */
export type StageMessage = { text: string; urgent: boolean; seq: number };

/** The longest message: two lines a platform can read at a glance. */
export const STAGE_MESSAGE_MAX_LENGTH = 120;
export const STAGE_PHRASES_MAX = 12;

/** The panel's phrases as they may be kept: trimmed and cut to a message's length, blanks and repeats dropped (two
 *  equal ones were two buttons that went on air together, 2026-11-15 audit D7), at most `STAGE_PHRASES_MAX`. What
 *  Settings saves, and how a stored list another build wrote is read (D13). */
export function normalizeStagePhrases(phrases: readonly string[]): string[] {
  const kept = phrases.map((phrase) => phrase.trim().slice(0, STAGE_MESSAGE_MAX_LENGTH)).filter(Boolean);
  return [...new Set(kept)].slice(0, STAGE_PHRASES_MAX);
}

/** The thresholds the operator can pick, in minutes left. */
export const STAGE_WARN_OPTIONS_MS = [10, 5, 3, 2].map((m) => m * 60_000);
export const STAGE_ALERT_OPTIONS_MS = [2, 1, 0.5].map((m) => m * 60_000);
