/**
 * Songs and their themes: strict on WRITE (main, `song:create`/`song:update`),
 * tolerant field by field on READ (the repo) — the rule every JSON column of
 * this app follows. Whatever comes out of a normalizer passes its validator,
 * and a test says so.
 */
import { parseSectionKey, sectionKey } from "./song-text";
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
import { BIBLE_LINE_HEIGHT_MAX, BIBLE_LINE_HEIGHT_MIN, TEXT_ALIGNS } from "./types/bible-style";
import { isSafeFontFamily, SCENE_VERTICAL_ALIGNS } from "./types/scene-style";
import {
  DEFAULT_SONG_THEME,
  SONG_MARGIN_MAX_CQW,
  SONG_SECTION_TYPES,
  SONG_SIZE_MAX_CQW,
  SONG_SIZE_MIN_CQW,
  SONG_THEME_VERSION,
  type SongMargins,
  type SongSection,
  type SongSlide,
  type SongTheme,
  type SongUpsert,
} from "./types/song";

export const SONG_TITLE_MAX_LENGTH = 200;
export const SONG_FIELD_MAX_LENGTH = 500;
export const SONG_NOTES_MAX_LENGTH = 4_000;
export const SONG_LINE_MAX_LENGTH = 500;
/** Far past any real song; a ceiling so one row cannot hold a novel. */
export const SONG_MAX_SECTIONS = 60;
export const SONG_MAX_SLIDES_PER_SECTION = 40;
export const SONG_MAX_LINES_PER_SLIDE = 40;
export const SONG_MAX_ORDER = 200;

/* -------------------------------------------------------------------------
 * The theme
 * ---------------------------------------------------------------------- */

const isMargin = isNumberIn(0, SONG_MARGIN_MAX_CQW);
const MARGIN_VALIDATORS: Record<keyof SongMargins, (v: unknown) => boolean> = {
  top: isMargin,
  bottom: isMargin,
  left: isMargin,
  right: isMargin,
};

const isSize = isNumberIn(SONG_SIZE_MIN_CQW, SONG_SIZE_MAX_CQW);

export const SONG_THEME_VALIDATORS: Record<keyof SongTheme, (v: unknown) => boolean> = {
  version: (v) => v === SONG_THEME_VERSION,
  background: isSceneBackground,
  fontFamily: (v) => (v === null || typeof v === "string") && isSafeFontFamily(v),
  text: (v) => isTextStyle(v) && isRecord(v) && isSize(v.sizeCqw),
  minSizeCqw: isSize,
  lineHeight: isNumberIn(BIBLE_LINE_HEIGHT_MIN, BIBLE_LINE_HEIGHT_MAX),
  textAlign: isOneOf(TEXT_ALIGNS),
  verticalAlign: isOneOf(SCENE_VERTICAL_ALIGNS),
  margins: (v) => matchesAll(v, MARGIN_VALIDATORS),
};

export function isSongTheme(value: unknown): value is SongTheme {
  return matchesAll(value, SONG_THEME_VALIDATORS);
}

function normalizeMargins(value: unknown, fallback: SongMargins): SongMargins {
  if (!isRecord(value)) return fallback;
  return {
    top: keepOr(isMargin(value.top), value.top, fallback.top),
    bottom: keepOr(isMargin(value.bottom), value.bottom, fallback.bottom),
    left: keepOr(isMargin(value.left), value.left, fallback.left),
    right: keepOr(isMargin(value.right), value.right, fallback.right),
  };
}

export function normalizeSongTheme(value: unknown): SongTheme {
  if (!isRecord(value)) return DEFAULT_SONG_THEME;
  const d = DEFAULT_SONG_THEME;
  const v = SONG_THEME_VALIDATORS;
  const text = normalizeTextStyle(value.text, d.text);
  return {
    version: SONG_THEME_VERSION,
    background: keepOr(v.background(value.background), value.background, d.background),
    fontFamily: keepOr(v.fontFamily(value.fontFamily), value.fontFamily, d.fontFamily),
    // A size the generic text normalizer allows but a song does not.
    text: isSize(text.sizeCqw) ? text : { ...text, sizeCqw: d.text.sizeCqw },
    minSizeCqw: keepOr(v.minSizeCqw(value.minSizeCqw), value.minSizeCqw, d.minSizeCqw),
    lineHeight: keepOr(v.lineHeight(value.lineHeight), value.lineHeight, d.lineHeight),
    textAlign: keepOr(v.textAlign(value.textAlign), value.textAlign, d.textAlign),
    verticalAlign: keepOr(v.verticalAlign(value.verticalAlign), value.verticalAlign, d.verticalAlign),
    margins: normalizeMargins(value.margins, d.margins),
  };
}

/* -------------------------------------------------------------------------
 * The song
 * ---------------------------------------------------------------------- */

const isLine = (v: unknown): boolean => typeof v === "string" && v.length <= SONG_LINE_MAX_LENGTH;

function isSlide(value: unknown): value is SongSlide {
  if (!isRecord(value) || !Array.isArray(value.lines)) return false;
  const { lines, translation } = value;
  if (lines.length === 0 || lines.length > SONG_MAX_LINES_PER_SLIDE || !lines.every(isLine)) return false;
  if (!lines.some((line) => typeof line === "string" && line.trim().length > 0)) return false;
  return translation === undefined || (Array.isArray(translation) && translation.every(isLine));
}

function isSection(value: unknown): value is SongSection {
  if (!isRecord(value)) return false;
  const { key, number, slides, type } = value;
  if (!isOneOf(SONG_SECTION_TYPES)(type) || !isIntegerIn(1, 99)(number)) return false;
  if (key !== sectionKey(type as SongSection["type"], number as number)) return false;
  return (
    Array.isArray(slides) && slides.length > 0 && slides.length <= SONG_MAX_SLIDES_PER_SECTION && slides.every(isSlide)
  );
}

export function isSongTitle(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= SONG_TITLE_MAX_LENGTH;
}

const isField = isTextOrNull(SONG_FIELD_MAX_LENGTH);
const isId = isIntegerIn(1, Number.MAX_SAFE_INTEGER);

/** A song main is willing to write: a title, at least one slide that says
 *  something, unique section keys, and an order made of keys (one naming a
 *  section that is gone is allowed — it is skipped, and the editor says so). */
export function isSongUpsert(value: unknown): value is SongUpsert {
  if (!isRecord(value)) return false;
  const { authors, ccliNumber, copyright, id, notes, number, order, sections, themeId, title } = value;
  if (id !== undefined && !isId(id)) return false;
  if (!isSongTitle(title)) return false;
  if (![number, authors, copyright, ccliNumber].every(isField)) return false;
  if (!isTextOrNull(SONG_NOTES_MAX_LENGTH)(notes)) return false;
  if (themeId !== null && !isId(themeId)) return false;
  if (!Array.isArray(sections) || sections.length === 0 || sections.length > SONG_MAX_SECTIONS) return false;
  if (!sections.every(isSection)) return false;
  if (new Set(sections.map((section) => section.key)).size !== sections.length) return false;
  return (
    Array.isArray(order) &&
    order.length <= SONG_MAX_ORDER &&
    order.every((key) => typeof key === "string" && parseSectionKey(key) !== null)
  );
}

/** A stored `sections_json` read back: every section that is not whole is
 *  dropped, never the song. */
export function normalizeSections(value: unknown): SongSection[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((section): section is SongSection => {
    if (!isSection(section) || seen.has(section.key)) return false;
    seen.add(section.key);
    return true;
  });
}

export function normalizeOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((key): key is string => typeof key === "string" && parseSectionKey(key) !== null);
}
