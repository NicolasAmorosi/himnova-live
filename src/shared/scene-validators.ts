/**
 * Runtime validation and defensive normalization for everything a utility
 * scene stores as JSON.
 *
 * Two callers, two different jobs, one set of predicates:
 *
 * - **Main validates on WRITE** (`ipc/handlers/utility.ts`). `registerHandlers`
 *   casts an IPC request from `unknown` to its declared type without checking
 *   anything, and the renderer is another process — a stale bundle after a
 *   partial update writes a durable row no migration will ever clean up. This
 *   is the same reasoning, and the same shape, as `SETTINGS_VALIDATORS`.
 * - **The repo normalizes on READ** (`utility.repo.ts`). A row written by a
 *   future version, hand-edited, or truncated must not take the launch down
 *   with it, and must not come back as a scene that projects nothing: every
 *   field falls back to its default INDEPENDENTLY, so one bad colour costs the
 *   colour and not the whole scene. Same discipline as `DraftRepo.load` and
 *   the Bible seed's parser.
 *
 * `Record<keyof X, …>` throughout, so adding a field to `SceneStyle` or
 * `TimerConfig` without deciding what a valid value is becomes a compile
 * error rather than an unchecked write.
 *
 * What is NOT here: the predicates that describe a style rather than a scene
 * (a colour, a `SceneTextStyle`, a `SceneBackground`, a `TransitionSpec`).
 * Those live in `style-validators.ts`, because the Bible verse's own style
 * reuses the very same pieces and two spellings of "what a colour is" is how
 * one writer starts accepting what the other rejects.
 */
import {
  isBoolean,
  isColor,
  isIntegerIn,
  isNumberIn,
  isOneOf,
  isRecord,
  isSceneBackground,
  isTextOrNull,
  isTextStyle,
  isTransitionSpec,
  keepOr,
  matchesAll,
  normalizeTextStyle,
  normalizeTransition,
} from "./style-validators";
import {
  DEFAULT_SCENE_STYLE,
  isSafeFontFamily,
  SCENE_STYLE_VERSION,
  SCENE_VERTICAL_ALIGNS,
  type SceneEnd,
  type SceneStyle,
  type SceneTextStyle,
  type SceneTriggers,
} from "./types/scene-style";
import {
  DEFAULT_TIMER_FORMAT,
  MINUTES_PER_DAY,
  TIMER_MAX_DURATION_MS,
  TIMER_MIN_DURATION_MS,
  TIMER_TOOLS,
  type TimerConfig,
  type TimerFormat,
} from "./types/timer";
import type { UtilityScene, UtilitySceneUpsert } from "./types/utility";

/** Re-exported so what checks a scene keeps one import. */
export { isSceneBackground };

/* -------------------------------------------------------------------------
 * Field-level limits
 * ---------------------------------------------------------------------- */

/** A scene's name, and the two text lines. Long enough for a real sentence,
 *  short enough that a row can't hold a document. */
export const SCENE_NAME_MAX_LENGTH = 80;
export const SCENE_TEXT_MAX_LENGTH = 200;

/** A colour trigger can be armed at most an hour out — past that it is not a
 *  warning, it is the scene's normal colour. */
export const TRIGGER_MAX_WARNING_MS = 3_600_000;

/* -------------------------------------------------------------------------
 * SceneTriggers
 * ---------------------------------------------------------------------- */

const TRIGGER_VALIDATORS: Record<keyof SceneTriggers, (v: unknown) => boolean> = {
  warningAtMs: isNumberIn(0, TRIGGER_MAX_WARNING_MS),
  warningColor: isColor,
  endColor: isColor,
};

const isTriggers = (v: unknown): boolean => v === null || matchesAll(v, TRIGGER_VALIDATORS);

/* -------------------------------------------------------------------------
 * SceneEnd
 * ---------------------------------------------------------------------- */

const END_VALIDATORS: Record<keyof SceneEnd, (v: unknown) => boolean> = {
  message: isTextStyle,
  hideValue: isBoolean,
  hideTitle: isBoolean,
  transition: isTransitionSpec,
};

const isSceneEnd = (v: unknown): boolean => matchesAll(v, END_VALIDATORS);

/**
 * The fallback is the ROW's own message style, not the app default.
 *
 * A scene written before the end line had a style of its own has no `end` at
 * all, and it must come back drawing its end message exactly the way it always
 * did — which is with the message style the operator set. Falling back to
 * `DEFAULT_SCENE_STYLE.end.message` would silently restyle every existing
 * scene the first time this build read it.
 */
function normalizeSceneEnd(value: unknown, message: SceneTextStyle): SceneEnd {
  // `transition` is the one field here whose app default IS the old
  // behaviour: a row written before it existed cut into its end state, and
  // "none" is that cut. So it falls back to the default rather than to a
  // sibling of the row — there is no sibling that describes how this scene
  // used to change, because it never changed gradually at all.
  const fallback: SceneEnd = {
    message,
    hideValue: false,
    hideTitle: false,
    transition: DEFAULT_SCENE_STYLE.end.transition,
  };
  if (!isRecord(value)) return fallback;
  return {
    message: normalizeTextStyle(value.message, fallback.message),
    hideValue: keepOr(isBoolean(value.hideValue), value.hideValue, fallback.hideValue),
    hideTitle: keepOr(isBoolean(value.hideTitle), value.hideTitle, fallback.hideTitle),
    transition: normalizeTransition(value.transition, fallback.transition),
  };
}

/* -------------------------------------------------------------------------
 * SceneStyle
 * ---------------------------------------------------------------------- */

export const SCENE_STYLE_VALIDATORS: Record<keyof SceneStyle, (value: unknown) => boolean> = {
  version: (v) => v === SCENE_STYLE_VERSION,
  background: isSceneBackground,
  fontFamily: (v) => (v === null || typeof v === "string") && isSafeFontFamily(v),
  verticalAlign: isOneOf(SCENE_VERTICAL_ALIGNS),
  value: isTextStyle,
  title: isTextStyle,
  message: isTextStyle,
  end: isSceneEnd,
  triggers: isTriggers,
};

export function isSceneStyle(value: unknown): value is SceneStyle {
  return matchesAll(value, SCENE_STYLE_VALIDATORS);
}

/**
 * A `SceneStyle` whatever the input was.
 *
 * Field by field rather than all-or-nothing: a scene whose gradient lost one
 * colour should come back with the default background and the operator's own
 * typography, not as a stranger. `version` is where a future shape change
 * branches — a row that declares a version this build does not know is read
 * with today's rules and falls back wherever it disagrees, which is a scene
 * that projects rather than a scene that throws.
 */
export function normalizeSceneStyle(value: unknown): SceneStyle {
  if (!isRecord(value)) return DEFAULT_SCENE_STYLE;
  // Read once and reused: it is both the message's own style and what the end
  // message falls back to (see `normalizeSceneEnd`).
  const message = normalizeTextStyle(value.message, DEFAULT_SCENE_STYLE.message);
  return {
    version: SCENE_STYLE_VERSION,
    background: keepOr(
      isSceneBackground(value.background),
      value.background,
      DEFAULT_SCENE_STYLE.background,
    ),
    fontFamily: keepOr(
      SCENE_STYLE_VALIDATORS.fontFamily(value.fontFamily),
      value.fontFamily,
      DEFAULT_SCENE_STYLE.fontFamily,
    ),
    verticalAlign: keepOr(
      SCENE_STYLE_VALIDATORS.verticalAlign(value.verticalAlign),
      value.verticalAlign,
      DEFAULT_SCENE_STYLE.verticalAlign,
    ),
    value: normalizeTextStyle(value.value, DEFAULT_SCENE_STYLE.value),
    title: normalizeTextStyle(value.title, DEFAULT_SCENE_STYLE.title),
    message,
    end: normalizeSceneEnd(value.end, message),
    triggers: keepOr<SceneTriggers | null>(isTriggers(value.triggers), value.triggers, null),
  };
}

/* -------------------------------------------------------------------------
 * TimerFormat / TimerConfig
 * ---------------------------------------------------------------------- */

export const TIMER_FORMAT_VALIDATORS: Record<keyof TimerFormat, (value: unknown) => boolean> = {
  hour12: isBoolean,
  showSeconds: isBoolean,
  hideZeroHours: isBoolean,
  overrun: isBoolean,
};

export const TIMER_CONFIG_VALIDATORS: Record<keyof TimerConfig, (value: unknown) => boolean> = {
  durationMs: isNumberIn(TIMER_MIN_DURATION_MS, TIMER_MAX_DURATION_MS),
  targetMinuteOfDay: isIntegerIn(0, MINUTES_PER_DAY - 1),
  endMessage: isTextOrNull(SCENE_TEXT_MAX_LENGTH),
  format: (v) => matchesAll(v, TIMER_FORMAT_VALIDATORS),
};

export function isTimerConfig(value: unknown): value is TimerConfig {
  return matchesAll(value, TIMER_CONFIG_VALIDATORS);
}

function normalizeTimerFormat(value: unknown): TimerFormat {
  if (!isRecord(value)) return DEFAULT_TIMER_FORMAT;
  return {
    hour12: keepOr(isBoolean(value.hour12), value.hour12, DEFAULT_TIMER_FORMAT.hour12),
    showSeconds: keepOr(isBoolean(value.showSeconds), value.showSeconds, DEFAULT_TIMER_FORMAT.showSeconds),
    hideZeroHours: keepOr(
      isBoolean(value.hideZeroHours),
      value.hideZeroHours,
      DEFAULT_TIMER_FORMAT.hideZeroHours,
    ),
    overrun: keepOr(isBoolean(value.overrun), value.overrun, DEFAULT_TIMER_FORMAT.overrun),
  };
}

/** The `TimerConfig` a row is worth, with the same per-field fallback rule as
 *  `normalizeSceneStyle`. The defaults are the first scene's, not a second set
 *  of magic numbers: ten minutes, ten o'clock, no end message. */
export function normalizeTimerConfig(value: unknown): TimerConfig {
  const fallback: TimerConfig = {
    durationMs: 10 * 60_000,
    targetMinuteOfDay: 10 * 60,
    endMessage: null,
    format: DEFAULT_TIMER_FORMAT,
  };
  if (!isRecord(value)) return fallback;
  return {
    durationMs: keepOr(
      TIMER_CONFIG_VALIDATORS.durationMs(value.durationMs),
      value.durationMs,
      fallback.durationMs,
    ),
    targetMinuteOfDay: keepOr(
      TIMER_CONFIG_VALIDATORS.targetMinuteOfDay(value.targetMinuteOfDay),
      value.targetMinuteOfDay,
      fallback.targetMinuteOfDay,
    ),
    endMessage: keepOr<string | null>(
      TIMER_CONFIG_VALIDATORS.endMessage(value.endMessage),
      value.endMessage,
      fallback.endMessage,
    ),
    format: normalizeTimerFormat(value.format),
  };
}

/* -------------------------------------------------------------------------
 * The whole row
 * ---------------------------------------------------------------------- */

/** A name the list can actually show: not blank, not a paragraph. Trimmed
 *  before the length check, because " " is a name nobody can read. */
export function isSceneName(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= SCENE_NAME_MAX_LENGTH;
}

const UPSERT_VALIDATORS: Record<keyof Omit<UtilityScene, "id">, (value: unknown) => boolean> = {
  name: isSceneName,
  tool: isOneOf(TIMER_TOOLS),
  config: isTimerConfig,
  style: isSceneStyle,
  title: isTextOrNull(SCENE_TEXT_MAX_LENGTH),
  message: isTextOrNull(SCENE_TEXT_MAX_LENGTH),
};

/**
 * What main accepts as a scene to write.
 *
 * Strict, unlike the normalizers: a request that does not describe a whole
 * valid scene is rejected with an error the operator sees, rather than
 * silently stored as something slightly different from what they built. The
 * normalizers are for rows that are ALREADY in the database and have to be
 * shown anyway.
 */
export function isUtilitySceneUpsert(value: unknown): value is UtilitySceneUpsert {
  if (!matchesAll(value, UPSERT_VALIDATORS)) return false;
  const id = (value as Record<string, unknown>).id;
  return id === undefined || isIntegerIn(1, Number.MAX_SAFE_INTEGER)(id);
}
