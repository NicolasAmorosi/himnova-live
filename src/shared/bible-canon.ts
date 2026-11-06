import type { BibleBookDTO } from "./types/bible";

/** The app's own book abbreviations in canonical order — `rv1909.json`'s, and
 *  every format's importer writes them (`main/db/seed/bible-formats/canon.ts`,
 *  which a test keeps this in step with). English-style, so they are not what
 *  anybody types: they only tell which book a row is. */
export const CANON_ABBREVS: readonly string[] =
  "gn ex lv nm dt js jud rt 1sm 2sm 1kgs 2kgs 1ch 2ch ezr ne et job ps prv ec so is jr lm ez dn ho jl am ob jn mi na hk zp hg zc ml mt mk lk jo act rm 1co 2co gl eph ph cl 1ts 2ts 1tm 2tm tt phm hb jm 1pe 2pe 1jo 2jo 3jo jd re".split(
    " ",
  );

/**
 * Which of the 66 books (0-based) a version's row is. A whole canon is in
 * canonical order whatever its file named the books (the importers sort it);
 * a partial one is known by the app's own abbreviation, which every format but
 * a JSON with its own spelling writes. `null`: no telling.
 */
export function canonIndex(book: Pick<BibleBookDTO, "abbrev" | "position">, bookCount: number): number | null {
  if (bookCount === CANON_ABBREVS.length) return book.position - 1;
  const index = CANON_ABBREVS.indexOf(book.abbrev.toLowerCase());
  return index >= 0 ? index : null;
}

/** Whether two versions' rows are the same book — how switching the version
 *  keeps the passage. */
export function sameBook(a: BibleBookDTO, aCount: number, b: BibleBookDTO, bCount: number): boolean {
  const index = canonIndex(a, aCount);
  return index !== null ? index === canonIndex(b, bCount) : a.abbrev === b.abbrev;
}
