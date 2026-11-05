/**
 * A song's lyrics as the operator writes them, and back.
 *
 * ```
 * [Estrofa 1]
 * first line
 * second line
 *
 * third line        ← a blank line = another slide of the same section
 *
 * [Coro]
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

/** Which section a word names, or `null`. `shorts` also accepts the one- and
 *  two-letter forms, which only a bracketed header or the order line may use:
 *  a lyric line «E» on its own is not a section. */
function resolveSectionWord(word: string, locale: Locale, shorts: boolean): SongSectionType | null {
  const normalized = normalizeWord(word);
  if (!normalized) return null;
  for (const candidate of lookupOrder(locale)) {
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

type Header = { type: SongSectionType; number: number | null };

const BRACKETED = /^\[(.*)\]$/;
const LABEL = /^(.*?)\s*(\d{1,2})?\s*:?$/u;

/** A header line, or `null`. Bracketed anywhere; bare («Coro», «Verse 2:»)
 *  only as the first line of a block and only as a full word. */
function readHeader(lines: readonly string[], index: number, locale: Locale): Header | null {
  const line = lines[index]!;
  const bracketed = BRACKETED.exec(line);
  const blockStart = index === 0 || lines[index - 1] === "";
  if (!bracketed && !blockStart) return null;
  const inner = (bracketed ? bracketed[1]! : line).trim();
  const label = LABEL.exec(inner);
  const word = label?.[1] ?? "";
  const number = label?.[2] ? Number(label[2]) : null;
  if (!bracketed && (normalizeWord(word).length < 3 || !line)) return null;
  const type = resolveSectionWord(word, locale, bracketed !== null);
  // An unknown bracketed name is still a header — of a section of its own.
  if (!type) return bracketed ? { type: "other", number: number && number >= 1 ? number : null } : null;
  return { type, number: number !== null && number >= 1 && number <= SONG_SECTION_NUMBER_MAX ? number : null };
}

/** Whether a line on its own names a section («Verse 1», «Coro:») and not
 *  something else («Capo 2»): what an importer asks of a note that may be either. */
export function isSectionLabel(line: string, locale: Locale): boolean {
  return readHeader([line.trim()], 0, locale) !== null;
}

const sameSlides = (a: readonly string[][], b: readonly string[][]) => JSON.stringify(a) === JSON.stringify(b);

class SectionCollector {
  readonly sections: SongSection[] = [];
  readonly sequence: string[] = [];
  private readonly byKey = new Map<string, SongSection>();

  private nextFree(type: SongSectionType): number {
    let number = 1;
    while (this.byKey.has(sectionKey(type, number)) && number < SONG_SECTION_NUMBER_MAX) number += 1;
    return number;
  }

  /** The newest section of `type`, which a bare repeated header («[Coro]»
   *  with nothing under it) means. */
  private latest(type: SongSectionType): SongSection | undefined {
    return [...this.sections].reverse().find((section) => section.type === type);
  }

  private define(type: SongSectionType, number: number, slides: string[][]): string {
    const key = sectionKey(type, number);
    const section: SongSection = { key, type, number, slides: slides.map((lines) => ({ lines })) };
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
        (section) => section.type === type && sameSlides(section.slides.map((s) => s.lines), slides),
      );
      if (slides.length === 0) key = this.latest(type)?.key ?? sectionKey(type, this.nextFree(type));
      else if (twin) key = twin.key;
      else key = this.define(type, this.nextFree(type), slides);
    } else {
      const existing = this.byKey.get(sectionKey(type, header.number));
      if (!existing) {
        key = sectionKey(type, header.number);
        if (slides.length > 0) this.define(type, header.number, slides);
      } else if (slides.length === 0 || sameSlides(existing.slides.map((s) => s.lines), slides)) {
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

/** Runs of non-blank lines. */
function slideRuns(lines: readonly string[]): WrittenSlide[] {
  const out: WrittenSlide[] = [];
  let current: WrittenSlide | null = null;
  lines.forEach((line, index) => {
    if (line === "") current = null;
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
    header: { type: (counts.get(run.lines.join("\n")) ?? 0) > 1 ? "chorus" : "verse", number: null },
    slides: [run],
  }));
}

function blocksWithHeaders(lines: readonly string[], locale: Locale): WrittenBlock[] {
  const out: WrittenBlock[] = [];
  // Lines above the first header are a verse, so nothing typed is dropped.
  let header: Header | null = null;
  let body: string[] = [];
  let bodyStart = 0;
  const flush = () => {
    const slides = slideRuns(body).map((run) => ({ ...run, line: run.line + bodyStart }));
    if (header !== null || slides.length > 0) out.push({ header: header ?? { type: "verse", number: null }, slides });
  };
  lines.forEach((line, index) => {
    const next = readHeader(lines, index, locale);
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

function writtenBlocks(text: string, locale: Locale): WrittenBlock[] {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim());
  const headed = lines.some((_, index) => readHeader(lines, index, locale) !== null);
  return headed ? blocksWithHeaders(lines, locale) : blocksWithoutHeaders(lines);
}

export function parseLyrics(text: string, locale: Locale): ParsedLyrics {
  const collector = new SectionCollector();
  for (const block of writtenBlocks(text, locale)) {
    collector.add(block.header, block.slides.map((slide) => slide.lines));
  }
  return collector.result();
}

/* ---------------------------------------------------------------------------
 * The caret and the slides (the song editor, owner 2026-11-04)
 * ------------------------------------------------------------------------ */

/** Every slide as written, in the text's order: the section `parseLyrics` files
 *  it under, its index there (before a theme splits it), and its lines. A
 *  chorus written twice is two entries of the same key. */
type SlideSpan = { key: string; index: number; line: number; lines: number };

function slideSpans(text: string, locale: Locale): SlideSpan[] {
  const collector = new SectionCollector();
  return writtenBlocks(text, locale).flatMap((block) => {
    const key = collector.add(block.header, block.slides.map((slide) => slide.lines));
    return block.slides.map((slide, index) => ({ key, index, line: slide.line, lines: slide.lines.length }));
  });
}

/** How many slides `splitSection` cuts a written slide of `lines` lines into. */
const pieces = (lines: number, maxLines: number) => (maxLines > 0 ? Math.max(1, Math.ceil(lines / maxLines)) : 1);

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
  if (maxLines > 0) split += Math.floor(inSpan / maxLines);
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
    if (rest < count) return lineStart(text, span.line + rest * maxLines);
    rest -= count;
  }
}

/** Sections → the text the editor shows: every section once, with its header
 *  in the interface's language. `parseLyrics` reads it back to the same
 *  sections. */
export function serializeLyrics(sections: readonly SongSection[], locale: Locale): string {
  return sections
    .map((section) => {
      const header = `[${sectionLabel(section.type, section.number, locale)}]`;
      const body = section.slides.map((slide) => slide.lines.join("\n")).join("\n\n");
      return body ? `${header}\n${body}` : header;
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
 * with no counterpart carries none.
 */
export function withTranslation(sections: readonly SongSection[], translated: readonly SongSection[]): SongSection[] {
  const byKey = new Map(translated.map((section) => [section.key, section]));
  return sections.map((section) => ({
    ...section,
    slides: section.slides.map((slide, index) => {
      const lines = byKey.get(section.key)?.slides[index]?.lines.filter((line) => line.trim().length > 0);
      return lines && lines.length > 0 ? { lines: slide.lines, translation: lines } : { lines: slide.lines };
    }),
  }));
}

/** The translation as the editor's text holds it: the sections whose slides
 *  have one, those slides only. ponytail: a section whose FIRST slide is the
 *  untranslated one re-pairs its translations one slide early once written
 *  back; a blank placeholder slide would fix it if it ever matters. */
export function translationSections(sections: readonly SongSection[]): SongSection[] {
  return sections.flatMap((section) => {
    const slides = section.slides.flatMap((slide) => (slide.translation ? [{ lines: slide.translation }] : []));
    return slides.length > 0 ? [{ ...section, slides }] : [];
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
    slides: section.slides.map((slide) => ({
      lines: language === "translation" && slide.translation ? slide.translation : slide.lines,
    })),
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
    const type = match ? resolveSectionWord(match[1]!, locale, true) : null;
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

/** A section with every slide of more than `maxLines` lines split into
 *  slides of at most that many (0 = as written) — done when drawn, never
 *  when saved, so changing the theme changes nothing stored. */
export function splitSection(section: SongSection, maxLines: number): SongSection {
  if (maxLines <= 0 || section.slides.every((slide) => slide.lines.length <= maxLines)) return section;
  const slides = section.slides.flatMap((slide) => {
    const count = Math.ceil(slide.lines.length / maxLines);
    // The translation is cut into as many pieces, evenly, so each piece stays
    // under the lines it translates.
    const per = slide.translation ? Math.ceil(slide.translation.length / count) : 0;
    return Array.from({ length: count }, (_, i): SongSlide => {
      const lines = slide.lines.slice(i * maxLines, (i + 1) * maxLines);
      const translation = slide.translation?.slice(i * per, (i + 1) * per);
      return translation && translation.length > 0 ? { lines, translation } : { lines };
    });
  });
  return { ...section, slides };
}

/** The slides of the song as projected: the order (or the sections as
 *  written, when it is empty) expanded, each slide knowing where it came from. */
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
        sectionKey: section.key,
        type: section.type,
        number: section.number,
        pass,
        indexInSection,
      });
    });
  });
  return slides;
}
