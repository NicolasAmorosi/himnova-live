/**
 * Runtime validation and defensive normalization for an overlay plate — the
 * same two tempers `scene-validators.ts` documents: main validates the WHOLE
 * plate on write (strict), the repo normalizes a stored row field by field on
 * read (forgiving). A test asserts that whatever the normalizer returns, the
 * validator accepts.
 */
import {
  isIntegerIn,
  isNumberIn,
  isOneOf,
  isRecord,
  isSceneBackground,
  isTextOrNull,
  isTextStyle,
  keepOr,
  matchesAll,
  normalizeTextStyle,
} from "./style-validators";
import { isSafeFontFamily } from "./types/scene-style";
import { TRANSITION_MAX_DURATION_MS } from "./types/transition";
import {
  DEFAULT_PLATE_STYLE,
  PLATE_ANIMATION_STYLES,
  PLATE_KIND_POSITIONS,
  PLATE_KINDS,
  PLATE_STYLE_VERSION,
  type Plate,
  type PlateAnimation,
  type PlateBackground,
  type PlateStyle,
  type PlateUpsert,
} from "./types/overlay";

export const PLATE_NAME_MAX_LENGTH = 80;
export const PLATE_TEXT_MAX_LENGTH = 200;
export const PLATE_MARGIN_MAX_CQW = 20;
/** Enough for a pill on any plate a default text size makes. */
export const PLATE_CORNER_MAX_CQW = 5;
export const PLATE_IMAGE_MIN_CQW = 1;
export const PLATE_IMAGE_MAX_CQW = 50;
export const PLATE_TICKER_MIN_CQW = 2;
export const PLATE_TICKER_MAX_CQW = 40;
export const PLATE_AUTO_HIDE_MIN_MS = 2_000;
export const PLATE_AUTO_HIDE_MAX_MS = 120_000;

const isOpacity = isNumberIn(0, 1);

const isPlateBackground = (v: unknown): v is PlateBackground =>
  isSceneBackground(v) && v.kind !== "image";

const ANIMATION_VALIDATORS: Record<keyof PlateAnimation, (v: unknown) => boolean> = {
  style: isOneOf(PLATE_ANIMATION_STYLES),
  durationMs: isNumberIn(0, TRANSITION_MAX_DURATION_MS),
};

const IMAGE_VALIDATORS: Record<keyof PlateStyle["image"], (v: unknown) => boolean> = {
  sizeCqw: isNumberIn(PLATE_IMAGE_MIN_CQW, PLATE_IMAGE_MAX_CQW),
  opacity: isOpacity,
};

const TICKER_VALIDATORS: Record<keyof PlateStyle["ticker"], (v: unknown) => boolean> = {
  enabled: (v) => typeof v === "boolean",
  speedCqw: isNumberIn(PLATE_TICKER_MIN_CQW, PLATE_TICKER_MAX_CQW),
};

const AUTO_HIDE_VALIDATORS: Record<keyof PlateStyle["autoHide"], (v: unknown) => boolean> = {
  enabled: (v) => typeof v === "boolean",
  afterMs: isNumberIn(PLATE_AUTO_HIDE_MIN_MS, PLATE_AUTO_HIDE_MAX_MS),
};

export const PLATE_STYLE_VALIDATORS: Record<keyof PlateStyle, (v: unknown) => boolean> = {
  version: (v) => v === PLATE_STYLE_VERSION,
  background: isPlateBackground,
  backgroundOpacity: isOpacity,
  fontFamily: (v) => (v === null || typeof v === "string") && isSafeFontFamily(v),
  title: isTextStyle,
  subtitle: isTextStyle,
  marginCqw: isNumberIn(0, PLATE_MARGIN_MAX_CQW),
  cornerRadiusCqw: isNumberIn(0, PLATE_CORNER_MAX_CQW),
  image: (v) => matchesAll(v, IMAGE_VALIDATORS),
  animation: (v) => matchesAll(v, ANIMATION_VALIDATORS),
  ticker: (v) => matchesAll(v, TICKER_VALIDATORS),
  autoHide: (v) => matchesAll(v, AUTO_HIDE_VALIDATORS),
};

export function isPlateStyle(value: unknown): value is PlateStyle {
  return matchesAll(value, PLATE_STYLE_VALIDATORS);
}

/** Field by field, like `normalizeSceneStyle`: a broken colour costs the
 *  colour, never the plate. */
export function normalizePlateStyle(value: unknown): PlateStyle {
  const d = DEFAULT_PLATE_STYLE;
  if (!isRecord(value)) return d;
  const v = PLATE_STYLE_VALIDATORS;
  const image = isRecord(value.image) ? value.image : {};
  const animation = isRecord(value.animation) ? value.animation : {};
  // Absent on every row written before the banner existed.
  const ticker = isRecord(value.ticker) ? value.ticker : {};
  // Absent on every row written before auto-hide existed.
  const autoHide = isRecord(value.autoHide) ? value.autoHide : {};
  return {
    version: PLATE_STYLE_VERSION,
    background: keepOr(v.background(value.background), value.background, d.background),
    backgroundOpacity: keepOr(v.backgroundOpacity(value.backgroundOpacity), value.backgroundOpacity, d.backgroundOpacity),
    fontFamily: keepOr(v.fontFamily(value.fontFamily), value.fontFamily, d.fontFamily),
    title: normalizeTextStyle(value.title, d.title),
    subtitle: normalizeTextStyle(value.subtitle, d.subtitle),
    marginCqw: keepOr(v.marginCqw(value.marginCqw), value.marginCqw, d.marginCqw),
    // Absent on every row written before 2026-11-05: square, as they were drawn.
    cornerRadiusCqw: keepOr(v.cornerRadiusCqw(value.cornerRadiusCqw), value.cornerRadiusCqw, d.cornerRadiusCqw),
    image: {
      sizeCqw: keepOr(IMAGE_VALIDATORS.sizeCqw(image.sizeCqw), image.sizeCqw, d.image.sizeCqw),
      opacity: keepOr(IMAGE_VALIDATORS.opacity(image.opacity), image.opacity, d.image.opacity),
    },
    animation: {
      style: keepOr(ANIMATION_VALIDATORS.style(animation.style), animation.style, d.animation.style),
      durationMs: keepOr(
        ANIMATION_VALIDATORS.durationMs(animation.durationMs),
        animation.durationMs,
        d.animation.durationMs,
      ),
    },
    ticker: {
      enabled: keepOr(TICKER_VALIDATORS.enabled(ticker.enabled), ticker.enabled, d.ticker.enabled),
      speedCqw: keepOr(TICKER_VALIDATORS.speedCqw(ticker.speedCqw), ticker.speedCqw, d.ticker.speedCqw),
    },
    autoHide: {
      enabled: keepOr(AUTO_HIDE_VALIDATORS.enabled(autoHide.enabled), autoHide.enabled, d.autoHide.enabled),
      afterMs: keepOr(AUTO_HIDE_VALIDATORS.afterMs(autoHide.afterMs), autoHide.afterMs, d.autoHide.afterMs),
    },
  };
}

export function isPlateName(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= PLATE_NAME_MAX_LENGTH;
}

const isText = isTextOrNull(PLATE_TEXT_MAX_LENGTH);
const isAssetId = isIntegerIn(1, Number.MAX_SAFE_INTEGER);

/** A line that would actually draw something. */
const hasText = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

/**
 * What main accepts as a plate to write — strict, and it asks the cross-field
 * questions no single field can: the position must be one its kind allows,
 * only a bug carries an image, and a plate must draw SOMETHING (a lower third
 * or a banner a line of text, a bug an image or a line). A plate that projects nothing is
 * a plate the operator shows and then cannot find on the screen.
 */
export function isPlateUpsert(value: unknown): value is PlateUpsert {
  if (!isRecord(value)) return false;
  const { id, name, kind, position, title, subtitle, imageAssetId, style } = value;
  if (id !== undefined && !isAssetId(id)) return false;
  if (!isPlateName(name) || !isOneOf(PLATE_KINDS)(kind)) return false;
  if (!isText(title) || !isText(subtitle) || !isPlateStyle(style)) return false;
  const plateKind = kind as Plate["kind"];
  if (!PLATE_KIND_POSITIONS[plateKind].includes(position as Plate["position"])) return false;
  const drawsText = hasText(title) || hasText(subtitle);
  if (plateKind !== "bug") return imageAssetId === null && drawsText;
  if (imageAssetId !== null && !isAssetId(imageAssetId)) return false;
  return imageAssetId !== null || drawsText;
}
