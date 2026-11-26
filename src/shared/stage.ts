/**
 * The stage screen's rules, as pure functions (`tests/renderer/stage.test.ts`): which layout shows, which colour
 * the countdown is, and what it reads. Shared by the stage window and the stage panel's monitor, which draw the
 * same `StageView`.
 */
import { formatSignedSeconds, timerDisplaySeconds } from "./timer";
import { DEFAULT_BIBLE_STYLE, type BibleStyle } from "./types/bible-style";
import { DEFAULT_SHADOW_STRENGTH } from "./types/scene-style";
import { DEFAULT_SONG_THEME, type SongTheme } from "./types/song";
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

/**
 * The musicians' view (owner, 2026-11-26, after a stage screen he photographed): the live slide's words as large as
 * they fit, the next one's under them, and a strip at the foot with the count, the time and where the song or the
 * deck is. A song or a verse is drawn as words over black; anything else is the projector's picture. Every length
 * is in `cqw` of the stage, so the control window can tell the two rows' proportions (`stageLyricRows`) and measure
 * the song for them once (`fitSongSize`), and the stage window and the panel's monitor draw the same.
 */
export const STAGE_LYRICS = {
  padCqw: 1.5,
  gapCqw: 1.2,
  /** The strip's height (and its digits') at the stage's normal text size. */
  stripCqw: 6,
  /** The live row's share of what the strip leaves; the next row has the rest. */
  currentShare: 0.7,
} as const;

/** The two rows' proportions (width / height) on a screen of `screenAspect`, with the strip at `textScale`. */
export function stageLyricRows(screenAspect: number, textScale: number): { current: number; next: number } {
  const { padCqw, gapCqw, stripCqw, currentShare } = STAGE_LYRICS;
  const width = 100 - 2 * padCqw;
  const rows = Math.max(1, 100 / screenAspect - 2 * padCqw - 2 * gapCqw - stripCqw * textScale);
  return { current: width / (rows * currentShare), next: width / (rows * (1 - currentShare)) };
}

/** A song on the stage: plain words, white on black, edge to edge. Sizes are in `cqw` of its row. */
export const STAGE_SONG_THEME: SongTheme = {
  ...DEFAULT_SONG_THEME,
  background: { kind: "solid", color: "#000000" },
  fontFamily: null,
  text: { sizeCqw: 9, color: "#ffffff", weight: 600, shadow: false, shadowStrength: DEFAULT_SHADOW_STRENGTH },
  // Low enough that the next row, the shorter one, holds a long slide with its chords whole.
  minSizeCqw: 1,
  // The default theme's 1.375 leading: a line with its chords (0.66 of the size, plus their row) is then no taller
  // than the line the song was measured with.
  textAlign: "center",
  verticalAlign: "middle",
  margins: { top: 0.5, bottom: 0.5, left: 1.5, right: 1.5 },
  uppercase: false,
  letterSpacingEm: 0,
  outline: { ...DEFAULT_SONG_THEME.outline, enabled: false },
  footer: { ...DEFAULT_SONG_THEME.footer, show: "never" },
};

/** A verse on the stage, the song's way; its reference is in the strip. It fits itself, as on the projector. */
export const STAGE_BIBLE_STYLE: BibleStyle = {
  ...DEFAULT_BIBLE_STYLE,
  background: { kind: "solid", color: "#000000" },
  fontFamily: null,
  verticalAlign: "middle",
  text: { sizeCqw: 7, color: "#ffffff", weight: 600, shadow: false, shadowStrength: DEFAULT_SHADOW_STRENGTH },
  textAlign: "center",
  lineHeight: 1.3,
  maxWidthCqw: 97,
  showReference: false,
  autoFit: { enabled: true, minSizeCqw: 1.5 },
};
