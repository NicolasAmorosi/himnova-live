import { testamentOf, type CanonBook } from "./canon";
import { fallbackBookName } from "./book-names";

export type ParsedVerse = { chapter: number; verse: number; text: string };

export type ParsedBook = {
  abbrev: string;
  name: string;
  testament: "OT" | "NT";
  chapterCount: number;
  verses: ParsedVerse[];
};

/**
 * A whole bible, as a parser hands it over.
 *
 * `name` and `language` are nullable because only some formats carry them:
 * Zefania has `<INFORMATION><title>`, MyBible has an `info`/`Details` table,
 * and a bare JSON has neither. The importer falls back to the FILE's name for
 * the first and to the app's default for the second, so a parser must say "I
 * do not know" rather than invent a plausible-looking answer that would then
 * be indistinguishable from a real one.
 */
export type ParsedBible = {
  name: string | null;
  language: string | null;
  books: ParsedBook[];
};

/**
 * A primitive as a string, anything else as "".
 *
 * `String(value)` on a shape we did not expect writes the literal
 * "[object Object]" into a verse and stores it happily — the exact trap
 * `parseBibleJson`'s own `asVerseText` was written for, reached here through
 * every `Record<string, unknown>` that a SQLite row or an XML attribute comes
 * back as. An unreadable value has to come out empty and be visible as empty.
 */
export function asPlainText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** Thrown when a file is not the format it was dispatched as, or is not any
 *  format at all. Caught at the importer's edge and turned into the one
 *  message the operator gets — a parser never decides what to tell them. */
export class BibleFormatError extends Error {}

/**
 * Accumulates `(book, chapter, verse, text)` from any format and produces the
 * book list the seed wants.
 *
 * Every format except the legacy JSON one is a flat stream of verses — a
 * Zefania `<VERS>`, a USFX milestone, a row of `verses` — and each of them
 * would otherwise grow its own version of the same four chores: dropping
 * empty verses, de-duplicating, counting chapters, and putting the books back
 * in canonical order. The de-duplication is not tidiness: `bible_verses` has
 * a UNIQUE index on `(version_id, book_id, chapter, verse)`, so a module with
 * a repeated verse (they exist — a module split across files and concatenated
 * by hand is how) would abort the whole import transaction on an INSERT.
 *
 * Order is canonical rather than file order, deliberately: a module that
 * happens to store Revelation first would otherwise show up in the browser's
 * book dropdown that way, and the operator would have no idea why.
 */
export class BookCollector {
  /** `index -> chapter -> verse -> text`. Nested Maps rather than a flat key
   *  so `chapterCount` is a `Math.max` over keys we already have instead of a
   *  second pass over every verse. */
  private readonly books = new Map<
    number,
    { book: CanonBook; name: string | null; chapters: Map<number, Map<number, string>> }
  >();

  /**
   * @param name The name this file gives the book, when it gives one. The
   *   file's own always wins: a module IS a translation. A book left unnamed
   *   gets the app's name for it in `finish`, once the file's language is known.
   */
  add(book: CanonBook, chapter: number, verse: number, text: string, name?: string | null): void {
    // A verse is one line: the line breaks and indentation an XML file wraps a
    // verse's text with (eBible's USFX, mid-verse after a `<w>` or `<nd>`) are
    // layout, and would break the projected line where the file did.
    const clean = text.replace(/[ \t\r\n]+/g, " ").trim();
    // An empty verse is not a verse. Formats routinely carry placeholder
    // elements for verses a translation does not render (a bracketed passage,
    // a chapter's trailing `<v>` milestone with nothing after it), and storing
    // them means a blank slide with a reference under it.
    if (clean.length === 0) return;
    if (!Number.isInteger(chapter) || chapter < 1 || !Number.isInteger(verse) || verse < 1) return;

    let entry = this.books.get(book.index);
    if (!entry) {
      entry = { book, name: name?.trim() || null, chapters: new Map() };
      this.books.set(book.index, entry);
    } else if (entry.name === null && name?.trim()) {
      // A file that names the book somewhere after its first verse (USFX's
      // `<h>` can follow the `<c>`) still gets to name it.
      entry.name = name.trim();
    }

    let chapterVerses = entry.chapters.get(chapter);
    if (!chapterVerses) {
      chapterVerses = new Map();
      entry.chapters.set(chapter, chapterVerses);
    }
    chapterVerses.set(verse, clean);
  }

  /** How many verses have been collected — the importer's own emptiness
   *  check, so "this parsed but found nothing" is a real error message rather
   *  than a version with zero verses in the list. */
  get verseCount(): number {
    let total = 0;
    for (const entry of this.books.values()) {
      for (const chapter of entry.chapters.values()) total += chapter.size;
    }
    return total;
  }

  /** @param language The file's own, normalized (`ParsedBible.language`): it
   *   picks the language of the names a book left unnamed falls back to. */
  finish(language: string | null): ParsedBook[] {
    return [...this.books.values()]
      .sort((a, b) => a.book.index - b.book.index)
      .map(({ book, chapters, name }) => {
        const verses: ParsedVerse[] = [];
        const numbers = [...chapters.keys()].sort((a, b) => a - b);
        for (const chapter of numbers) {
          const inChapter = chapters.get(chapter)!;
          for (const verse of [...inChapter.keys()].sort((a, b) => a - b)) {
            verses.push({ chapter, verse, text: inChapter.get(verse)! });
          }
        }
        return {
          abbrev: book.abbrev,
          name: name ?? fallbackBookName(book, language),
          testament: testamentOf(book.index),
          // The HIGHEST chapter number seen, not how many distinct ones there
          // were: a module missing a chapter in the middle must not renumber
          // everything after it, because `chapterCount` is what the browser's
          // chapter dropdown counts up to.
          chapterCount: numbers[numbers.length - 1] ?? 0,
          verses,
        };
      });
  }
}
