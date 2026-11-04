/**
 * A song: text with a structure (sections and an order), dressed by a theme.
 *
 * Not a designed presentation — the operator writes or pastes text and the
 * app builds the slides. What a slide LOOKS like is the theme's job
 * (`SongTheme`), and how big its letters are is measured once per song so it
 * never changes from one slide to the next (`fitSongSize` in the renderer).
 *
 * ## On the hex values below
 *
 * The same exemption `scene-style.ts` documents: these are default *content*
 * values that land in a stored row and that the operator edits, not design
 * tokens.
 */
import type { BibleStyle, TextAlign } from "./bible-style";
import { DEFAULT_SHADOW_STRENGTH, type SceneBackground, type SceneTextStyle, type SceneVerticalAlign } from "./scene-style";

export const SONG_SECTION_TYPES = ["verse", "prechorus", "chorus", "bridge", "ending", "intro", "other"] as const;
export type SongSectionType = (typeof SONG_SECTION_TYPES)[number];

/** The letters a section's key starts with: `v1`, `pc1`, `c2`… Stored, so they
 *  never change; what the operator reads and types is `song-text.ts`'s. */
export const SECTION_KEY_PREFIX: Record<SongSectionType, string> = {
  verse: "v",
  prechorus: "pc",
  chorus: "c",
  bridge: "b",
  ending: "e",
  intro: "i",
  other: "o",
};

/** A section's number goes 1..this. A song with a hundredth verse is not a song. */
export const SONG_SECTION_NUMBER_MAX = 99;

export type SongSlide = {
  lines: string[];
  /** Reserved for the second language (phase 2): never written or shown yet. */
  translation?: string[];
};

export type SongSection = {
  /** `${SECTION_KEY_PREFIX[type]}${number}` — what the order names. */
  key: string;
  type: SongSectionType;
  number: number;
  slides: SongSlide[];
};

export type Song = {
  id: number;
  title: string;
  /** A hymnal's own number («230», «12a»), searched like the title. */
  number: string | null;
  /** One free text: «Letra: X · Música: Y» is as structured as it gets. */
  authors: string | null;
  copyright: string | null;
  ccliNumber: string | null;
  notes: string | null;
  sections: SongSection[];
  /** Section keys, with repetitions. Empty = the sections as written. A key
   *  whose section is gone is skipped when the slides are built. */
  order: string[];
  /** `null` = the default theme. */
  themeId: number | null;
  updatedAt: number;
};

export type SongUpsert = Omit<Song, "id" | "updatedAt"> & { id?: number };

export type SongUsage = { programId: number; programName: string; itemCount: number };

export type SongSearchHit = {
  songId: number;
  /** The lyrics around the match, marked like a Bible snippet (`parseSnippet`);
   *  `null` when the match is in the title, number or authors only. */
  snippet: string | null;
};

/** One slide of the song as it is projected: the order expanded, each slide
 *  knowing which section and which pass of the order it comes from. */
export type SongDeckSlide = {
  lines: string[];
  sectionKey: string;
  type: SongSectionType;
  number: number;
  /** Position in the order this slide comes from, 0-based. Two choruses in
   *  the order are two passes of the same section. */
  pass: number;
  /** 0-based, inside its section. */
  indexInSection: number;
};

/** What the projector and the monitors need of a song: nothing to resolve.
 *  `sections` are there for a jump to one that is not in the order. */
export type ResolvedSong = {
  id: number;
  title: string;
  slides: SongDeckSlide[];
  sections: SongSection[];
};

/** Margins of the text block, in `cqw` (width of the stage), every side —
 *  `cqw` and never `cqh` for `OutputView`'s reason. */
export type SongMargins = { top: number; bottom: number; left: number; right: number };

export const SONG_THEME_VERSION = 1;

/**
 * How a song looks. F1 carries only what `SongScene` draws today; the theme
 * editor (F3) adds its knobs as new fields, each a branch in
 * `normalizeSongTheme` that falls back to its default.
 */
export type SongTheme = {
  version: typeof SONG_THEME_VERSION;
  background: SceneBackground;
  fontFamily: string | null;
  /** `sizeCqw` is the CEILING: a song is drawn at the largest size at or
   *  below it at which all of its slides fit. */
  text: SceneTextStyle;
  /** The floor. Below it, what does not fit overflows visibly. */
  minSizeCqw: number;
  lineHeight: number;
  textAlign: TextAlign;
  verticalAlign: SceneVerticalAlign;
  margins: SongMargins;
};

export type SongThemeRow = { id: number; name: string; style: SongTheme };

export const SONG_SIZE_MIN_CQW = 0.5;
export const SONG_SIZE_MAX_CQW = 30;
export const SONG_MARGIN_MAX_CQW = 40;

/** Lyrics are read standing, from the back: bigger than a verse (3.5 / 1.5). */
export const SONG_DEFAULT_MAX_CQW = 6;
export const SONG_DEFAULT_MIN_CQW = 2.5;

/** The verse's look, at a singer's size. The seed copies the operator's own
 *  verse style over this (`songThemeFromBibleStyle`). */
export const DEFAULT_SONG_THEME: SongTheme = {
  version: SONG_THEME_VERSION,
  background: { kind: "solid", color: "#000000" },
  fontFamily: null,
  text: {
    sizeCqw: SONG_DEFAULT_MAX_CQW,
    color: "#ffffff",
    weight: 400,
    shadow: true,
    shadowStrength: DEFAULT_SHADOW_STRENGTH,
  },
  minSizeCqw: SONG_DEFAULT_MIN_CQW,
  lineHeight: 1.375,
  textAlign: "center",
  verticalAlign: "middle",
  // The verse's 88 cqw column and its 4.5 cqw title-safe gutter.
  margins: { top: 4.5, bottom: 4.5, left: 6, right: 6 },
};

/**
 * The default theme the seed writes: the operator's verse as it is configured
 * today (owner, 2026-11-04) — background, face, colour, shadow, alignment,
 * leading and side margins — at a singer's size rather than the verse's.
 */
export function songThemeFromBibleStyle(style: BibleStyle): SongTheme {
  const side = Math.max(0, (100 - style.maxWidthCqw) / 2);
  return {
    ...DEFAULT_SONG_THEME,
    background: style.background,
    fontFamily: style.fontFamily,
    text: { ...style.text, sizeCqw: SONG_DEFAULT_MAX_CQW },
    lineHeight: style.lineHeight,
    textAlign: style.textAlign,
    verticalAlign: style.verticalAlign,
    margins: { ...DEFAULT_SONG_THEME.margins, left: side, right: side },
  };
}
