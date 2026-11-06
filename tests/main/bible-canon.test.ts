/**
 * The renderer knows which book a version's row is by the app's own
 * abbreviations (`shared/bible-canon.ts`), the ones every importer writes
 * (`canon.ts`): the two lists are one, in the same order.
 */
import { expect, test } from "vitest";
import { CANON } from "../../src/main/db/seed/bible-formats/canon";
import { CANON_ABBREVS, canonIndex } from "@shared/bible-canon";

test("the shared abbreviations are the importers' canon, in canonical order", () => {
  expect(CANON_ABBREVS).toEqual(CANON.map((book) => book.abbrev));
  for (const book of CANON) expect(canonIndex({ abbrev: book.abbrev, position: 1 }, 1)).toBe(book.index - 1);
});
