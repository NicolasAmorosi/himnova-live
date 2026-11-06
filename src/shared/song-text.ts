/**
 * A song's lyrics as the operator writes them, and back.
 *
 * ```
 * [Estrofa 1]
 * first line
 * second line
 *
 * third line        ← a blank line = another slide of the same section
 * \[Repeat x2]      ← a `\` first: a lyric line, whatever it looks like
 *
 * [Coro]
 * [G]Amazing [C]grace   ← chords inline; `[G] [D]` alone, a line of chords
 * …
 * ```
 *
 * Pure, and shared on purpose: the editor parses as the operator types, and
 * an importer (F4) reads other programs' labels with the same vocabulary.
 *
 * ## Why the section names live here and not in the dictionaries
 *
 * They are the vocabulary of a TEXT FORMAT, not interface copy: the parser
 * has to read a header written in any of the four languages whatever the
 * interface is in (a church pastes lyrics from a Brazilian site into a Spanish
 * app), and the header the editor writes back has to be one the parser reads.
 * The same reason the canon's book names are data in `bible-formats/`. The
 * label a tile shows comes from here too (`sectionLabel`), so the grid and the
 * header in the text can never name a section differently.
 */
import { LOCALES, type Locale } from "./types/settings";
import {
  SECTION_KEY_PREFIX,
  SONG_SECTION_NUMBER_MAX,
  SONG_SECTION_TYPES,
  type SongChord,
  type SongDeckSlide,
  type SongLanguage,
  type SongSection,
  type SongSectionType,
  type SongSlide,
} from "./types/song";

const SECTION_NAMES: Record<Locale, Record<SongSectionType, string>> = {
  es: {
    verse: "Estrofa",
    prechorus: "Precoro",
    chorus: "Coro",
    bridge: "Puente",
    ending: "Final",
    intro: "Intro",
    other: "Otro",
  },
  en: {
    verse: "Verse",
    prechorus: "Pre-Chorus",
    chorus: "Chorus",
    bridge: "Bridge",
    ending: "Ending",
    intro: "Intro",
    other: "Other",
  },
  it: {
    verse: "Strofa",
    prechorus: "Pre-ritornello",
    chorus: "Ritornello",
    bridge: "Ponte",
    ending: "Finale",
    intro: "Intro",
    other: "Altro",
  },
  pt: {
    verse: "Estrofe",
    prechorus: "Pré-refrão",
    chorus: "Refrão",
    bridge: "Ponte",
    ending: "Final",
    intro: "Intro",
    other: "Outro",
  },
};

/** The short form of the order line («E1 C E2 C P C»). */
const SECTION_SHORT: Record<Locale, Record<SongSectionType, string>> = {
  es: { verse: "E", prechorus: "PC", chorus: "C", bridge: "P", ending: "F", intro: "I", other: "O" },
  en: { verse: "V", prechorus: "PC", chorus: "C", bridge: "B", ending: "E", intro: "I", other: "O" },
  it: { verse: "S", prechorus: "PR", chorus: "R", bridge: "P", ending: "F", intro: "I", other: "A" },
  pt: { verse: "E", prechorus: "PR", chorus: "R", bridge: "P", ending: "F", intro: "I", other: "O" },
};

/** Every other word a language writes a section with, already normalized
 *  (`normalizeWord`: no accents, no spaces or hyphens, lowercase). */
const SECTION_ALIASES: Record<Locale, Partial<Record<SongSectionType, readonly string[]>>> = {
  es: { verse: ["verso"], chorus: ["estribillo"], ending: ["coda", "outro"], intro: ["introduccion"] },
  en: { prechorus: ["pre"], chorus: ["refrain"], ending: ["outro", "end", "tag", "coda"], intro: ["introduction"] },
  it: { verse: ["verso"], prechorus: ["precoro"], chorus: ["coro"], ending: ["coda"], intro: ["introduzione"] },
  pt: { verse: ["verso"], prechorus: ["precoro"], chorus: ["coro"], intro: ["introducao"] },
};

/** `V` is a verse in every language: OpenLP's and OpenLyrics' own letter. */
const UNIVERSAL_SHORT: Record<string, SongSectionType> = { v: "verse" };

function normalizeWord(word: string): string {
  return word
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[\s\-_.]/g, "");
}

type Vocabulary = { words: Map<string, SongSectionType>; shorts: Map<string, SongSectionType> };

const VOCABULARY: Record<Locale, Vocabulary> = Object.fromEntries(
  LOCALES.map((locale) => {
    const words = new Map<string, SongSectionType>();
    const shorts = new Map<string, SongSectionType>(Object.entries(UNIVERSAL_SHORT));
    for (const type of SONG_SECTION_TYPES) {
      words.set(normalizeWord(SECTION_NAMES[locale][type]), type);
      for (const alias of SECTION_ALIASES[locale][type] ?? []) words.set(alias, type);
      shorts.set(normalizeWord(SECTION_SHORT[locale][type]), type);
    }
    return [locale, { words, shorts }];
  }),
) as Record<Locale, Vocabulary>;

/** The interface's language first: «E» is a verse in Spanish and an ending in
 *  English, «Outro» an ending in English and "other" in Portuguese. */
function lookupOrder(locale: Locale): readonly Locale[] {
  return [locale, ...LOCALES.filter((other) => other !== locale)];
}

/** Which section a word names in `locales`, or `null`. `shorts` also accepts
 *  the one- and two-letter forms, which only a bracketed header or the order
 *  line may use: a lyric line «E» on its own is not a section. */
function resolveSectionWord(word: string, locales: readonly Locale[], shorts: boolean): SongSectionType | null {
  const normalized = normalizeWord(word);
  if (!normalized) return null;
  for (const candidate of locales) {
    const vocabulary = VOCABULARY[candidate];
    const type = vocabulary.words.get(normalized) ?? (shorts ? vocabulary.shorts.get(normalized) : undefined);
    if (type) return type;
  }
  return null;
}

export function sectionKey(type: SongSectionType, number: number): string {
  return `${SECTION_KEY_PREFIX[type]}${number}`;
}

const KEY_PATTERN = /^(pc|v|c|b|e|i|o)(\d{1,2})$/;
const TYPE_BY_PREFIX = new Map(SONG_SECTION_TYPES.map((type) => [SECTION_KEY_PREFIX[type], type]));

/** A stored key read back, or `null` when it is not one. */
export function parseSectionKey(key: string): { type: SongSectionType; number: number } | null {
  const match = KEY_PATTERN.exec(key);
  const type = match ? TYPE_BY_PREFIX.get(match[1]!) : undefined;
  const number = match ? Number(match[2]) : 0;
  return type && number >= 1 && number <= SONG_SECTION_NUMBER_MAX ? { type, number } : null;
}

/** «Estrofa 2», «Coro», «Coro 2»: a verse always carries its number, any
 *  other section only from the second one on. */
export function sectionLabel(type: SongSectionType, number: number, locale: Locale): string {
  const name = SECTION_NAMES[locale][type];
  return type === "verse" || number > 1 ? `${name} ${number}` : name;
}

function sectionShort(type: SongSectionType, number: number, locale: Locale): string {
  const short = SECTION_SHORT[locale][type];
  return type === "verse" || number > 1 ? `${short}${number}` : short;
}

/* ---------------------------------------------------------------------------
 * Text → sections
 * ------------------------------------------------------------------------ */

export type ParsedLyrics = {
  sections: SongSection[];
  /** The keys in the order the text names them, repetitions included — what
   *  the editor offers as the order while the operator has not set one. */
  sequence: string[];
};

/** `named`: a bracketed header whose word is a section the app knows — what
 *  turns bare labels into lyrics (`writtenBlocks`). */
type Header = { type: SongSectionType; number: number | null; named: boolean };

/** One pair of brackets around the whole line: `[G]Amazing grace [D]` is a
 *  line with chords, not a header. */
const BRACKETED = /^\[([^[\]]*)\]$/;
const LABEL = /^(.*?)\s*(\d{1,2})?\s*:?$/u;

/** A line written after this is lyrics, whatever it looks like: the parser
 *  drops it. What `serializeLyrics` puts before a lyric line that would read
 *  as a header («[Repeat x2]»), a blank line or a line that starts with it. */
const ESCAPE = "\\";

/**
 * A header line, or `null`. Bracketed anywhere; bare («Coro», «Verse 2:») only
 * when `bare`, as the first line of a block and only as a full word. Never a
 * line that starts with `ESCAPE`.
 *
 * A chord alone on its line («[G]», «[Do]», owner 2026-11-06) is a line of
 * chords, not a header — unless it is a section's name or short form in the
 * interface's OWN language, which keeps winning: in Spanish «[C]» is still the
 * chorus and «[E1]» verse 1, in English «[E7]» is ending 7. Chords that are
 * more than one pair of brackets («[G] [D] [Em]») never read as a header.
 */
function readHeader(lines: readonly string[], index: number, locale: Locale, bare: boolean): Header | null {
  const line = lines[index]!;
  if (line.startsWith(ESCAPE)) return null;
  const bracketed = BRACKETED.exec(line);
  const blockStart = index === 0 || lines[index - 1] === "";
  if (!bracketed && !(bare && blockStart)) return null;
  const inner = (bracketed ? bracketed[1]! : line).trim();
  const label = LABEL.exec(inner);
  const word = label?.[1] ?? "";
  const number = label?.[2] ? Number(label[2]) : null;
  if (!bracketed && (normalizeWord(word).length < 3 || !line)) return null;
  const chord = bracketed !== null && isWrittenChord(line);
  const type = resolveSectionWord(word, chord ? [locale] : lookupOrder(locale), bracketed !== null);
  // An unknown bracketed name is still a header — of a section of its own.
  if (!type) return bracketed && !chord ? { type: "other", number: number && number >= 1 ? number : null, named: false } : null;
  return {
    type,
    number: number !== null && number >= 1 && number <= SONG_SECTION_NUMBER_MAX ? number : null,
    named: bracketed !== null,
  };
}

/* ---------------------------------------------------------------------------
 * Chords (2026-11-05): inline in the text, apart in the slide
 * ------------------------------------------------------------------------ */

/** A chord's root: a letter, or its Latin name (owner, 2026-11-06), with its
 *  accidental — `#`/`b` or `♯`/`♭`. */
const CHORD_ROOT = "(?:[A-H]|Do|Re|Mi|Fa|Sol|La|Si)[#b♯♭]?";

/** A chord written inline, ChordPro-style — `[G]`, `[F#m7]`, `[C/E]`, `[Sol]`,
 *  `[Rem7]`, `[Si♭/Re]`, `[Ami]` (Central Europe's minor), `[N.C.]` — never a
 *  word in brackets like `[Coro]`, nor OpenLP's `[---]`. Group 1 is the chord's
 *  name. */
export const CHORD_PATTERN = new RegExp(
  `\\[(${CHORD_ROOT}(?:m|mi|maj|min|dim|aug|sus|add|M|\\d|[+°ø#b♯♭()-])*(?:\\/${CHORD_ROOT})?|N\\.C\\.)\\]`,
  "g",
);

/** A line as written → its words, trimmed, and the chords over them. */
export function splitChords(written: string): { text: string; chords: SongChord[] } {
  const chords: SongChord[] = [];
  let text = "";
  let last = 0;
  for (const match of written.matchAll(CHORD_PATTERN)) {
    text += written.slice(last, match.index);
    chords.push({ at: text.length, name: match[1]! });
    last = match.index + match[0].length;
  }
  text += written.slice(last);
  const lead = text.length - text.trimStart().length;
  const words = text.trim();
  return { text: words, chords: chords.map(({ at, name }) => ({ at: Math.min(Math.max(0, at - lead), words.length), name })) };
}

const ONE_CHORD = new RegExp(`^${CHORD_PATTERN.source}$`);

/** Whether `[G]`-style text is a chord this format reads. */
export const isWrittenChord = (bracketed: string): boolean => ONE_CHORD.test(bracketed);

/** Whether a written line has words, not only chords. */
export const hasWords = (written: string): boolean => written.replace(CHORD_PATTERN, "").trim().length > 0;

/** The words with their chords written back in. */
export function joinChords(text: string, chords: readonly SongChord[] = []): string {
  let written = "";
  let last = 0;
  for (const chord of chords) {
    written += `${text.slice(last, chord.at)}[${chord.name}]`;
    last = chord.at;
  }
  return written + text.slice(last);
}

/** Written lines → a slide, its chords apart when it has any. */
export function slideFromWritten(written: readonly string[]): SongSlide {
  const split = written.map(splitChords);
  const lines = split.map((line) => line.text);
  return split.some((line) => line.chords.length > 0) ? { lines, chords: split.map((line) => line.chords) } : { lines };
}

/** A slide's lines as the editor writes them: chords back inline. */
export function writtenLines(slide: SongSlide): string[] {
  return slide.lines.map((line, index) => joinChords(line, slide.chords?.[index]));
}

/** Whether a line on its own names a section («Verse 1», «Coro:») and not
 *  something else («Capo 2»): what an importer asks of a note that may be either. */
export function isSectionLabel(line: string, locale: Locale): boolean {
  return readHeader([line.trim()], 0, locale, true) !== null;
}

const sameSlides = (a: readonly string[][], b: readonly string[][]) => JSON.stringify(a) === JSON.stringify(b);

class SectionCollector {
  readonly sections: SongSection[] = [];
  readonly sequence: string[] = [];
  private readonly byKey = new Map<string, SongSection>();

  /** `reserved`: the keys the text names with a number, which a bare header
   *  never takes (`collect`). */
  constructor(private readonly reserved: ReadonlySet<string>) {}

  private nextFree(type: SongSectionType): number {
    let number = 1;
    const taken = (n: number) => this.byKey.has(sectionKey(type, n)) || this.reserved.has(sectionKey(type, n));
    while (taken(number) && number < SONG_SECTION_NUMBER_MAX) number += 1;
    return number;
  }

  /** The newest section of `type`, which a bare repeated header («[Coro]»
   *  with nothing under it) means. */
  private latest(type: SongSectionType): SongSection | undefined {
    return [...this.sections].reverse().find((section) => section.type === type);
  }

  private define(type: SongSectionType, number: number, slides: string[][]): string {
    const key = sectionKey(type, number);
    const section: SongSection = { key, type, number, slides: slides.map(slideFromWritten) };
    this.sections.push(section);
    this.byKey.set(key, section);
    return key;
  }

  /** The block under `header`, filed; returns the key of the section it is. */
  add(header: Header, rawSlides: string[][]): string {
    const slides = rawSlides.filter((lines) => lines.length > 0);
    const { type } = header;
    let key: string;
    if (header.number === null) {
      const twin = this.sections.find(
        (section) => section.type === type && sameSlides(section.slides.map(writtenLines), slides),
      );
      if (slides.length === 0) key = this.latest(type)?.key ?? sectionKey(type, this.nextFree(type));
      else if (twin) key = twin.key;
      else key = this.define(type, this.nextFree(type), slides);
    } else {
      const existing = this.byKey.get(sectionKey(type, header.number));
      if (!existing) {
        key = sectionKey(type, header.number);
        if (slides.length > 0) this.define(type, header.number, slides);
      } else if (slides.length === 0 || sameSlides(existing.slides.map(writtenLines), slides)) {
        key = existing.key;
      } else {
        // The same header twice with different words: a second section, not a
        // lost one.
        key = this.define(type, this.nextFree(type), slides);
      }
    }
    this.sequence.push(key);
    return key;
  }

  result(): ParsedLyrics {
    return { sections: this.sections, sequence: this.sequence.filter((key) => this.byKey.has(key)) };
  }
}

/** A slide as written: its lines and the text line it starts on (0-based). */
type WrittenSlide = { lines: string[]; line: number };
type WrittenBlock = { header: Header; slides: WrittenSlide[] };

/** Runs of non-blank lines, each line without its `ESCAPE`. */
function slideRuns(lines: readonly string[]): WrittenSlide[] {
  const out: WrittenSlide[] = [];
  let current: WrittenSlide | null = null;
  lines.forEach((written, index) => {
    const line = written.startsWith(ESCAPE) ? written.slice(ESCAPE.length) : written;
    if (written === "") current = null;
    else if (current) current.lines.push(line);
    else out.push((current = { lines: [line], line: index }));
  });
  return out;
}

/** Text without a single header: each block is a section of its own, and a
 *  block that comes back word for word is the chorus (FreeShow's guess, the
 *  minimum; the operator corrects it). */
function blocksWithoutHeaders(lines: readonly string[]): WrittenBlock[] {
  const all = slideRuns(lines);
  const counts = new Map<string, number>();
  for (const run of all) counts.set(run.lines.join("\n"), (counts.get(run.lines.join("\n")) ?? 0) + 1);
  return all.map((run) => ({
    header: { type: (counts.get(run.lines.join("\n")) ?? 0) > 1 ? "chorus" : "verse", number: null, named: false },
    slides: [run],
  }));
}

function blocksWithHeaders(lines: readonly string[], locale: Locale, bare: boolean): WrittenBlock[] {
  const out: WrittenBlock[] = [];
  // Lines above the first header are a verse, so nothing typed is dropped.
  let header: Header | null = null;
  let body: string[] = [];
  let bodyStart = 0;
  const flush = () => {
    const slides = slideRuns(body).map((run) => ({ ...run, line: run.line + bodyStart }));
    if (header !== null || slides.length > 0) {
      out.push({ header: header ?? { type: "verse", number: null, named: false }, slides });
    }
  };
  lines.forEach((line, index) => {
    const next = readHeader(lines, index, locale, bare);
    if (!next) {
      body.push(line);
      return;
    }
    flush();
    header = next;
    body = [];
    bodyStart = index + 1;
  });
  flush();
  return out;
}

/** The text's blocks, and whether it has any header at all. Once one bracketed
 *  header names a section the app knows, a bare label is lyrics (2026-11-06):
 *  the text the editor writes always has such headers, so a slide whose first
 *  line is «Coro» — an imported hymn's printed label — reads back as that slide. */
function writtenBlocks(text: string, locale: Locale): { blocks: WrittenBlock[]; headed: boolean } {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim());
  const bare = !lines.some((_, index) => readHeader(lines, index, locale, false)?.named);
  const headed = lines.some((_, index) => readHeader(lines, index, locale, bare) !== null);
  return { blocks: headed ? blocksWithHeaders(lines, locale, bare) : blocksWithoutHeaders(lines), headed };
}

/** The blocks filed into sections; `keys` says which section each block is.
 *  A numbered header keeps its number even when a bare one is written above
 *  it (owner, 2026-11-06): a new «[Puente]» typed over the saved «[Puente 1]»
 *  is the second bridge, so an order of the operator's still sings the first. */
function collect(blocks: readonly WrittenBlock[]): { collector: SectionCollector; keys: string[] } {
  const reserved = new Set(
    blocks.flatMap(({ header, slides }) =>
      header.number !== null && slides.length > 0 ? [sectionKey(header.type, header.number)] : [],
    ),
  );
  const collector = new SectionCollector(reserved);
  const keys = blocks.map((block) => collector.add(block.header, block.slides.map((slide) => slide.lines)));
  return { collector, keys };
}

export function parseLyrics(text: string, locale: Locale): ParsedLyrics {
  return collect(writtenBlocks(text, locale).blocks).collector.result();
}

/* ---------------------------------------------------------------------------
 * The caret and the slides (the song editor, owner 2026-11-04)
 * ------------------------------------------------------------------------ */

/** Every slide as written, in the text's order: the section `parseLyrics` files
 *  it under, its index there (before a theme splits it), its lines, and
 *  whether it has words (not only chords). A chorus written twice is two
 *  entries of the same key. */
type SlideSpan = { key: string; index: number; line: number; lines: number; words: boolean };

function slideSpans(text: string, locale: Locale): SlideSpan[] {
  const { blocks } = writtenBlocks(text, locale);
  const { keys } = collect(blocks);
  return blocks.flatMap((block, b) =>
    block.slides.map((slide, index) => ({
      key: keys[b]!,
      index,
      line: slide.line,
      lines: slide.lines.length,
      words: slide.lines.some(hasWords),
    })),
  );
}

/** A block this long with no blank line in it — a whole song pasted at once —
 *  is never drawn as one slide. */
const LONG_SLIDE_LINES = 40;
const LONG_SLIDE_PIECE = 4;

/** How many lines each slide drawn from a written slide of `lines` lines
 *  holds: the theme's «lines per slide», or — when the theme sets none — 4 for
 *  a block longer than 40 (owner, 2026-11-06: «un bloque largo se parte solo
 *  en diapositivas, según "líneas por diapositiva" del tema, o de a 4 si el
 *  tema no lo fija»). 0 = the slide whole. */
function linesPerSlide(lines: number, maxLines: number): number {
  if (maxLines > 0) return maxLines;
  return lines > LONG_SLIDE_LINES ? LONG_SLIDE_PIECE : 0;
}

/** How many slides `splitSection` cuts a written slide of `lines` lines into. */
function pieces(lines: number, maxLines: number): number {
  const per = linesPerSlide(lines, maxLines);
  return per > 0 ? Math.max(1, Math.ceil(lines / per)) : 1;
}

/** The lines of the `index`-th written slide of `key`. */
const spanLines = (spans: readonly SlideSpan[], key: string, index: number) =>
  spans.find((span) => span.key === key && span.index === index)?.lines ?? 1;

function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split(/\r\n?|\n/).length - 1;
}

function lineStart(text: string, line: number): number {
  const breaks = /\r\n?|\n/g;
  let start = 0;
  for (let n = 0; n < line; n += 1) {
    const match = breaks.exec(text);
    if (!match) return text.length;
    start = match.index + match[0].length;
  }
  return start;
}

/**
 * Which of `slides` — the song as projected: the order expanded and split to
 * the theme's `maxLines` (`ResolvedSong.slides`) — the caret at `offset` of
 * `text` is on, 0-based. On a header or a blank line it is the slide that comes
 * next. A section the order sings more than once is `preferred` when that is
 * one of its passes, else its first. `null` when the caret's slide is not
 * projected (a section out of the order) or there are no lyrics.
 */
export function slideAtCaret(
  text: string,
  offset: number,
  locale: Locale,
  maxLines: number,
  slides: readonly SongDeckSlide[],
  preferred: number | null,
): number | null {
  const spans = slideSpans(text, locale);
  const line = lineAt(text, offset);
  const span =
    spans.find((s) => line >= s.line && line < s.line + s.lines) ?? spans.find((s) => s.line > line) ?? spans.at(-1);
  if (!span) return null;
  let split = 0;
  for (let index = 0; index < span.index; index += 1) split += pieces(spanLines(spans, span.key, index), maxLines);
  const inSpan = Math.min(Math.max(0, line - span.line), span.lines - 1);
  const per = linesPerSlide(span.lines, maxLines);
  if (per > 0) split += Math.floor(inSpan / per);
  const matches = slides.flatMap((slide, i) =>
    slide.sectionKey === span.key && slide.indexInSection === split ? [i] : [],
  );
  return preferred !== null && matches.includes(preferred) ? preferred : (matches[0] ?? null);
}

/** And back: where the caret goes for `slide` — the start of its first line,
 *  where its words are first written. `null` when the text has no such slide. */
export function caretAtSlide(text: string, locale: Locale, maxLines: number, slide: SongDeckSlide): number | null {
  const spans = slideSpans(text, locale);
  let rest = slide.indexInSection;
  for (let index = 0; ; index += 1) {
    const span = spans.find((s) => s.key === slide.sectionKey && s.index === index);
    if (!span) return null;
    const count = pieces(span.lines, maxLines);
    if (rest < count) return lineStart(text, span.line + rest * linesPerSlide(span.lines, maxLines));
    rest -= count;
  }
}

/** Whether `order` is one the lyrics' text says by itself — what `textOrder`
 *  stores: empty (the sections as written), or every section in the order it
 *  is written and at least one sung again. */
export function followsText(sections: readonly SongSection[], order: readonly string[]): boolean {
  if (order.length === 0) return true;
  const written = sections.map((section) => section.key);
  return order.length > written.length && JSON.stringify([...new Set(order)]) === JSON.stringify(written);
}

/** A lyric line as the editor writes it: after `ESCAPE` when the parser would
 *  read it as something else — a header, a blank line (a new slide), a line
 *  starting with `ESCAPE`, leading spaces it would trim. ponytail: spaces at
 *  the END of a line are still trimmed; no importer keeps any. */
function escapeLine(line: string, locale: Locale): string {
  const trimmed = line.trim();
  const misread =
    trimmed === "" ||
    trimmed.startsWith(ESCAPE) ||
    line !== line.trimStart() ||
    readHeader([trimmed], 0, locale, false) !== null;
  return misread ? `${ESCAPE}${line}` : line;
}

/**
 * Sections → the text the editor shows, headers in the interface's language.
 * `parseLyrics` reads it back to the very same sections (2026-11-06: opening a
 * song and saving it never changes it), by three rules:
 * - every header is bracketed and names a known section, so a bare word that
 *   starts a slide («Coro», an imported hymn's printed label) is lyrics;
 * - a lyric line the parser would misread is written after a `\` (`escapeLine`):
 *   «\[Repeat x2]», a lone «\[C]» in Spanish, «\» for an empty line;
 * - a header carries its number («[Coro 1]») whenever the bare name would read
 *   as another section, and always under an `order` of the operator's own, so
 *   a new «[Puente]» typed above keeps that order on its bridge (owner).
 * An `order` the text can say (`followsText`) is written into it — a section
 * sung again is its header once more with nothing under it — so it still
 * follows the lyrics once reopened.
 */
export function serializeLyrics(sections: readonly SongSection[], locale: Locale, order: readonly string[] = []): string {
  const follows = followsText(sections, order);
  const byKey = new Map(sections.map((section) => [section.key, section]));
  const written: SongSection[] = [];
  const slidesOf = (section: SongSection) => section.slides.map(writtenLines);
  return (follows && order.length > 0 ? order : sections.map((section) => section.key))
    .flatMap((key) => {
      const section = byKey.get(key);
      if (!section) return [];
      const again = written.includes(section);
      // What `SectionCollector.add` makes of the bare name here: the newest
      // section of its type when repeated, else a twin's key or a new one.
      const bare = again
        ? [...written].reverse().find((other) => other.type === section.type) === section
        : !written.some((other) => other.type === section.type && sameSlides(slidesOf(other), slidesOf(section)));
      if (!again) written.push(section);
      const header = `[${
        follows && bare
          ? sectionLabel(section.type, section.number, locale)
          : `${SECTION_NAMES[locale][section.type]} ${section.number}`
      }]`;
      const body = section.slides
        .map((slide) => writtenLines(slide).map((line) => escapeLine(line, locale)).join("\n"))
        .join("\n\n");
      return [again || !body ? header : `${header}\n${body}`];
    })
    .join("\n\n");
}

/* ---------------------------------------------------------------------------
 * The second language (owner, 2026-11-05)
 * ------------------------------------------------------------------------ */

/**
 * The lyrics' sections with each slide's translation, from the editor's
 * «Traducción» text, written the same way: paired by section key and slide
 * index. A translated section or slide the lyrics lack is dropped; a slide
 * with no counterpart, or one of empty lines only («\»), carries none. A
 * translation's empty lines stay: they mirror the lyrics' own (a file's
 * `<br/><br/>`), so a translation line by line keeps its count and
 * `splitSection` cuts it where the lyrics are.
 */
export function withTranslation(sections: readonly SongSection[], translated: readonly SongSection[]): SongSection[] {
  const byKey = new Map(translated.map((section) => [section.key, section]));
  return sections.map((section) => ({
    ...section,
    slides: section.slides.map((slide, index) => {
      const lines = byKey.get(section.key)?.slides[index]?.lines;
      const own: SongSlide = slide.chords ? { lines: slide.lines, chords: slide.chords } : { lines: slide.lines };
      return lines?.some((line) => line.trim()) ? { ...own, translation: [...lines] } : own;
    }),
  }));
}

/**
 * `copy`'s translation laid onto `sections` LINE BY LINE, for the same lines in
 * the same sequence however each cuts them into sections and slides (an
 * import's repeat, `songIdentity`). Paired by key and slide instead, a verse
 * the file holds as one slide kept only its first slide's translation, and one
 * the file names otherwise lost it all (review 2026-11-06). A translation that
 * is not line for line is spread over its slide's lines, front first, so a
 * slide holding them all gets it whole and in order.
 */
export function translationByLine(sections: readonly SongSection[], copy: readonly SongSection[]): SongSection[] {
  const pieces = copy.flatMap((section) =>
    section.slides.flatMap(({ lines, translation = [] }) => {
      const at = (i: number) => Math.ceil((i * translation.length) / lines.length);
      return lines.map((_, i) => translation.slice(at(i), at(i + 1)));
    }),
  );
  let line = 0;
  return sections.map((section) => ({
    ...section,
    slides: section.slides.map((slide) => {
      const translation = slide.lines.flatMap(() => pieces[line++] ?? []);
      return translation.some((text) => text.trim()) ? { ...slide, translation } : slide;
    }),
  }));
}

/**
 * The «Traducción» text as sections to pair with the lyrics' (`withTranslation`).
 * Written with headers, by them; pasted without any (owner, 2026-11-06), block
 * by block in order: its n-th block translates the n-th slide with words the
 * lyrics write — a chorus written out twice takes two blocks, a slide of chords
 * only takes none.
 */
export function translationFor(lyrics: string, translation: string, locale: Locale): SongSection[] {
  const { blocks, headed } = writtenBlocks(translation, locale);
  if (headed) return collect(blocks).collector.result().sections;
  const runs = blocks.flatMap((block) => block.slides);
  const byKey = new Map<string, SongSlide[]>();
  slideSpans(lyrics, locale)
    .filter((span) => span.words)
    .forEach((span, i) => {
      const run = runs[i];
      if (!run) return;
      const slides = byKey.get(span.key) ?? [];
      slides[span.index] ??= slideFromWritten(run.lines); // a chorus written twice keeps its first
      byKey.set(span.key, slides);
    });
  return [...byKey].flatMap(([key, slides]) => {
    const parsed = parseSectionKey(key);
    // A slide left without a block is an empty line: written back, «\».
    return parsed ? [{ key, ...parsed, slides: Array.from(slides, (slide) => slide ?? { lines: [""] }) }] : [];
  });
}

/** The translation as the editor's text holds it: the sections whose slides
 *  have one, up to their last translated slide — an untranslated one before it
 *  written as an empty line («\»), so the next ones pair with their own slides
 *  again once read back. */
export function translationSections(sections: readonly SongSection[]): SongSection[] {
  return sections.flatMap((section) => {
    const last = section.slides.map((slide) => slide.translation !== undefined).lastIndexOf(true);
    if (last < 0) return [];
    return [{ ...section, slides: section.slides.slice(0, last + 1).map((slide) => ({ lines: slide.translation ?? [""] })) }];
  });
}

/** Whether any slide of the song has a translation — the LIVE row's selector. */
export function hasTranslation(sections: readonly SongSection[]): boolean {
  return sections.some((section) => section.slides.some((slide) => slide.translation !== undefined));
}

/** The sections in `language`: «translation» puts each slide's translation in
 *  its lines (the original where it has none), «original» drops them, «both»
 *  keeps them, to be drawn stacked. */
export function sectionsIn(sections: readonly SongSection[], language: SongLanguage): SongSection[] {
  if (language === "both") return [...sections];
  return sections.map((section) => ({
    ...section,
    // The chords go with the original's words, never over a translation.
    slides: section.slides.map(
      (slide): SongSlide =>
        language === "translation" && slide.translation
          ? { lines: slide.translation }
          : slide.chords
            ? { lines: slide.lines, chords: slide.chords }
            : { lines: slide.lines },
    ),
  }));
}

/** What an order that follows the text stores: nothing when it is the
 *  sections as written, the text's sequence when the text repeats one. */
export function textOrder(parsed: ParsedLyrics): string[] {
  const written = parsed.sections.map((section) => section.key);
  return JSON.stringify(written) === JSON.stringify(parsed.sequence) ? [] : parsed.sequence;
}

/** Every line of the song, for the search index. */
export function songLyricsText(sections: readonly SongSection[]): string {
  return sections.flatMap((section) => section.slides.flatMap((slide) => slide.lines)).join("\n");
}

/* ---------------------------------------------------------------------------
 * The order
 * ------------------------------------------------------------------------ */

/** The order as the editor's text line shows it: «E1 C E2 C P C». */
export function formatOrder(keys: readonly string[], locale: Locale): string {
  return keys
    .map((key) => {
      const parsed = parseSectionKey(key);
      return parsed ? sectionShort(parsed.type, parsed.number, locale) : key;
    })
    .join(" ");
}

const ORDER_TOKEN = /^(\p{L}[\p{L}-]*?)(\d{1,2})?$/u;

/** The order line read back. `invalid` holds every token that names no
 *  section type, so the editor can say which. */
export function parseOrder(text: string, locale: Locale): { keys: string[]; invalid: string[] } {
  const keys: string[] = [];
  const invalid: string[] = [];
  for (const token of text.split(/[\s,;·]+/).filter(Boolean)) {
    const match = ORDER_TOKEN.exec(token);
    const type = match ? resolveSectionWord(match[1]!, lookupOrder(locale), true) : null;
    const number = match?.[2] ? Number(match[2]) : 1;
    if (type && number >= 1) keys.push(sectionKey(type, number));
    else invalid.push(token);
  }
  return { keys, invalid };
}

/** The keys of `order` no section answers to — skipped on screen, and said
 *  in the editor. */
export function missingOrderKeys(sections: readonly SongSection[], order: readonly string[]): string[] {
  const known = new Set(sections.map((section) => section.key));
  return [...new Set(order.filter((key) => !known.has(key)))];
}

/** A section with every slide longer than `linesPerSlide` allows split into
 *  slides of at most that many lines (the theme's `maxLines`; 0 = as written,
 *  but a long pasted block 4 by 4) — done when drawn, never when saved, so
 *  changing the theme changes nothing stored. */
export function splitSection(section: SongSection, maxLines: number): SongSection {
  const fits = (slide: SongSlide) => pieces(slide.lines.length, maxLines) === 1;
  if (section.slides.every(fits)) return section;
  const slides = section.slides.flatMap((slide) => {
    if (fits(slide)) return [slide];
    const lineCount = linesPerSlide(slide.lines.length, maxLines);
    const count = Math.ceil(slide.lines.length / lineCount);
    // A translation line by line is cut where the lyrics are; any other into
    // as many pieces, evenly, so each piece stays under the lines it translates.
    const per = !slide.translation
      ? 0
      : slide.translation.length === slide.lines.length
        ? lineCount
        : Math.ceil(slide.translation.length / count);
    return Array.from({ length: count }, (_, i): SongSlide => {
      const lines = slide.lines.slice(i * lineCount, (i + 1) * lineCount);
      const translation = slide.translation?.slice(i * per, (i + 1) * per);
      const chords = slide.chords?.slice(i * lineCount, (i + 1) * lineCount);
      return {
        lines,
        ...(translation && translation.length > 0 ? { translation } : {}),
        ...(chords ? { chords } : {}),
      };
    });
  });
  return { ...section, slides };
}

/** The slides of the song as projected: the order (or the sections as
 *  written, when it is empty — or names only sections that are gone, owner
 *  2026-11-06: a song never goes live as nothing) expanded, each slide knowing
 *  where it came from. */
export function songDeckSlides(sections: readonly SongSection[], order: readonly string[]): SongDeckSlide[] {
  const byKey = new Map(sections.map((section) => [section.key, section]));
  const keys = order.length > 0 ? order : sections.map((section) => section.key);
  const slides: SongDeckSlide[] = [];
  keys.forEach((key, pass) => {
    const section = byKey.get(key);
    if (!section) return;
    section.slides.forEach((slide, indexInSection) => {
      slides.push({
        lines: slide.lines,
        ...(slide.translation ? { translation: slide.translation } : {}),
        ...(slide.chords ? { chords: slide.chords } : {}),
        sectionKey: section.key,
        type: section.type,
        number: section.number,
        pass,
        indexInSection,
      });
    });
  });
  return slides.length === 0 && order.length > 0 ? songDeckSlides(sections, []) : slides;
}
