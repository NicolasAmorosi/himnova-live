import fs from "node:fs";
import path from "node:path";
import { decodeText } from "../decode-text";
import { hasWords, isSectionLabel, isWrittenChord, parseLyrics, textOrder } from "@shared/song-text";
import { isSongUpsert, SONG_FIELD_MAX_LENGTH, SONG_TITLE_MAX_LENGTH } from "@shared/song-validators";
import type { Locale } from "@shared/types/settings";
import type { SongUpsert } from "@shared/types/song";
import { ccliNumber, clip, type SongsRead } from "./easyworship";

/**
 * Songs written as text: SongSelect's lyrics download (`.txt`) and ChordPro
 * (`.cho`, `.chordpro`, `.pro`…). Both are turned into the lyrics text the
 * editor reads — a bracketed label over each block — and parsed by
 * `parseLyrics`, so a section is named the same way whichever way it came in.
 * Which one a file is comes from its words, not its extension: a `.txt` may be
 * either. ChordPro's chords come in, for the musicians' screen only.
 */

type ReadSong = Omit<SongUpsert, "id">;
type Fields = { title: string; authors: string[]; copyright: string; ccli: string };

function songFrom(fields: Fields, lyrics: string, locale: Locale): ReadSong | null {
  const parsed = parseLyrics(lyrics, locale);
  const song: ReadSong = {
    title: clip(fields.title, SONG_TITLE_MAX_LENGTH) ?? "",
    number: null,
    authors: clip(fields.authors.join(", "), SONG_FIELD_MAX_LENGTH),
    copyright: clip(fields.copyright, SONG_FIELD_MAX_LENGTH),
    ccliNumber: ccliNumber(fields.ccli),
    notes: null,
    sections: parsed.sections,
    order: textOrder(parsed),
    themeId: null,
  };
  return isSongUpsert(song) ? song : null;
}

const lines = (text: string) => text.split(/\r\n?|\n/).map((line) => line.trim());

/* ---------------------------------------------------------------------------
 * SongSelect
 * ------------------------------------------------------------------------ */

const CCLI_LINE = /^CCLI\b/i;
export const COPYRIGHT_LINE = /^(©|\(c\)|copyright\b)/i;
/** The licence words under every SongSelect song, never the song's own. */
export const LICENCE_LINE = /for use solely|all rights reserved|ccli\.com|songselect/i;

/**
 * SongSelect's lyrics (`.txt`): the title, then blocks whose first line names
 * the section («Verse 1», «Chorus», «Tag»), then the footer. Since 2023 the
 * footer is the authors, «CCLI Song #», «©», the licence words and the
 * church's licence number; before, the song number came first and a copyright
 * without «©» came after the authors. Both are read (as OpenLP's
 * `cclifile.py` does). `null` when the text has no CCLI footer: not one.
 */
export function readSongSelect(text: string, locale: Locale): ReadSong | null {
  const all = lines(text);
  const titleAt = all.findIndex(Boolean);
  const ccliAt = all.findIndex((line, index) => index > titleAt && CCLI_LINE.test(line));
  if (titleAt < 0 || ccliAt < 0) return null;
  // The 2023 footer starts with the authors, right above the song number.
  const footerAt = all[ccliAt - 1] ? ccliAt - 1 : ccliAt;
  const body = all.slice(titleAt + 1, footerAt);
  const footer = all.slice(footerAt).filter(Boolean);

  const others = footer.filter((line) => !CCLI_LINE.test(line));
  const copyright = others.find((line) => COPYRIGHT_LINE.test(line));
  const plain = others.filter((line) => line !== copyright && !LICENCE_LINE.test(line));
  const fields: Fields = {
    title: all[titleAt]!,
    authors: plain[0] ? [plain[0].split(/\s*\|\s*/).join(", ")] : [],
    copyright: copyright ?? plain[1] ?? "",
    ccli: /\d+/.exec(footer.find((line) => CCLI_LINE.test(line))!)?.[0] ?? "",
  };
  const lyrics = body.map((line, index) => (line && !body[index - 1] ? `[${line}]` : line)).join("\n");
  return songFrom(fields, lyrics, locale);
}

/* ---------------------------------------------------------------------------
 * ChordPro
 * ------------------------------------------------------------------------ */

/** `{title: X}`, `{title X}`, `{soc}`; a selector (`{title-es: …}`) is dropped. */
const DIRECTIVE = /^\{\s*([a-z][\w]*)(?:-[\w-]+)?(?:\s*[:\s]\s*(.*?))?\s*\}$/i;

const SHORT_NAMES: Record<string, string> = {
  t: "title",
  st: "subtitle",
  c: "comment",
  ci: "comment",
  cb: "comment",
  comment_italic: "comment",
  comment_box: "comment",
  highlight: "comment",
  ns: "new_song",
  soc: "start_of_chorus",
  eoc: "end_of_chorus",
  sov: "start_of_verse",
  eov: "end_of_verse",
  sob: "start_of_bridge",
  eob: "end_of_bridge",
  sot: "start_of_tab",
  eot: "end_of_tab",
  sog: "start_of_grid",
  eog: "end_of_grid",
};

/** Sections that are music for the band, not words for the room. */
const NOT_LYRICS = new Set(["tab", "grid", "abc", "ly", "svg", "textblock"]);
const DEFAULT_LABEL: Record<string, string> = { chorus: "Chorus", verse: "Verse", bridge: "Bridge" };

export const isChordPro = (text: string): boolean => lines(text).some((line) => DIRECTIVE.test(line));

/**
 * A ChordPro file → its songs (`{new_song}` starts another). A section is
 * `{start_of_…}`/`{end_of_…}` or a `{comment}` that names one (CCLI writes
 * `{c: Verse 1}`); `{chorus}` repeats the last chorus; a paragraph outside
 * any section is a verse of its own, a blank line inside one a new slide.
 * Chords (`[G]`) come in; any other bracket (`[*Rit.]`), `#` comments, tabs
 * and grids are dropped. A song without `{title}` takes the file's name.
 */
export function readChordPro(text: string, fallbackTitle: string, locale: Locale): (ReadSong | null)[] {
  type Draft = Fields & { lyrics: string[] };
  const drafts: Draft[] = [];
  let song: Draft = { title: "", authors: [], copyright: "", ccli: "", lyrics: [] };
  let section: "lyrics" | "skip" | null = null;
  // The next words start a block no label named: a verse of its own.
  let unlabeled = true;
  let wordsSinceLabel = false;
  const label = (name: string) => {
    song.lyrics.push("", `[${name}]`);
    unlabeled = false;
    wordsSinceLabel = false;
  };
  const meta = (name: string, value: string) => {
    if (name === "title" && !song.title) song.title = value;
    if (["artist", "composer", "lyricist"].includes(name) && value && !song.authors.includes(value)) song.authors.push(value);
    if (name === "copyright") song.copyright = value;
    if (name === "ccli") song.ccli = value;
  };

  for (const line of lines(text)) {
    if (line.startsWith("#")) continue;
    const directive = DIRECTIVE.exec(line);
    const raw = directive?.[1]?.toLowerCase() ?? "";
    const name = SHORT_NAMES[raw] ?? raw;
    const value = directive?.[2]?.trim() ?? "";
    if (section === "skip") {
      if (name.startsWith("end_of_")) section = null;
      continue;
    }
    if (directive) {
      if (name === "new_song") {
        drafts.push(song);
        song = { title: "", authors: [], copyright: "", ccli: "", lyrics: [] };
        section = null;
        unlabeled = true;
      } else if (name.startsWith("start_of_")) {
        const kind = name.slice("start_of_".length);
        if (NOT_LYRICS.has(kind)) section = "skip";
        else {
          label(/label="([^"]*)"/.exec(value)?.[1] || value || DEFAULT_LABEL[kind] || kind);
          section = "lyrics";
        }
      } else if (name.startsWith("end_of_")) {
        section = null;
        unlabeled = true;
      } else if (name === "chorus") {
        label("Chorus");
        unlabeled = true;
      } else if (name === "comment") {
        if (section === null && isSectionLabel(value, locale)) label(value);
      } else if (name === "meta") {
        const [key = "", ...rest] = value.split(/\s+/);
        meta(key.toLowerCase(), rest.join(" "));
      } else meta(name, value);
      continue;
    }
    if (!line) {
      song.lyrics.push("");
      if (section === null && wordsSinceLabel) unlabeled = true;
      continue;
    }
    // Chords stay inline for `parseLyrics`; an annotation (`[*Rit.]`) goes.
    const words = line
      .replace(/\[[^\]]*\]/g, (bracketed) => (isWrittenChord(bracketed) ? bracketed : ""))
      .replace(/\s+/g, " ")
      .trim();
    if (!hasWords(words)) continue; // a line of chords only
    if (unlabeled && section === null) label("Verse");
    unlabeled = false;
    wordsSinceLabel = true;
    song.lyrics.push(words);
  }
  drafts.push(song);
  return drafts
    .filter((draft) => draft.title || draft.lyrics.length > 0)
    .map((draft) => songFrom({ ...draft, title: draft.title || fallbackTitle }, draft.lyrics.join("\n"), locale));
}

/* ---------------------------------------------------------------------------
 * Files
 * ------------------------------------------------------------------------ */

/** A SongSelect or ChordPro text, told apart by its words: its songs, `null`
 *  for one with no title or no words. */
export function readSongText(text: string, fallbackTitle: string, locale: Locale): (ReadSong | null)[] {
  return isChordPro(text) ? readChordPro(text, fallbackTitle, locale) : [readSongSelect(text, locale)];
}

/** SongSelect and ChordPro files, each read on its own: one that cannot be
 *  read, is neither, or holds a song with no title or no words is a problem
 *  and the rest still come in. */
export function readSongTextFiles(files: readonly string[], locale: Locale): SongsRead {
  const songs: SongsRead["songs"] = [];
  let problems = 0;
  for (const file of files) {
    let read: (ReadSong | null)[] = [null];
    let mtime = 0;
    try {
      read = readSongText(decodeText(fs.readFileSync(file)), path.basename(file, path.extname(file)), locale);
      mtime = Math.floor(fs.statSync(file).mtimeMs);
    } catch (error) {
      console.warn("[songs] song file unreadable", file, error);
    }
    // Which song of the file, counted the way saving it back reads the file
    // (`readSongFile`: the songs that read, in order).
    let index = 0;
    for (const song of read) {
      if (song) songs.push({ ...song, origin: { path: file, index: index++, mtime } });
      else problems += 1;
    }
  }
  return { songs, problems };
}
