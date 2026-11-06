import { CHORD_PATTERN, sectionLabel, writtenLines } from "@shared/song-text";
import type { SongSection, SongSectionType, SongUpsert } from "@shared/types/song";
import { COPYRIGHT_LINE, LICENCE_LINE } from "./text-files";

/**
 * A song edited in the app written back to the file it came from, in that
 * file's own format: the inverse of `readOpenLyrics` (`openlp.ts`) and of
 * `readChordPro` / `readSongSelect` (`text-files.ts`). Pure — the caller writes
 * the text as UTF-8. The contract is a round trip: what the format's reader
 * reads back is the same song, for every field the format holds.
 *
 * Every writer gives the file only what the song holds, so whatever the file
 * had that the app never read (alternate titles, a songbook's name, author
 * types, a third language, formatting tags, CCLI's licence lines) is not in
 * the file written back.
 */

/** What a writer reads of a song: never its theme or folder, the app's own. */
export type WrittenSong = Pick<
  SongUpsert,
  "title" | "number" | "authors" | "copyright" | "ccliNumber" | "notes" | "sections" | "order"
>;

/** «Verse 1», «Chorus 1»: always numbered, because `parseLyrics` takes a bare
 *  «Chorus» for whichever chorus has the same words, or the newest one. */
function label({ type, number }: Pick<SongSection, "type" | "number">): string {
  const name = sectionLabel(type, number, "en");
  return /\d$/.test(name) ? name : `${name} ${number}`;
}

/** The readers join several authors with «, »; written back as several. */
const authorList = (authors: string | null): string[] => (authors ? authors.split(", ").filter(Boolean) : []);

/* ---------------------------------------------------------------------------
 * OpenLyrics
 * ------------------------------------------------------------------------ */

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const xml = (text: string): string => text.replace(/[&<>"']/g, (char) => XML_ESCAPES[char]!);

const VERSE_LETTER: Record<SongSectionType, string> = {
  verse: "v",
  prechorus: "p",
  chorus: "c",
  bridge: "b",
  ending: "e",
  intro: "i",
  other: "o",
};

const verseName = (section: SongSection): string => `${VERSE_LETTER[section.type]}${section.number}`;

/** One slide: its lines by `<br/>`, its chords in 0.8's `name` form — 0.9's
 *  `root`/`structure` would need a chord grammar, and the reader keeps only
 *  the root of it. One line per row, as OpenLP writes it: the indentation is
 *  not text, and it keeps a line like «1.» from being read as the number 1
 *  (`walkXml` parses a text node with no space around it as a number). */
const linesXml = (lines: readonly string[]): string[] => [
  "<lines>",
  ...lines.map(
    (line, index) =>
      `  ${xml(line).replace(CHORD_PATTERN, '<chord name="$1"/>')}${index < lines.length - 1 ? "<br/>" : ""}`,
  ),
  "</lines>",
];

/**
 * OpenLyrics 0.9. Each section is a `<verse>` (`v1`, `c2`, `p1` for a
 * pre-chorus), each slide a `<lines>`; the translation follows its section as
 * the same verse with `lang="und"`, the original carrying no `lang` — the song
 * does not know which languages they are. Cannot carry: the languages' codes,
 * and a translation that skips a slide before a translated one (the reader
 * pairs translations by position and drops an empty `<lines>`, the same limit
 * as `translationSections`). The number goes in a songbook with no name.
 */
export function writeOpenLyrics(song: WrittenSong): string {
  const byKey = new Map(song.sections.map((section) => [section.key, section]));
  const order = song.order.flatMap((key) => {
    const section = byKey.get(key);
    return section ? [verseName(section)] : [];
  });
  const notes = (song.notes ?? "").split(/\r?\n/).filter((line) => line.trim());
  const properties = [
    `<titles><title>${xml(song.title)}</title></titles>`,
    authorList(song.authors).length > 0
      ? `<authors>${authorList(song.authors).map((author) => `<author>${xml(author)}</author>`).join("")}</authors>`
      : "",
    song.copyright ? `<copyright>${xml(song.copyright)}</copyright>` : "",
    song.ccliNumber ? `<ccliNo>${xml(song.ccliNumber)}</ccliNo>` : "",
    order.length > 0 ? `<verseOrder>${order.join(" ")}</verseOrder>` : "",
    song.number ? `<songbooks><songbook name="" entry="${xml(song.number)}"/></songbooks>` : "",
    notes.length > 0 ? `<comments>${notes.map((note) => `<comment>${xml(note)}</comment>`).join("")}</comments>` : "",
  ].filter(Boolean);
  const verse = (open: string, slides: readonly string[][]): string[] => [
    open,
    ...slides.flatMap(linesXml).map((line) => `  ${line}`),
    "</verse>",
  ];
  const verses = song.sections.flatMap((section) => {
    const name = verseName(section);
    const translated = section.slides.flatMap((slide) =>
      slide.translation?.some((line) => line.trim()) ? [slide.translation] : [],
    );
    return [
      ...verse(`<verse name="${name}">`, section.slides.map(writtenLines)),
      ...(translated.length > 0 ? verse(`<verse name="${name}" lang="und">`, translated) : []),
    ];
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<song xmlns="http://openlyrics.info/namespace/2009/song" version="0.9">',
    "  <properties>",
    ...properties.map((line) => `    ${line}`),
    "  </properties>",
    "  <lyrics>",
    ...verses.map((line) => `    ${line}`),
    "  </lyrics>",
    "</song>",
    "",
  ].join("\n");
}

/* ---------------------------------------------------------------------------
 * ChordPro
 * ------------------------------------------------------------------------ */

/** The one environment other ChordPro programs know for each section. */
const environment = (type: SongSectionType): string => (type === "chorus" || type === "bridge" ? type : "verse");

function chordProSong(song: WrittenSong): string[] {
  const out = [`{title: ${song.title}}`, ...authorList(song.authors).map((author) => `{artist: ${author}}`)];
  if (song.copyright) out.push(`{copyright: ${song.copyright}}`);
  if (song.ccliNumber) out.push(`{ccli: ${song.ccliNumber}}`);

  const byKey = new Map(song.sections.map((section) => [section.key, section]));
  const sung = song.order.filter((key) => byKey.has(key));
  // ponytail: a linear text cannot hold a section the order never sings, so it
  // is written after the order and sung there once read back. The other way
  // out — leaving it out — loses its words.
  const keys = sung.length > 0 ? [...sung, ...[...byKey.keys()].filter((key) => !sung.includes(key))] : [...byKey.keys()];

  const written = new Set<string>();
  // What `{chorus}` repeats: the newest chorus written.
  let lastChorus: string | null = null;
  for (const key of keys) {
    const section = byKey.get(key)!;
    if (written.has(key)) {
      out.push("", key === lastChorus ? "{chorus}" : `{comment: ${label(section)}}`);
      continue;
    }
    written.add(key);
    if (section.type === "chorus") lastChorus = key;
    const env = environment(section.type);
    out.push(
      "",
      `{start_of_${env}: ${label(section)}}`,
      section.slides.map((slide) => writtenLines(slide).join("\n")).join("\n\n"),
      `{end_of_${env}}`,
    );
  }
  return out;
}

/**
 * ChordPro, one or more songs (`{new_song}` between them). Linear, so the song
 * is written in its order: a section's first pass is its block, a repeat is
 * `{chorus}` when it is the newest chorus and `{comment: Verse 1}` otherwise —
 * both of which `readChordPro` reads as that section again. Cannot carry: the
 * number, the notes and the translation (its reader reads none of them), a
 * section the order skips (see above), and the sections' own sequence when
 * the order is not empty — they come back in the order's first passes.
 */
export function writeChordPro(songs: readonly WrittenSong[]): string {
  return `${songs.map((song) => chordProSong(song).join("\n")).join("\n\n{new_song}\n")}\n`;
}

/* ---------------------------------------------------------------------------
 * SongSelect
 * ------------------------------------------------------------------------ */

/**
 * SongSelect's lyrics `.txt`, with its CRLF: the title, each section as its
 * label and its lines, then the 2023 footer — the authors right above
 * `CCLI Song #`, then the copyright. Cannot carry: the order (written as the
 * sections are), slides (a blank line starts a section, so a section's slides
 * are one block), chords, the number, the notes and the translation. A
 * copyright without «©» stays so under the authors, where the old footer had
 * it; with no authors line it gets the sign, or it would be read as them.
 */
export function writeSongSelect(song: WrittenSong): string {
  const sections = song.sections.map((section) =>
    [label(section), ...section.slides.flatMap((slide) => slide.lines.filter((line) => line.trim()))].join("\r\n"),
  );
  const { authors, copyright } = song;
  const signed =
    copyright && !COPYRIGHT_LINE.test(copyright) && (!authors || LICENCE_LINE.test(copyright))
      ? `© ${copyright}`
      : copyright;
  const footer = [authors, `CCLI Song #${song.ccliNumber ?? ""}`, signed].filter(Boolean);
  return `${[song.title, "", "", sections.join("\r\n\r\n\r\n"), "", ...footer].join("\r\n")}\r\n`;
}
