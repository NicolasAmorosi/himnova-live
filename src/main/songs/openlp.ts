import fs from "node:fs";
import Database from "better-sqlite3";
import { XMLParser } from "fast-xml-parser";
import { sectionKey, withTranslation } from "@shared/song-text";
import { isSongUpsert, SONG_FIELD_MAX_LENGTH, SONG_NOTES_MAX_LENGTH, SONG_TITLE_MAX_LENGTH } from "@shared/song-validators";
import { SONG_SECTION_NUMBER_MAX, type SongSection, type SongSectionType, type SongUpsert } from "@shared/types/song";
import { walkXml } from "../db/seed/bible-formats/xml-ordered";
import { ccliNumber, clip, type SongsRead } from "./easyworship";

/**
 * OpenLP's song database (`songs.sqlite`) and OpenLyrics, the XML it exports
 * one song per file. Both name a verse the same way — a type letter and a
 * label, `v1`, `c`, `v1a` — and both may carry the same verse in more than one
 * language: the first language met is the lyrics, the second the «Traducción»
 * (owner, 2026-11-05), any other is dropped.
 *
 * Chords (`[G]` in OpenLP's text, `<chord>` in OpenLyrics) and formatting tags
 * are dropped: the app has no chords yet.
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
    const lines = slides.filter((slide) => slide.length > 0).map((slide) => ({ lines: slide }));
    if (lines.length === 0) return;
    const existing = this.list.find((section) => section.key === key);
    if (existing) existing.slides.push(...lines);
    else this.list.push({ key, type, number, slides: lines });
  }
}

/** The languages in the order they first appear; `""` is a verse without one. */
class ByLanguage {
  private readonly languages = new Map<string, Sections>();

  get(lang: string): Sections {
    let sections = this.languages.get(lang);
    if (!sections) {
      sections = new Sections();
      this.languages.set(lang, sections);
    }
    return sections;
  }

  sections(): SongSection[] {
    const [lyrics, translation] = [...this.languages.values()];
    if (!lyrics) return [];
    return translation ? withTranslation(lyrics.list, translation.list) : lyrics.list;
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

/** OpenLP's chords inside the text: `[G]`, `[F#m7]`, `[C/E]` — never a word
 *  in brackets like `[Coro]`, nor its own `[---]`. */
const CHORD = /\[[A-H][#b]?(?:m|maj|min|dim|aug|sus|add|M|\d|[+°ø#b()-])*(?:\/[A-H][#b]?)?\]/g;
/** `[---]` (optional) and `[--}{--]` (forced): both are a new slide here. */
const SLIDE_BREAK = /^\s*\[(?:---|--\}\{--)\]\s*$/;

/** The text of one OpenLP verse → its slides. */
function openLpSlides(text: string): string[][] {
  const slides: string[][] = [[]];
  const plain = text
    .replace(/\{br\}/g, "\n")
    .replace(/\{\/?[a-z][a-z0-9]*\}/gi, "")
    .replace(CHORD, "");
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

type OpenLpVerse = string | { type?: string; label?: string; lang?: string; "#cdata"?: string; "#text"?: string };

/** OpenLP's `lyrics` column: `<song version="1.0"><lyrics><verse type="v" label="1">`. */
export function readOpenLpLyrics(xml: string): SongSection[] {
  const verses = (lyricsParser.parse(xml) as { song?: { lyrics?: { verse?: OpenLpVerse[] } } }).song?.lyrics?.verse ?? [];
  const languages = new ByLanguage();
  for (const entry of verses) {
    // A verse with no attributes at all parses as its bare text.
    const verse = typeof entry === "string" ? { "#text": entry } : entry;
    const text = String(verse["#cdata"] ?? verse["#text"] ?? "");
    languages.get(verse.lang ?? "").add(verse.type ?? "o", String(verse.label ?? "1"), openLpSlides(text));
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
 * One OpenLyrics file (0.8, what OpenLP writes, and 0.9) → a song, or `null`
 * when it has no title or no lyrics. Read in document order: inside `<lines>`
 * the text, `<br/>` and `<chord/>` are siblings, and the indentation around
 * them is not text — only `<br/>` is a new line. Each `<lines>` is a slide.
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
  let verse: { letter: string; label: string; lang: string; slides: string[][] } | null = null;
  let slide: string | null = null;

  walkXml(xml, {
    enter: (tag, attrs) => {
      // `<comment>` inside a verse is a note to the singers, never projected.
      if (tag === "comment" && verse) return false;
      text = "";
      if (tag === "songbook" && !number && attrs.entry?.trim()) number = attrs.entry.trim();
      if (tag === "verse") {
        verse = { ...splitName(attrs.name ?? "o"), lang: attrs.lang ?? "", slides: [] };
      }
      if (tag === "lines" && verse) slide = "";
      if (tag === "br" && slide !== null) slide += "\n";
      return true;
    },
    exit: (tag) => {
      const value = text.replace(/\s+/g, " ").trim();
      if (tag === "title" && value) titles.push(value);
      if (tag === "author" && value && !authors.includes(value)) authors.push(value);
      if (tag === "comment" && value) comments.push(value);
      if (tag === "copyright") copyright = value;
      if (tag === "ccliNo") ccli = value;
      if (tag === "verseOrder") verseOrder = value;
      if (tag === "lines" && verse && slide !== null) {
        verse.slides.push(slide.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean));
        slide = null;
      }
      if (tag === "verse" && verse) {
        languages.get(verse.lang).add(verse.letter, verse.label, verse.slides);
        verse = null;
      }
      text = "";
    },
    text: (value) => {
      if (slide !== null) slide += value;
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
  const songs: Omit<SongUpsert, "id">[] = [];
  let problems = 0;
  for (const file of files) {
    let song: Omit<SongUpsert, "id"> | null = null;
    try {
      song = readOpenLyrics(fs.readFileSync(file, "utf-8"));
    } catch (error) {
      console.warn("[songs] OpenLyrics file unreadable", file, error);
    }
    if (song) songs.push(song);
    else problems += 1;
  }
  return { songs, problems };
}
