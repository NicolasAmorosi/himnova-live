import { CHORD_PATTERN, isSectionLabel, sectionLabel, writtenLines } from "@shared/song-text";
import type { Locale } from "@shared/types/settings";
import type { SongChord, SongSection, SongSectionType, SongUpsert } from "@shared/types/song";
import { readOpenLyrics } from "./openlp";
import {
  CHORDPRO_EMPTY_LINE,
  chordProSongs,
  chordProWords,
  COPYRIGHT_LINE,
  directiveOf,
  LICENCE_LINE,
  NOT_LYRICS,
} from "./text-files";

/**
 * A song edited in the app written back to the file it came from, in that
 * file's own format: the inverse of `readOpenLyrics` (`openlp.ts`) and of
 * `readChordPro` / `readSongSelect` (`text-files.ts`). Pure — the caller
 * encodes the text (`encodeText`, in the encoding the file was read in). The
 * contract is a round trip: what the format's reader reads back is the same
 * song, for every field the format holds (`SONG_FILE_LIMITS`, `shared/song-file-limits.ts`,
 * says which it does not).
 *
 * Saving rewrites a file IN PLACE (`rewrite…`, owner 2026-11-06: never lose
 * what is in the file): the song's fields, and around them what the app never
 * read kept as it was — a ChordPro file's other songs byte for byte and the
 * song's own directives above and below its words (`{key}`, `{capo}`,
 * `{tempo}`, `{subtitle}`, `{meta: …}`, a tab or a grid after the lyrics…);
 * an OpenLyrics file's other properties (alternate titles, songbooks' names,
 * key, tempo, themes…), its authors' types while the authors are the same, the
 * verses of a third language or a transliteration, and everything outside
 * `<properties>` and `<lyrics>`; a SongSelect file's licence lines. A ChordPro
 * edit that leaves the words alone leaves their lines alone. What is still
 * lost when the words change: whatever sits AMONG them — a ChordPro remark or
 * tab between two sections, an OpenLyrics formatting tag or a `<lines>`'s part
 * —, and anything of a section the app rewrote.
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
/** Escaped, and without what XML 1.0 forbids — a C0 control but tab and the
 *  line ends (PowerPoint's soft break is a vertical tab: pasted, it made a
 *  file OpenLP refuses whole), a lone surrogate, U+FFFE/U+FFFF —, each a space. */
const xml = (text: string): string =>
  Array.from(text, (char) => {
    const code = char.codePointAt(0)!;
    const forbidden =
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      (code >= 0xd800 && code <= 0xdfff) ||
      code === 0xfffe ||
      code === 0xffff;
    return forbidden ? " " : (XML_ESCAPES[char] ?? char);
  }).join("");

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
 *  (`walkXml` parses a text node with no space around it as a number). An
 *  empty line is a row with nothing but its `<br/>` — the last one too, or the
 *  reader would take it for OpenLP's `<br/>` after the last line (`cutLines`). */
const linesXml = (lines: readonly string[]): string[] => [
  "<lines>",
  ...lines.map(
    (line, index) =>
      `  ${xml(line).replace(CHORD_PATTERN, '<chord name="$1"/>')}${index < lines.length - 1 || !line ? "<br/>" : ""}`,
  ),
  "</lines>",
];

type PropertyName = "titles" | "authors" | "copyright" | "ccliNo" | "verseOrder" | "songbooks" | "comments";

/** The `<properties>` the app writes, each `""` when the song has none. The
 *  notes are ONE comment, as written — OpenLP's own way. */
function propertiesXml(song: WrittenSong): Record<PropertyName, string> {
  const byKey = new Map(song.sections.map((section) => [section.key, section]));
  const order = song.order.flatMap((key) => {
    const section = byKey.get(key);
    return section ? [verseName(section)] : [];
  });
  const authors = authorList(song.authors);
  return {
    titles: `<titles><title>${xml(song.title)}</title></titles>`,
    authors: authors.length > 0 ? `<authors>${authors.map((author) => `<author>${xml(author)}</author>`).join("")}</authors>` : "",
    copyright: song.copyright ? `<copyright>${xml(song.copyright)}</copyright>` : "",
    ccliNo: song.ccliNumber ? `<ccliNo>${xml(song.ccliNumber)}</ccliNo>` : "",
    verseOrder: order.length > 0 ? `<verseOrder>${order.join(" ")}</verseOrder>` : "",
    songbooks: song.number ? `<songbooks><songbook name="" entry="${xml(song.number)}"/></songbooks>` : "",
    comments: song.notes?.trim() ? `<comments><comment>${xml(song.notes)}</comment></comments>` : "",
  };
}

/** Each section a `<verse>`, its translation the same verse in the second
 *  language right after it. `languages`: the codes to write, `""` = none. */
function versesXml(song: WrittenSong, languages: { lyrics: string; translation: string }): string[] {
  const lang = (code: string) => (code ? ` lang="${xml(code)}"` : "");
  const verse = (open: string, slides: readonly string[][]): string[] => [
    open,
    ...slides.flatMap(linesXml).map((line) => `  ${line}`),
    "</verse>",
  ];
  return song.sections.flatMap((section) => {
    const name = verseName(section);
    const translated = section.slides.flatMap((slide) =>
      slide.translation?.some((line) => line.trim()) ? [slide.translation] : [],
    );
    return [
      ...verse(`<verse name="${name}"${lang(languages.lyrics)}>`, section.slides.map(writtenLines)),
      ...(translated.length > 0 ? verse(`<verse name="${name}"${lang(languages.translation)}>`, translated) : []),
    ];
  });
}

/**
 * OpenLyrics 0.9, a new file. Each section is a `<verse>` (`v1`, `c2`, `p1`
 * for a pre-chorus), each slide a `<lines>`; the translation follows its
 * section as the same verse with `lang="und"`, the original carrying no
 * `lang` — the song does not know which languages they are (`rewriteOpenLyrics`
 * keeps a file's own codes). Cannot carry: a translation that skips a slide
 * before a translated one (the reader pairs translations by position and
 * drops an empty `<lines>`, the same limit as `translationSections`). The
 * number goes in a songbook with no name.
 */
export function writeOpenLyrics(song: WrittenSong): string {
  const properties = Object.values(propertiesXml(song)).filter(Boolean);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<song xmlns="http://openlyrics.info/namespace/2009/song" version="0.9">',
    "  <properties>",
    ...properties.map((line) => `    ${line}`),
    "  </properties>",
    "  <lyrics>",
    ...versesXml(song, { lyrics: "", translation: "und" }).map((line) => `    ${line}`),
    "  </lyrics>",
    "</song>",
    "",
  ].join("\n");
}

/** An element of a file being rewritten: its name without a prefix, where it
 *  is, its start tag and its children. */
type XmlElement = { name: string; tag: string; start: number; end: number; openEnd: number; children: XmlElement[] };

const XML_TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)(?:"[^"]*"|'[^']*'|[^'">])*?(\/?)>/g;

/** The element tree of a well-formed document (it was read), by position. */
function xmlElements(text: string): XmlElement[] {
  const roots: XmlElement[] = [];
  const stack: XmlElement[] = [];
  for (const match of text.matchAll(XML_TOKEN)) {
    const [whole, closing, opening, selfClosing] = match;
    if (closing !== undefined) {
      const element = stack.pop();
      if (element) element.end = match.index + whole.length;
    } else if (opening !== undefined) {
      const end = match.index + whole.length;
      const element: XmlElement = { name: opening.split(":").pop()!, tag: opening, start: match.index, end, openEnd: end, children: [] };
      (stack.at(-1)?.children ?? roots).push(element);
      if (!selfClosing) stack.push(element);
    }
  }
  return roots;
}

const attribute = (openTag: string, name: string): string | undefined =>
  new RegExp(`\\s(?:xml:)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(openTag)?.slice(1).find((v) => v !== undefined);

/** A language as the reader groups it (`openlp.ts`): its primary subtag. */
const primary = (code: string) => code.trim().split("-")[0]!.toLowerCase();

/**
 * `old` (an OpenLyrics file, read before) with `song` in it — see the header
 * of this file for what is kept. The XML declaration is left as it was:
 * `withXmlEncoding` names the encoding the caller writes.
 */
export function rewriteOpenLyrics(old: string, song: WrittenSong): string {
  const root = xmlElements(old).find((element) => element.name === "song");
  if (!root) return writeOpenLyrics(song);
  const before = readOpenLyrics(old);
  const raw = (element: XmlElement) => old.slice(element.start, element.end);
  const openTag = (element: XmlElement) => old.slice(element.start, element.openEnd);

  // The languages the file uses, as the reader met them.
  const verses = root.children.find((child) => child.name === "lyrics")?.children ?? [];
  const spoken = verses.filter((verse) => verse.name === "verse" && attribute(openTag(verse), "translit") === undefined);
  const lyricsCode = spoken[0] ? (attribute(openTag(spoken[0]), "lang") ?? "") : "";
  const groupOf = (verse: XmlElement) => primary(attribute(openTag(verse), "lang") ?? "") || primary(lyricsCode);
  const translationVerse = spoken.find((verse) => groupOf(verse) !== primary(lyricsCode));
  const translationCode = translationVerse ? attribute(openTag(translationVerse), "lang")! : "und";
  const read = new Set([primary(lyricsCode), ...(translationVerse ? [groupOf(translationVerse)] : [])]);

  const fresh = propertiesXml(song);
  const same = (field: keyof WrittenSong) => before !== null && JSON.stringify(before[field]) === JSON.stringify(song[field]);
  const placed = new Set<PropertyName>();
  const propertyXml = (element: XmlElement): string => {
    const name = element.name as PropertyName;
    if (!(name in fresh)) return raw(element);
    placed.add(name);
    if (name === "titles") {
      // The first title is the song's; the others (another language, an
      // alternate) stay — and the first keeps its own attributes.
      if (same("title")) return raw(element);
      const [first, ...others] = element.children.filter((child) => child.name === "title");
      if (!first) return fresh.titles;
      return `<titles>${openTag(first)}${xml(song.title)}</title>${others.map(raw).join("")}</titles>`;
    }
    if (name === "authors" && same("authors")) return raw(element);
    if (name === "songbooks") {
      if (same("number")) return raw(element);
      // The songbook the number was read from keeps its name; the others stay.
      const books = element.children.map((book) => ({ book, entry: attribute(openTag(book), "entry")?.trim() }));
      const numbered = books.find(({ entry }) => entry);
      if (!numbered) return fresh.songbooks;
      const tag = openTag(numbered.book).replace(/\s+entry\s*=\s*(?:"[^"]*"|'[^']*')/, "");
      const renamed = song.number ? tag.replace(/\s*(\/?)>$/, ` entry="${xml(song.number)}"$1>`) : tag;
      return `<songbooks>${books.map(({ book }) => (book === numbered.book ? `${renamed}${raw(book).slice(openTag(book).length)}` : raw(book))).join("")}</songbooks>`;
    }
    return fresh[name];
  };
  const children = root.children.map((child) => {
    if (child.name === "properties") {
      const kept = child.children.map(propertyXml);
      const added = (Object.keys(fresh) as PropertyName[]).filter((name) => !placed.has(name)).map((name) => fresh[name]);
      return ["<properties>", ...[...kept, ...added].filter(Boolean).map((line) => `  ${line}`), "</properties>"];
    }
    if (child.name === "lyrics") {
      // A transliteration, a third language, an instrument part: not the
      // song the app holds, kept as they were.
      const others = child.children.filter(
        (verse) => verse.name !== "verse" || attribute(openTag(verse), "translit") !== undefined || !read.has(groupOf(verse)),
      );
      return [
        "<lyrics>",
        ...versesXml(song, { lyrics: lyricsCode, translation: translationCode }).map((line) => `  ${line}`),
        ...others.map((verse) => `  ${raw(verse)}`),
        "</lyrics>",
      ];
    }
    return [raw(child)];
  });
  return [
    `${old.slice(0, root.start)}${openTag(root)}`,
    ...children.flat().map((line) => `  ${line}`),
    `</${root.tag}>`,
    "",
  ].join("\n");
}

/**
 * The XML declaration naming `encoding` (as `readText` names it), added when
 * the file had none and is not UTF-8 — whatever reads it next must not guess.
 * A declaration that already names it, in any spelling, is left as it is.
 */
export function withXmlEncoding(text: string, encoding: string): string {
  const name = encoding === "utf-8" ? "UTF-8" : encoding.startsWith("utf-16") ? "UTF-16" : encoding;
  const declaration = /^\s*<\?xml\b[^?]*\?>/.exec(text);
  if (!declaration) return encoding === "utf-8" ? text : `<?xml version="1.0" encoding="${name}"?>\n${text}`;
  const declared = /encoding\s*=\s*["']([^"']*)["']/.exec(declaration[0]);
  if (declared && sameEncoding(declared[1]!, encoding)) return text;
  const fixed = declared
    ? declaration[0].replace(declared[0], `encoding="${name}"`)
    : declaration[0].replace(/\s*\?>$/, ` encoding="${name}"?>`);
  return fixed + text.slice(declaration[0].length);
}

function sameEncoding(label: string, encoding: string): boolean {
  try {
    const named = new TextDecoder(label).encoding;
    return named === encoding || (named.startsWith("utf-16") && encoding.startsWith("utf-16"));
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------------
 * ChordPro
 * ------------------------------------------------------------------------ */

/** The one environment other ChordPro programs know for each section. */
const environment = (type: SongSectionType): string => (type === "chorus" || type === "bridge" ? type : "verse");

/** A lyric line as ChordPro holds it: the chords inline, the words escaped
 *  ChordPro's way so they read back as words — `\[` a bracket that is not a
 *  chord («Gloria \[in excelsis] Deo»), `\\`, and `\#` / `\{` at the start of
 *  a line that would be a remark («#1 en mi corazón») or a directive
 *  («{bis}»). */
function chordProLine(text: string, chords: readonly SongChord[] = []): string {
  // An empty line inside a slide: a blank one would start another slide.
  if (!text && chords.length === 0) return CHORDPRO_EMPTY_LINE;
  const escape = (words: string) => words.replace(/[\\[]/g, "\\$&");
  let line = "";
  let last = 0;
  for (const chord of chords) {
    line += `${escape(text.slice(last, chord.at))}[${chord.name}]`;
    last = chord.at;
  }
  line += escape(text.slice(last));
  return /^[#{]/.test(line) ? `\\${line}` : line;
}

/** The song's header directives, one per field it has. */
function chordProFields(song: WrittenSong): Record<"title" | "authors" | "copyright" | "ccliNumber", string[]> {
  return {
    title: [`{title: ${song.title}}`],
    authors: authorList(song.authors).map((author) => `{artist: ${author}}`),
    copyright: song.copyright ? [`{copyright: ${song.copyright}}`] : [],
    ccliNumber: song.ccliNumber ? [`{ccli: ${song.ccliNumber}}`] : [],
  };
}

/** The song's sections, each block after a blank line: one entry per line,
 *  for the caller to join with the file's own line ending. */
function chordProBody(song: WrittenSong): string[] {
  const out: string[] = [];
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
      ...section.slides.flatMap((slide, at) => [
        ...(at > 0 ? [""] : []),
        ...slide.lines.map((line, index) => chordProLine(line, slide.chords?.[index])),
      ]),
      `{end_of_${env}}`,
    );
  }
  return out;
}

function chordProSong(song: WrittenSong): string[] {
  return [...Object.values(chordProFields(song)).flat(), ...chordProBody(song)];
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

/** Which song field a header directive holds (`{meta: artist X}` too). */
const DIRECTIVE_FIELD: Record<string, "title" | "authors" | "copyright" | "ccliNumber"> = {
  title: "title",
  artist: "authors",
  composer: "authors",
  lyricist: "authors",
  copyright: "copyright",
  ccli: "ccliNumber",
};

/** Which lines of a ChordPro song are its words, as its reader takes them: a
 *  lyric, a line of chords alone, the empty line `\`, a section's start or
 *  end, a repeat — never a remark, an annotation alone, a tab's or a grid's. */
function bodyLines(lines: readonly string[]): boolean[] {
  let skip = false;
  return lines.map((raw) => {
    const line = raw.trim();
    const directive = directiveOf(line);
    if (skip) {
      if (directive?.name.startsWith("end_of_")) skip = false;
      return false;
    }
    if (!directive) return !line.startsWith("#") && (line === CHORDPRO_EMPTY_LINE || chordProWords(line) !== "");
    const kind = /^start_of_(\w+)$/.exec(directive.name)?.[1];
    if (kind !== undefined && NOT_LYRICS.has(kind)) {
      skip = true;
      return false;
    }
    return (
      /^(start_of_|end_of_)/.test(directive.name) ||
      directive.name === "chorus" ||
      (directive.name === "comment" && isSectionLabel(directive.value, "en"))
    );
  });
}

/** What ChordPro holds of a song's words: its order and each section's slides
 *  as written, chords inline — never a translation, which it cannot hold. */
const chordProWordsOf = (song: Pick<WrittenSong, "sections" | "order">): string =>
  JSON.stringify([song.order, song.sections.map((section) => [section.key, section.slides.map(writtenLines)])]);

/**
 * `old` (a ChordPro file) with its song number `index` (`{new_song}` counted,
 * an empty one too) replaced by `song` — appended as a song of its own when
 * there is no such block (`index` = their count is where it lands): the file's
 * other songs stay byte for byte, and of this one what stands above and below
 * its words (its header directives, remarks, a tab or a grid after the
 * lyrics) stays, but for the fields the song changed. An edit that leaves its
 * words alone (a title, an author…) leaves their lines as they are too —
 * remarks and spacing among them included —, but for a changed field's own
 * line. `fallbackTitle`: what the reader took for its title when it has no
 * `{title}`; `locale`: the interface's, which the app read the file in.
 */
export function rewriteChordPro(
  old: string,
  index: number,
  song: WrittenSong,
  fallbackTitle: string,
  locale: Locale = "en",
): string {
  const blocks = chordProSongs(old, fallbackTitle, locale);
  const block = blocks[index];
  const eol = /\r\n/.test(old) ? "\r\n" : "\n";
  if (!block) return `${old}${old && !/\n$/.test(old) ? eol : ""}{new_song}${eol}${chordProSong(song).join(eol)}${eol}`;
  const lines = old.slice(block.from, block.to).split(/\r\n?|\n/);
  const body = bodyLines(lines);
  const first = body.indexOf(true);
  const last = body.lastIndexOf(true);
  const sameWords = first >= 0 && block.song !== null && chordProWordsOf(block.song) === chordProWordsOf(song);
  const header = first < 0 ? lines : lines.slice(0, first);
  const footer = first < 0 ? [] : lines.slice(last + 1);
  // The words written anew start after a blank line of their own.
  if (!sameWords) while (header.length > 0 && !header.at(-1)!.trim()) header.pop();

  // A field the song kept keeps its lines as written; a changed one is
  // written anew where it was (its other lines go), or after the title.
  const fields = chordProFields(song);
  const changed = (field: keyof typeof fields) => JSON.stringify(block.song?.[field] ?? null) !== JSON.stringify(song[field] ?? null);
  const fieldOf = (line: string, titles: { seen: boolean }) => {
    const directive = directiveOf(line);
    const name = directive?.name === "meta" ? (directive.value.split(/\s+/)[0] ?? "").toLowerCase() : directive?.name;
    const field = name ? DIRECTIVE_FIELD[name] : undefined;
    // Only the first title is the song's; another (`{title-es: …}`) stays.
    if (field === "title" && titles.seen) return undefined;
    if (field === "title") titles.seen = true;
    return field && changed(field) ? field : undefined;
  };
  const placed = new Set<string>();
  const titles = { seen: false };
  const top = header.flatMap((line) => {
    const field = fieldOf(line, titles);
    if (!field) return [line];
    if (placed.has(field)) return [];
    placed.add(field);
    return fields[field];
  });
  const missing = (Object.keys(fields) as (keyof typeof fields)[]).filter((field) => changed(field) && !placed.has(field));
  const titleAt = top.findIndex((line) => directiveOf(line)?.name === "title");
  const at = titleAt >= 0 ? titleAt + 1 : directiveOf(top[0] ?? "")?.name === "new_song" ? 1 : 0;
  top.splice(at, 0, ...missing.flatMap((field) => fields[field]));
  // Below the words — and among them, when they stay — a changed field's line
  // goes: read after the new one, it would win over it.
  const bottom = footer.filter((line) => !fieldOf(line, { seen: true }));
  const words = sameWords
    ? lines.slice(first, last + 1).filter((line) => !fieldOf(line, { seen: true }))
    : chordProBody(song).slice(top.length > 0 ? 0 : 1);
  return old.slice(0, block.from) + [...top, ...words, ...bottom].join(eol) + old.slice(block.to);
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

/** `old` (a SongSelect file) as `song`, its licence lines — the church's,
 *  never the song's — kept under the footer. */
export function rewriteSongSelect(old: string, song: WrittenSong): string {
  const licence = old
    .split(/\r\n?|\n/)
    .map((line) => line.trim())
    .filter((line) => !COPYRIGHT_LINE.test(line) && (LICENCE_LINE.test(line) || /^CCLI\s+Licen[cs]e\b/i.test(line)));
  return `${writeSongSelect(song)}${licence.map((line) => `${line}\r\n`).join("")}`;
}
