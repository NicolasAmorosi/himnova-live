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
import {
  DEFAULT_SHADOW_STRENGTH,
  type BackgroundFit,
  type SceneBackground,
  type SceneTextStyle,
  type SceneVerticalAlign,
} from "./scene-style";

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

/** A chord over a lyric line: `at` is the character of the line it sits on. */
export type SongChord = { at: number; name: string };

export type SongSlide = {
  lines: string[];
  /** This slide in the second language, written in the editor's «Traducción»
   *  text and paired by section and slide (`withTranslation`). */
  translation?: string[];
  /** The chords over each of `lines` (same length), only when the slide has
   *  any. For the musicians' screen alone: the projector never draws them
   *  (owner, plan §8). Written inline in the editor's text, `[G]Amazing`. */
  chords?: SongChord[][];
};

/** Which language a live song shows (owner, 2026-11-05): a song with a
 *  translation goes live in «both», stacked, and the LIVE row switches it. */
export const SONG_LANGUAGES = ["original", "both", "translation"] as const;
export type SongLanguage = (typeof SONG_LANGUAGES)[number];

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
  /** The linked folder whose file it was read from, `null` = a library song.
   *  Saving such a song writes its file too, in the file's own format (owner,
   *  2026-11-05). Main's to set: never part of a write. */
  sourceFolder: string | null;
  /** The file saving writes, whole path: a linked folder's song's, or a
   *  library song imported from a song file (owner, 2026-11-05: it stays tied
   *  to it). `null` = the song lives only in the app. Main's to set. */
  file: string | null;
  updatedAt: number;
};

/** How the Songs tab lists the library when nothing is searched, persisted in
 *  `settings["songs.sort"]`. `date` is when the song came in (its row id). */
export const SONG_SORT_ORDERS = ["title-asc", "title-desc", "number-asc", "date-desc", "date-asc"] as const;
export type SongSortOrder = (typeof SONG_SORT_ORDERS)[number];

export type SongUpsert = Omit<Song, "id" | "updatedAt" | "sourceFolder" | "file"> & { id?: number };

export type SongUsage = { programId: number; programName: string; itemCount: number };

/** What «Importar» opens in one picker (owner, 2026-11-05: any supported
 *  format, no menu): OpenLyrics, SongSelect and ChordPro files, OpenLP's
 *  `songs.sqlite` and EasyWorship's `Songs.db`. */
export const SONG_IMPORT_EXTENSIONS = ["xml", "txt", "cho", "chordpro", "chopro", "crd", "pro", "sqlite", "db"] as const;

/** The song files a linked folder shows: the importable ones that are one
 *  file, not a database. */
export const SONG_FILE_EXTENSIONS = ["xml", "txt", "cho", "chordpro", "chopro", "crd", "pro"] as const;

/** One song in the CCLI usage report: the days it went live (one per day). */
export type SongUse = { title: string; authors: string | null; ccliNumber: string | null; days: number[] };

/** What an import did: written, skipped as already there (same title, same
 *  words), not written because the song had no title or no lyrics, and files
 *  that were no song file the app reads (another program's, broken, or
 *  unreadable). */
export type SongImportResult = { imported: number; repeated: number; problems: number; unsupported: number };

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
  /** `SongSlide.chords`, carried to the musicians' screen. */
  chords?: SongChord[][];
  /** Drawn under `lines`, smaller (`SongTheme.translation`): only when the song
   *  is resolved in «both» and this slide has one. */
  translation?: string[];
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
 *  `sections` are there for a jump to one that is not in the order; both are
 *  already split to the theme's lines per slide. `footer` is the copyright
 *  footer's lines, composed (`songFooterLines`) — whether a slide shows it is
 *  the theme's `footer.show`. */
export type ResolvedSong = {
  id: number;
  title: string;
  slides: SongDeckSlide[];
  sections: SongSection[];
  footer: readonly string[];
};

/** Margins of the text block, in `cqw` (width of the stage), every side —
 *  `cqw` and never `cqh` for `OutputView`'s reason. */
export type SongMargins = { top: number; bottom: number; left: number; right: number };

/** Which slides carry the copyright footer — ProPresenter's and FreeShow's set. */
export const SONG_FOOTER_SHOWS = ["never", "first", "last", "firstAndLast", "all"] as const;
export type SongFooterShow = (typeof SONG_FOOTER_SHOWS)[number];

export const SONG_FOOTER_ALIGNS = ["left", "center", "right"] as const;
export type SongFooterAlign = (typeof SONG_FOOTER_ALIGNS)[number];

/** What the footer says, each piece only when the song has it. */
export type SongFooterFields = {
  title: boolean;
  authors: boolean;
  copyright: boolean;
  ccli: boolean;
  /** The church's CCLI licence (Settings ▸ Songs). */
  license: boolean;
};

/**
 * The copyright footer. Its own size, outside the song's one size, and its
 * place is kept on EVERY slide whenever it is on (owner, 2026-11-04), so the
 * lyrics never move when it appears on the last one.
 */
export type SongFooter = {
  show: SongFooterShow;
  fields: SongFooterFields;
  text: SceneTextStyle;
  align: SongFooterAlign;
};

/** A drawn outline around each letter — what reads over a photo. */
export type SongOutline = { enabled: boolean; color: string; widthCqw: number };

/** Between two slides of the same song: a cut, or a fade of `durationMs`. */
export type SongSlideTransition = { style: "cut" | "fade"; durationMs: number };

/** The second language, stacked under the lyrics: `scale` of the lyrics' size. */
export type SongTranslationStyle = { scale: number; color: string; italic: boolean };
export const SONG_TRANSLATION_SCALE_MIN = 0.4;
export const SONG_TRANSLATION_SCALE_MAX = 1;

/** The footer's lines: at most two, so the place it keeps is known. */
export const SONG_FOOTER_LINES = 2;

export const SONG_THEME_VERSION = 1;

/** A looping video behind the lyrics, never heard — songs only: the verse,
 *  the time scenes and the plates keep `SceneBackground` (owner, 2026-11-05;
 *  plan `2026-11-05-video-de-fondo`). Any video the library takes: one the
 *  projector cannot play goes through the media engine, like a live video. */
export type SongVideoBackground = { kind: "video"; assetId: number; fit: BackgroundFit };
export type SongBackground = SceneBackground | SongVideoBackground;

/**
 * How a song looks — every knob of the theme editor (owner: «que se puedan
 * editar espacios, tamaños, colores»). A field added later is a branch in
 * `normalizeSongTheme` that falls back to its default, never a migration.
 */
export type SongTheme = {
  version: typeof SONG_THEME_VERSION;
  background: SongBackground;
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
  /** CAPITALS on screen; the stored lyrics keep their case. */
  uppercase: boolean;
  /** CSS `letter-spacing`, in `em`. */
  letterSpacingEm: number;
  outline: SongOutline;
  /** A slide with more lines is split when it is drawn, never when it is
   *  saved. 0 = no limit. */
  maxLines: number;
  footer: SongFooter;
  slideTransition: SongSlideTransition;
  translation: SongTranslationStyle;
};

export type SongThemeUpsert = { id?: number; name: string; style: SongTheme };

export type SongThemeRow = { id: number; name: string; style: SongTheme };

export const SONG_SIZE_MIN_CQW = 0.5;
export const SONG_SIZE_MAX_CQW = 30;
export const SONG_MARGIN_MAX_CQW = 40;
export const SONG_LETTER_SPACING_MIN_EM = -0.1;
export const SONG_LETTER_SPACING_MAX_EM = 0.5;
export const SONG_OUTLINE_MAX_CQW = 1;
export const SONG_MAX_LINES_MAX = 20;
export const SONG_THEME_NAME_MAX_LENGTH = 80;

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
  uppercase: false,
  letterSpacingEm: 0,
  outline: { enabled: false, color: "#000000", widthCqw: 0.12 },
  maxLines: 0,
  // On the last slide (owner, 2026-11-04), saying everything the song has.
  footer: {
    show: "last",
    fields: { title: true, authors: true, copyright: true, ccli: true, license: true },
    text: { sizeCqw: 1.4, color: "#eef2f6", weight: 400, shadow: true, shadowStrength: DEFAULT_SHADOW_STRENGTH },
    align: "center",
  },
  // A short fade between slides of the same song (owner, 2026-11-04).
  slideTransition: { style: "fade", durationMs: 300 },
  // Smaller, softer and slanted, so the eye tells the two languages apart.
  translation: { scale: 0.75, color: "#cfd8e3", italic: true },
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

/** The footer's lines for a song: «Title — Authors», then «© … · CCLI n.º … ·
 *  Licence …», each piece only when it is on and the song has it. `labels`
 *  are the interface's words for the two CCLI numbers. */
export function songFooterLines(
  song: Pick<Song, "title" | "authors" | "copyright" | "ccliNumber">,
  fields: SongFooterFields,
  license: string | null,
  labels: { ccli: string; license: string },
): string[] {
  const first = [fields.title ? song.title : null, fields.authors ? song.authors : null].filter(Boolean);
  const second = [
    fields.copyright && song.copyright ? `© ${song.copyright.replace(/^©\s*/, "")}` : null,
    fields.ccli && song.ccliNumber ? `${labels.ccli} ${song.ccliNumber}` : null,
    fields.license && license ? `${labels.license} ${license}` : null,
  ].filter(Boolean);
  return [first.join(" — "), second.join(" · ")].filter((line) => line !== "");
}
