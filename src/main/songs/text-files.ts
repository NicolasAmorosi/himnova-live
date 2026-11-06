import fs from "node:fs";
import path from "node:path";
import { decodeText } from "../decode-text";
import { isSectionLabel, isWrittenChord, parseLyrics, textOrder } from "@shared/song-text";
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
/** The licence words under every SongSelect song, never the song's own. Not
 *  «All rights reserved» alone: a song's copyright says it as often («2026
 *  Example Music. All rights reserved»). */
export const LICENCE_LINE = /for use solely|ccli\.com|songselect/i;
/** A title of dashes or other marks only — Lyrix's «-------------» rule: another
 *  program's text, never a song this reader understands (nor overwrites). */
const NO_WORDS = /^[\p{P}\p{S}\s]*$/u;

/** A line shaped like a section's name: one word, maybe a number. */
const LABEL_LIKE = /^\p{L}[\p{L}'’-]*(?:\s+\d{1,2})?:?$/u;

/** Where a SongSelect text's title and «CCLI Song #» are, or `null` when it is
 *  not one. */
function songSelectShape(all: readonly string[]): { titleAt: number; ccliAt: number } | null {
  const titleAt = all.findIndex(Boolean);
  const ccliAt = all.findIndex((line, index) => index > titleAt && CCLI_LINE.test(line));
  return titleAt < 0 || ccliAt < 0 || NO_WORDS.test(all[titleAt]!) ? null : { titleAt, ccliAt };
}

/**
 * SongSelect's lyrics (`.txt`): the title, then blocks whose first line names
 * the section («Verse 1», «Chorus», «Tag»), then the footer. Since 2023 the
 * footer is the authors, «CCLI Song #», «©», the licence words and the
 * church's licence number; before, the song number came first and a copyright
 * without «©» came after the authors. Both are read (as OpenLP's
 * `cclifile.py` does): the authors are the footer's first line that is not a
 * «©» one, the copyright every other line — two in OpenLP's `TestSong.txt`.
 * `null` when the text has no CCLI footer: not one.
 */
export function readSongSelect(text: string, locale: Locale): ReadSong | null {
  const all = lines(text);
  const shape = songSelectShape(all);
  if (!shape) return null;
  const { titleAt, ccliAt } = shape;
  // The 2023 footer starts with the authors, right above the song number.
  const footerAt = all[ccliAt - 1] ? ccliAt - 1 : ccliAt;
  const body = all.slice(titleAt + 1, footerAt);
  const footer = all.slice(footerAt).filter(Boolean);

  const others = footer.filter((line) => !CCLI_LINE.test(line) && (COPYRIGHT_LINE.test(line) || !LICENCE_LINE.test(line)));
  const authorsAt = others.findIndex((line) => !COPYRIGHT_LINE.test(line));
  const fields: Fields = {
    title: all[titleAt]!,
    authors: authorsAt >= 0 ? [others[authorsAt]!.split(/\s*\|\s*/).join(", ")] : [],
    copyright: others.filter((_, index) => index !== authorsAt).join(" "),
    ccli: /\d+/.exec(footer.find((line) => CCLI_LINE.test(line))!)?.[0] ?? "",
  };
  // A block's first line is its label when it names a section, when it looks
  // like one (a word and maybe a number: «Interlude», «Misc 2»), or when two
  // blank lines stand above it — SongSelect's own gap between sections. Any
  // other block is words («How sweet the sound»): a slide of the section above.
  const lyrics = body
    .map((line, index) =>
      line &&
      !body[index - 1] &&
      (isSectionLabel(line, locale) || LABEL_LIKE.test(line) || (index >= 2 && !body[index - 2]))
        ? `[${line}]`
        : line,
    )
    .join("\n");
  return songFrom(fields, lyrics, locale);
}

/* ---------------------------------------------------------------------------
 * ChordPro
 * ------------------------------------------------------------------------ */

/** `{title: X}`, `{title X}`, `{soc}`, a setting (`{+settings.transcode: roman}`);
 *  a selector (`{title-es: …}`) is dropped. */
const DIRECTIVE = /^\{\s*\+?([a-z][\w.]*)(?:-[\w-]+)?(?:\s*[:\s]\s*(.*?))?\s*\}$/i;

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

/** A directive line → its full name (`soc` is `start_of_chorus`) and its
 *  value; `null` for any other line. */
export function directiveOf(line: string): { name: string; value: string } | null {
  const match = DIRECTIVE.exec(line.trim());
  if (!match) return null;
  const raw = match[1]!.toLowerCase();
  return { name: SHORT_NAMES[raw] ?? raw, value: match[2]?.trim() ?? "" };
}

/** Sections that are music for the band, not words for the room. */
export const NOT_LYRICS = new Set(["tab", "grid", "abc", "ly", "svg", "textblock"]);
const DEFAULT_LABEL: Record<string, string> = { chorus: "Chorus", verse: "Verse", bridge: "Bridge" };

/** ChordPro is a text with a directive line — unless it is SongSelect's: a
 *  plain title first and a CCLI footer, whatever braces a lyric holds
 *  («{bis}»). */
export const isChordPro = (text: string): boolean => {
  const all = lines(text);
  if (!all.some((line) => DIRECTIVE.test(line))) return false;
  const first = all.find(Boolean) ?? "";
  return /^[{#]/.test(first) || songSelectShape(all) === null;
};

/** A lyric's words as the ChordPro writer escapes them, ChordPro's own `\`:
 *  `\[` a bracket that is not a chord, `\#` and `\{` a line that would be a
 *  remark or a directive, `\\` the backslash. */
const ESCAPED = /\\([\\[\]{}#])/g;

/** A line that is a lone `\`: the writer's empty line INSIDE a slide — a
 *  blank line would start another slide. The editor's own text says it the
 *  same way, and a backslash of the words is written `\\`. */
export const CHORDPRO_EMPTY_LINE = "\\";

/** A ChordPro lyric line → its words with their chords inline, the writer's
 *  escapes undone and an annotation (`[*Rit.]`) dropped; "" for a line with
 *  neither. A line of chords alone (`[G] [D] [Em]`) is one: an instrumental
 *  line (owner, 2026-11-06), shown on the musicians' screen. */
export const chordProWords = (line: string): string =>
  line
    .replace(/\\.|\[[^\]]*\]/g, (match) => (match.startsWith("\\") || isWrittenChord(match) ? match : ""))
    .replace(ESCAPED, "$1")
    .replace(/[ \t]+/g, " ")
    .trim();

/** One song of a ChordPro text: what it reads as (`null` = no title or no
 *  words), and where its text is — from its `{new_song}` line (or the start)
 *  to the next one, so it can be replaced with the other songs' bytes as they
 *  are. `empty`: neither a title nor words, not a song at all. */
export type ChordProSong = { song: ReadSong | null; empty: boolean; from: number; to: number };

/** The text's lines with where each starts. */
function linesAt(text: string): { line: string; at: number }[] {
  const parts = text.split(/(\r\n?|\n)/);
  const out: { line: string; at: number }[] = [];
  for (let index = 0, at = 0; index < parts.length; index += 2) {
    out.push({ line: parts[index]!, at });
    at += parts[index]!.length + (parts[index + 1]?.length ?? 0);
  }
  return out;
}

/**
 * A ChordPro file → its songs (`{new_song}` starts another), every one of
 * them. A section is `{start_of_…}`/`{end_of_…}` or a `{comment}` that names
 * one (CCLI writes `{c: Verse 1}`) — unless a blank line follows it: then it
 * says where that section is sung again (OpenLP's swing-low: `{c:Chorus}`
 * between verses), like `{chorus}`, which repeats the last chorus. A paragraph
 * outside any section is a verse of its own, a blank line inside one a new
 * slide, and a line that names a section where a block starts («Verse:»,
 * «Bridge 2:») is that block's label. Chords (`[G]`) come in, a line of chords
 * alone too; any other bracket (`[*Rit.]`), `#` remarks, tabs and grids are
 * dropped, `\[`, `\#`, `\{` are the words the writer escaped, and a lone `\` an
 * empty line inside a slide. A song without `{title}` takes the file's name.
 */
export function chordProSongs(text: string, fallbackTitle: string, locale: Locale): ChordProSong[] {
  type Draft = Fields & { lyrics: string[]; from: number };
  const blocks: ChordProSong[] = [];
  const draft = (from: number): Draft => ({ title: "", authors: [], copyright: "", ccli: "", lyrics: [], from });
  const close = (to: number) =>
    blocks.push({
      song: songFrom({ ...song, title: song.title || fallbackTitle }, song.lyrics.join("\n"), locale),
      empty: !song.title && song.lyrics.length === 0,
      from: song.from,
      to,
    });
  let song = draft(0);
  let section: "lyrics" | "skip" | null = null;
  // The next words start a block no label named: a verse of its own.
  let unlabeled = true;
  let wordsSinceLabel = false;
  let labelAt = -1;
  const label = (name: string) => {
    song.lyrics.push("", `[${name}]`);
    labelAt = song.lyrics.length - 1;
    unlabeled = false;
    wordsSinceLabel = false;
  };
  const meta = (name: string, value: string) => {
    if (name === "title" && !song.title) song.title = value;
    if (["artist", "composer", "lyricist"].includes(name) && value && !song.authors.includes(value)) song.authors.push(value);
    if (name === "copyright") song.copyright = value;
    if (name === "ccli") song.ccli = value;
  };

  const all = linesAt(text);
  all.forEach(({ line: raw, at }, index) => {
    const line = raw.trim();
    if (line.startsWith("#")) return;
    const directive = directiveOf(line);
    const name = directive?.name ?? "";
    const value = directive?.value ?? "";
    if (section === "skip") {
      if (name.startsWith("end_of_")) section = null;
      return;
    }
    if (directive) {
      if (name === "new_song") {
        close(at);
        song = draft(at);
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
        if (section === null && isSectionLabel(value, locale)) {
          label(value);
          // No words right under it: a section sung again here, not a label.
          if (!all[index + 1]?.line.trim()) unlabeled = true;
        }
      } else if (name === "meta") {
        const [key = "", ...rest] = value.split(/\s+/);
        meta(key.toLowerCase(), rest.join(" "));
      } else meta(name, value);
      return;
    }
    if (!line) {
      song.lyrics.push("");
      if (section === null && wordsSinceLabel) unlabeled = true;
      return;
    }
    // «Verse 1» where a paragraph starts is its label; «Verse:» on a section's
    // first line renames the label just written — only with its colon there:
    // a lyric «Coro» may well open a section (the editor reads it as words).
    const freshParagraph = section === null && unlabeled;
    if (
      (freshParagraph || (!wordsSinceLabel && line.endsWith(":"))) &&
      !line.startsWith("[") &&
      isSectionLabel(line, locale)
    ) {
      const named = line.replace(/\s*:$/, "");
      if (freshParagraph) label(named);
      else song.lyrics[labelAt] = `[${named}]`;
      return;
    }
    const words = line === CHORDPRO_EMPTY_LINE ? "" : chordProWords(line);
    if (!words && line !== CHORDPRO_EMPTY_LINE) return; // an annotation alone
    if (unlabeled && section === null) label("Verse");
    unlabeled = false;
    wordsSinceLabel = true;
    // After the editor's `\`: what this reader took for words stays words in
    // `parseLyrics`, whatever it looks like there — a lone «[C]» is a chorus
    // header in Spanish, «Coro» one in a text with no named header — and the
    // lone `\` is the empty line it means.
    song.lyrics.push(`\\${words}`);
  });
  close(text.length);
  return blocks;
}

/** A ChordPro file's songs, `null` for one with no title or no words. */
export function readChordPro(text: string, fallbackTitle: string, locale: Locale): (ReadSong | null)[] {
  return chordProSongs(text, fallbackTitle, locale).flatMap((block) => (block.empty ? [] : [block.song]));
}

/* ---------------------------------------------------------------------------
 * Files
 * ------------------------------------------------------------------------ */

/** A SongSelect or ChordPro text, told apart by its words: each song with
 *  which song of the file it is (`{new_song}` counted, an empty one too), so
 *  saving it back finds it again. `null` for one with no title or no words. */
export function readSongTextBlocks(
  text: string,
  fallbackTitle: string,
  locale: Locale,
): { song: ReadSong | null; index: number }[] {
  if (!isChordPro(text)) return [{ song: readSongSelect(text, locale), index: 0 }];
  return chordProSongs(text, fallbackTitle, locale).flatMap((block, index) =>
    block.empty ? [] : [{ song: block.song, index }],
  );
}

export const readSongText = (text: string, fallbackTitle: string, locale: Locale): (ReadSong | null)[] =>
  readSongTextBlocks(text, fallbackTitle, locale).map((block) => block.song);

/** Whether a text is a song file this reader understands at all. */
export const isSongText = (text: string): boolean => isChordPro(text) || songSelectShape(lines(text)) !== null;

/** SongSelect and ChordPro files, each read on its own: one that holds a song
 *  with no title or no words is a problem, one that cannot be read or is
 *  neither format is not a song file (`unsupported`), and the rest still come
 *  in. */
export function readSongTextFiles(files: readonly string[], locale: Locale): SongsRead {
  const songs: SongsRead["songs"] = [];
  let problems = 0;
  let unsupported = 0;
  for (const file of files) {
    let text: string;
    let mtime: number;
    try {
      text = decodeText(fs.readFileSync(file));
      mtime = Math.floor(fs.statSync(file).mtimeMs);
    } catch (error) {
      console.warn("[songs] song file unreadable", file, error);
      unsupported += 1;
      continue;
    }
    if (!isSongText(text)) {
      unsupported += 1;
      continue;
    }
    const format = isChordPro(text) ? "chordpro" : "songselect";
    for (const { song, index } of readSongTextBlocks(text, path.basename(file, path.extname(file)), locale)) {
      if (song) songs.push({ ...song, origin: { path: file, index, mtime, format } });
      else problems += 1;
    }
  }
  return { songs, problems, unsupported };
}
