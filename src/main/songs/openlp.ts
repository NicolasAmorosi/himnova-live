import fs from "node:fs";
import Database from "better-sqlite3";
import { XMLParser } from "fast-xml-parser";
import { isWrittenChord, sectionKey, slideFromWritten, withTranslation } from "@shared/song-text";
import { isSongUpsert, SONG_FIELD_MAX_LENGTH, SONG_NOTES_MAX_LENGTH, SONG_TITLE_MAX_LENGTH } from "@shared/song-validators";
import { SONG_SECTION_NUMBER_MAX, type SongSection, type SongSectionType, type SongUpsert } from "@shared/types/song";
import { walkXml } from "../db/seed/bible-formats/xml-ordered";
import { ccliNumber, clip, type SongsRead } from "./easyworship";
import { decodeText } from "../decode-text";

/**
 * OpenLP's song database (`songs.sqlite`) and OpenLyrics, the XML it exports
 * one song per file. Both name a verse the same way — a type letter and a
 * label, `v1`, `c`, `v1a` — and both may carry the same verse in more than one
 * language: the first language met is the lyrics, the second the «Traducción»
 * (owner, 2026-11-05), any other is dropped. A language is its primary subtag
 * (`en-US` is `en`), a verse without one is the lyrics', and a transliteration
 * (`translit`) is neither — never projected.
 *
 * Chords (`[G]` in OpenLP's text, `<chord>` in OpenLyrics) come in, for the
 * musicians' screen only (`SongSlide.chords`); formatting tags are dropped.
 */

const TYPE_BY_LETTER: Record<string, SongSectionType> = {
  v: "verse",
  c: "chorus",
  p: "prechorus",
  b: "bridge",
  i: "intro",
  e: "ending",
  o: "other",
};

/** `v1`, `c`, `v1a` (a part of verse 1), `pre2`… → its section and whether it
 *  named a part. OpenLP's own XML gives the letter and the label apart. */
function readName(letter: string, label: string): { type: SongSectionType; number: number; part: boolean } {
  const type = TYPE_BY_LETTER[letter.charAt(0).toLowerCase()] ?? "other";
  const match = /^(\d*)([a-z]?)/i.exec(label.trim());
  const number = Number(match?.[1] || 1);
  return { type, number: Math.min(Math.max(number, 1), SONG_SECTION_NUMBER_MAX), part: Boolean(match?.[2]) };
}

/** `v1a` → `v` + `1a`; `c` → `c` + nothing. */
function splitName(name: string): { letter: string; label: string } {
  const match = /^([a-z]+?)(\d.*)?$/i.exec(name.trim());
  return { letter: match?.[1] ?? "o", label: match?.[2] ?? "" };
}

/** One language's sections, built as the verses come: a second verse with the
 *  same key (a part, `v1b`) adds its slides to the first. */
class Sections {
  readonly list: SongSection[] = [];

  add(letter: string, label: string, slides: string[][]): void {
    const { type, number } = readName(letter, label);
    const key = sectionKey(type, number);
    // A slide of chords alone is one (an instrumental slide); one of empty lines is not.
    const lines = slides.filter((slide) => slide.some((line) => line.trim())).map(slideFromWritten);
    if (lines.length === 0) return;
    const existing = this.list.find((section) => section.key === key);
    if (existing) existing.slides.push(...lines);
    else this.list.push({ key, type, number, slides: lines });
  }
}

/** The languages in the order they first appear, each its primary subtag:
 *  the first is the lyrics' — and so is a verse with no language —, the second
 *  the translation's. A section only the translation has comes in as lyrics,
 *  so no words are dropped (`withTranslation` would drop it). */
class ByLanguage {
  private readonly languages = new Map<string, Sections>();
  private lyrics: string | null = null;

  /** `null` for a transliteration: not a language of the song's own. */
  get(lang: string, translit = false): Sections | null {
    if (translit) return null;
    const primary = lang.trim().split("-")[0]!.toLowerCase();
    this.lyrics ??= primary;
    const key = primary || this.lyrics;
    let sections = this.languages.get(key);
    if (!sections) {
      sections = new Sections();
      this.languages.set(key, sections);
    }
    return sections;
  }

  sections(): SongSection[] {
    const [lyrics, translation] = [...this.languages.values()];
    if (!lyrics) return [];
    if (!translation) return lyrics.list;
    const own = new Set(lyrics.list.map((section) => section.key));
    return withTranslation(
      [...lyrics.list, ...translation.list.filter((section) => !own.has(section.key))],
      translation.list.filter((section) => own.has(section.key)),
    );
  }
}

/** `v1 c1 v2 c1` or OpenLyrics' `v1a v1b c v2 c` → the keys the sections
 *  have; the parts of one verse in a row are that verse once. Nothing when it
 *  is the sections as written — the order an empty one already means. */
function readOrder(text: string | null | undefined, sections: readonly SongSection[]): string[] {
  const keys = new Set(sections.map((section) => section.key));
  const order: string[] = [];
  for (const token of (text ?? "").split(/[\s,]+/).filter(Boolean)) {
    const { letter, label } = splitName(token);
    const { type, number, part } = readName(letter, label);
    const key = sectionKey(type, number);
    if (!keys.has(key) || (part && order.at(-1) === key)) continue;
    order.push(key);
  }
  return JSON.stringify(order) === JSON.stringify(sections.map((section) => section.key)) ? [] : order;
}

/* ---------------------------------------------------------------------------
 * OpenLP's database
 * ------------------------------------------------------------------------ */

/** `[---]` (optional) and `[--}{--]` (forced): both are a new slide here. */
const SLIDE_BREAK = /^\s*\[(?:---|--\}\{--)\]\s*$/;

/** The text of one OpenLP verse → its slides, its `[G]` chords kept inline
 *  for `slideFromWritten` — a line of chords alone too (an instrumental line). */
function openLpSlides(text: string): string[][] {
  const slides: string[][] = [[]];
  const plain = text.replace(/\{br\}/g, "\n").replace(/\{\/?[a-z][a-z0-9]*\}/gi, "");
  for (const line of plain.split(/\r\n?|\n/)) {
    if (SLIDE_BREAK.test(line)) slides.push([]);
    else if (line.trim()) slides.at(-1)!.push(line.trim());
  }
  return slides;
}

const lyricsParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (name) => name === "verse",
  cdataPropName: "#cdata",
  trimValues: false,
});

type OpenLpVerse =
  | string
  | { type?: string; label?: string; lang?: string; translit?: string; "#cdata"?: string; "#text"?: string };

/** OpenLP's `lyrics` column: `<song version="1.0"><lyrics><verse type="v" label="1">`. */
export function readOpenLpLyrics(xml: string): SongSection[] {
  const verses = (lyricsParser.parse(xml) as { song?: { lyrics?: { verse?: OpenLpVerse[] } } }).song?.lyrics?.verse ?? [];
  const languages = new ByLanguage();
  for (const entry of verses) {
    // A verse with no attributes at all parses as its bare text.
    const verse = typeof entry === "string" ? { "#text": entry } : entry;
    const text = String(verse["#cdata"] ?? verse["#text"] ?? "");
    languages.get(verse.lang ?? "", Boolean(verse.translit))?.add(verse.type ?? "o", String(verse.label ?? "1"), openLpSlides(text));
  }
  return languages.sections();
}

type OpenLpRow = {
  id: number;
  title: string | null;
  lyrics: string | null;
  verse_order: string | null;
  copyright: string | null;
  comments: string | null;
  ccli_number: string | null;
  song_number?: string | null;
};

function tableColumns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name));
}

/** OpenLP's songs, from 2.0 on: 2.4 keeps a hymn's number in
 *  `songs_songbooks`, 2.2 and before in `songs.song_number`. A song OpenLP
 *  only kept for a service (`temporary`) is not the church's. Throws on a file
 *  that is not one. */
export function readOpenLpDatabase(file: string): SongsRead {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const columns = tableColumns(db, "songs");
    if (!columns.has("title") || !columns.has("lyrics")) throw new Error("not an OpenLP song database");
    const extra = columns.has("song_number") ? ", song_number" : "";
    const where = columns.has("temporary") ? " WHERE temporary IS NOT 1" : "";
    const rows = db
      .prepare(`SELECT id, title, lyrics, verse_order, copyright, comments, ccli_number${extra} FROM songs${where}`)
      .all() as OpenLpRow[];

    const authors = new Map<number, string[]>();
    if (tableColumns(db, "authors_songs").size > 0) {
      const pairs = db
        .prepare(
          "SELECT s.song_id AS song, a.display_name AS name FROM authors_songs s JOIN authors a ON a.id = s.author_id ORDER BY s.rowid",
        )
        .all() as { song: number; name: string | null }[];
      for (const { song, name } of pairs) {
        const names = authors.get(song) ?? [];
        if (name?.trim() && !names.includes(name.trim())) names.push(name.trim());
        authors.set(song, names);
      }
    }
    const numbers = new Map<number, string>();
    if (tableColumns(db, "songs_songbooks").has("entry")) {
      for (const { song, entry } of db
        .prepare("SELECT song_id AS song, entry FROM songs_songbooks ORDER BY rowid")
        .all() as { song: number; entry: string | null }[]) {
        if (entry?.trim() && !numbers.has(song)) numbers.set(song, entry.trim());
      }
    }

    const songs: Omit<SongUpsert, "id">[] = [];
    let problems = 0;
    for (const row of rows) {
      let sections: SongSection[] = [];
      try {
        sections = readOpenLpLyrics(row.lyrics ?? "");
      } catch {
        // Lyrics that are not XML: the song is counted below as one without.
      }
      const song: Omit<SongUpsert, "id"> = {
        title: clip(row.title, SONG_TITLE_MAX_LENGTH) ?? "",
        number: clip(numbers.get(row.id) ?? row.song_number, SONG_FIELD_MAX_LENGTH),
        authors: clip(authors.get(row.id)?.join(", "), SONG_FIELD_MAX_LENGTH),
        copyright: clip(row.copyright, SONG_FIELD_MAX_LENGTH),
        ccliNumber: ccliNumber(row.ccli_number),
        notes: clip(row.comments, SONG_NOTES_MAX_LENGTH),
        sections,
        order: readOrder(row.verse_order, sections),
        themeId: null,
      };
      if (isSongUpsert(song)) songs.push(song);
      else problems += 1;
    }
    return { songs, problems };
  } finally {
    db.close();
  }
}

/* ---------------------------------------------------------------------------
 * OpenLyrics
 * ------------------------------------------------------------------------ */

/**
 * OpenLyrics 0.9's chord `structure`, as the suffix a musician writes: its
 * shortcodes (the format's own table) and the interval formulas common enough
 * to meet. A structure it does not know keeps the root alone — a wrong chord
 * on the musicians' screen is worse than a plain one. Without this, «A min7»
 * read as «A».
 */
const CHORD_STRUCTURE: Record<string, string> = {
  maj: "", "3-5": "",
  power: "5", "5": "5",
  min: "m", "m3-5": "m",
  aug: "aug", "3-a5": "aug",
  dim: "dim", "m3-d5": "dim",
  dom7: "7", "3-5-m7": "7",
  maj7: "maj7", "3-5-7": "maj7",
  min7: "m7", "m3-5-m7": "m7",
  dim7: "dim7", "m3-d5-d7": "dim7",
  halfdim7: "m7b5", "m3-d5-m7": "m7b5",
  minmaj7: "m(maj7)", "m3-5-7": "m(maj7)",
  augmaj7: "maj7#5",
  aug7: "7#5",
  maj6: "6", "3-5-6": "6",
  maj6b: "b6",
  min6: "m6", "m3-5-6": "m6",
  min6b: "mb6",
  dom9: "9", "3-5-m7-9": "9",
  dom9b: "7b9",
  maj9: "maj9", "3-5-7-9": "maj9",
  min9: "m9", "m3-5-m7-9": "m9",
  minmaj9: "m(maj9)",
  aug9: "9#5",
  halfdim9: "m9b5",
  sus4: "sus4", "4-5": "sus4",
  sus2: "sus2", "2-5": "sus2",
  add9: "add9", "3-5-9": "add9",
};

function chordSuffix(structure: string | undefined): string {
  return structure ? (CHORD_STRUCTURE[structure.trim()] ?? "") : "";
}

/** XML's own whitespace (space, tab, CR, LF), run together: never `\s`, which
 *  would also take an ideographic space (U+3000) or a no-break space out of a
 *  line that holds one on purpose. */
const XML_EDGES = /^[ \t\r\n]+|[ \t\r\n]+$/g;
const squeeze = (value: string): string => value.replace(/[ \t\r\n]+/g, " ").replace(XML_EDGES, "");

/** A `<lines>`' text cut at each `<br/>` → its lines. The indentation around
 *  the markup is not text: a cut's lines are its non-blank rows, and a row of
 *  chords alone is a line of chords (an instrumental line). A `<br/>` ENDS a
 *  line — OpenLP writes one after every line, the last too —, so what follows
 *  the last one is no line when it holds nothing; any other cut with nothing
 *  in it is an empty line the slide has on purpose — unless it held a
 *  `<comment>` (`commented`, by cut): a note on its own line is no line. */
function cutLines(cuts: readonly string[], commented: ReadonlySet<number>): string[] {
  const rows = cuts.map((cut) => cut.split(/\r\n?|\n/).map(squeeze).filter(Boolean));
  if (rows.length > 1 && rows.at(-1)!.length === 0) rows.pop();
  return rows.flatMap((cut, index) => (cut.length > 0 ? cut : commented.has(index) ? [] : [""]));
}

/**
 * One OpenLyrics file (0.8, what OpenLP writes, and 0.9) → a song, or `null`
 * when it has no title or no lyrics. Read in document order: inside `<lines>`
 * the text, `<br/>` and `<chord/>` are siblings, and the indentation around
 * them is not text — only `<br/>` is a new line (`cutLines`). Each `<lines>`
 * is a slide.
 */
export function readOpenLyrics(xml: string): Omit<SongUpsert, "id"> | null {
  const languages = new ByLanguage();
  const titles: string[] = [];
  const authors: string[] = [];
  const comments: string[] = [];
  let copyright = "";
  let ccli = "";
  let number = "";
  let verseOrder = "";

  let text = "";
  let verse: { letter: string; label: string; lang: string; translit: boolean; slides: string[][] } | null = null;
  /** The `<lines>` being read, cut at each `<br/>`, and which cuts held a `<comment>`. */
  let slide: string[] | null = null;
  let commented = new Set<number>();

  walkXml(xml, {
    enter: (tag, attrs) => {
      // `<comment>` inside a verse is a note to the singers, never projected.
      if (tag === "comment" && verse) {
        if (slide !== null) commented.add(slide.length - 1);
        return false;
      }
      text = "";
      if (tag === "songbook" && !number && attrs.entry?.trim()) number = attrs.entry.trim();
      if (tag === "verse") {
        verse = { ...splitName(attrs.name ?? "o"), lang: attrs.lang ?? "", translit: Boolean(attrs.translit), slides: [] };
      }
      if (tag === "lines" && verse) {
        slide = [""];
        commented = new Set();
      }
      if (tag === "br" && slide !== null) slide.push("");
      // 0.8 names it (what OpenLP writes); 0.9 gives a root, a structure and a bass.
      if (tag === "chord" && slide !== null) {
        const name =
          attrs.name ??
          (attrs.root ? `${attrs.root}${chordSuffix(attrs.structure)}${attrs.bass ? `/${attrs.bass}` : ""}` : "");
        if (isWrittenChord(`[${name}]`)) slide[slide.length - 1] += `[${name}]`;
      }
      return true;
    },
    exit: (tag) => {
      const value = squeeze(text);
      if (tag === "title" && value) titles.push(value);
      if (tag === "author" && value && !authors.includes(value)) authors.push(value);
      // The notes as written: their blank lines and double spaces are the operator's.
      if (tag === "comment" && value) comments.push(text.replace(XML_EDGES, ""));
      if (tag === "copyright") copyright = value;
      if (tag === "ccliNo") ccli = value;
      if (tag === "verseOrder") verseOrder = value;
      if (tag === "lines" && verse && slide !== null) {
        verse.slides.push(cutLines(slide, commented));
        slide = null;
      }
      if (tag === "verse" && verse) {
        languages.get(verse.lang, verse.translit)?.add(verse.letter, verse.label, verse.slides);
        verse = null;
      }
      text = "";
    },
    text: (value) => {
      if (slide !== null) slide[slide.length - 1] += value;
      else text += value;
    },
  });

  const sections = languages.sections();
  const song: Omit<SongUpsert, "id"> = {
    title: clip(titles[0], SONG_TITLE_MAX_LENGTH) ?? "",
    number: clip(number, SONG_FIELD_MAX_LENGTH),
    authors: clip(authors.join(", "), SONG_FIELD_MAX_LENGTH),
    copyright: clip(copyright, SONG_FIELD_MAX_LENGTH),
    ccliNumber: ccliNumber(ccli),
    notes: clip(comments.join("\n"), SONG_NOTES_MAX_LENGTH),
    sections,
    order: readOrder(verseOrder, sections),
    themeId: null,
  };
  return isSongUpsert(song) ? song : null;
}

/** OpenLyrics files, each read on its own: one that cannot be read, or reads
 *  as no song, is a problem and the rest still come in. */
export function readOpenLyricsFiles(files: readonly string[]): SongsRead {
  const songs: SongsRead["songs"] = [];
  let problems = 0;
  let unsupported = 0;
  for (const file of files) {
    let song: Omit<SongUpsert, "id"> | null = null;
    let mtime = 0;
    try {
      const text = decodeText(fs.readFileSync(file));
      // Another program's XML (EasySlides, ProPresenter…) is no song of this format.
      if (!isOpenLyrics(text)) {
        unsupported += 1;
        continue;
      }
      song = readOpenLyrics(text);
      mtime = Math.floor(fs.statSync(file).mtimeMs);
    } catch (error) {
      console.warn("[songs] OpenLyrics file unreadable", file, error);
      unsupported += 1;
      continue;
    }
    if (song) songs.push({ ...song, origin: { path: file, index: 0, mtime, format: "openlyrics" } });
    else problems += 1;
  }
  return { songs, problems, unsupported };
}

/** An OpenLyrics document: its root element is `<song>`. */
export const isOpenLyrics = (text: string): boolean =>
  /^\s*(?:(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*)*<(?:\w+:)?song[\s>]/.test(text);
