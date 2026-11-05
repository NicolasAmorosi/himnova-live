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
  type SongSection,
  type SongSectionType,
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

  add(header: Header, rawSlides: string[][]): void {
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
  }

  result(): ParsedLyrics {
    return { sections: this.sections, sequence: this.sequence.filter((key) => this.byKey.has(key)) };
  }
}

/** Blocks of non-blank lines. */
function blocks(lines: readonly string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line === "") {
      if (current.length > 0) out.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** Text without a single header: each block is a section of its own, and a
 *  block that comes back word for word is the chorus (FreeShow's guess, the
 *  minimum; the operator corrects it). */
function parseWithoutHeaders(lines: readonly string[]): ParsedLyrics {
  const all = blocks(lines);
  const counts = new Map<string, number>();
  for (const block of all) counts.set(block.join("\n"), (counts.get(block.join("\n")) ?? 0) + 1);
  const collector = new SectionCollector();
  for (const block of all) {
    const repeated = (counts.get(block.join("\n")) ?? 0) > 1;
    collector.add({ type: repeated ? "chorus" : "verse", number: null }, [block]);
  }
  return collector.result();
}

function parseWithHeaders(lines: readonly string[], locale: Locale): ParsedLyrics {
  const collector = new SectionCollector();
  // Lines above the first header are a verse, so nothing typed is dropped.
  let header: Header | null = null;
  let slides: string[][] = [];
  let slide: string[] = [];
  const flush = () => {
    if (slide.length > 0) slides.push(slide);
    if (header !== null || slides.length > 0) collector.add(header ?? { type: "verse", number: null }, slides);
    slides = [];
    slide = [];
  };
  lines.forEach((line, index) => {
    const next = readHeader(lines, index, locale);
    if (next) {
      flush();
      header = next;
    } else if (line === "") {
      if (slide.length > 0) slides.push(slide);
      slide = [];
    } else {
      slide.push(line);
    }
  });
  flush();
  return collector.result();
}

export function parseLyrics(text: string, locale: Locale): ParsedLyrics {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim());
  const headed = lines.some((_, index) => readHeader(lines, index, locale) !== null);
  return headed ? parseWithHeaders(lines, locale) : parseWithoutHeaders(lines);
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
    const chunks: { lines: string[] }[] = [];
    for (let i = 0; i < slide.lines.length; i += maxLines) chunks.push({ lines: slide.lines.slice(i, i + maxLines) });
    return chunks;
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
