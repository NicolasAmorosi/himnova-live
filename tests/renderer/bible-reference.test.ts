/**
 * The Bible tab's «Referencia» finder (owner, 2026-11-06): the abbreviations
 * an operator types in the interface's language find the book they mean,
 * first — whatever the version calls its books —, and a whole reference
 * («Juan 3:16-18», «Jn 3.16») carries its chapter and verses.
 */
import { expect, test } from "vitest";
import { matchReference, parseReference } from "@renderer/lib/bible-reference";
import { CANON_ABBREVS, sameBook } from "@shared/bible-canon";
import type { BibleBookDTO } from "@shared/types/bible";

const RV1909_NAMES =
  "Génesis|Éxodo|Levítico|Números|Deuteronomio|Josué|Jueces|Rut|1 Samuel|2 Samuel|1 Reyes|2 Reyes|1 Crónicas|2 Crónicas|Esdras|Nehemías|Ester|Job|Salmos|Proverbios|Eclesiastés|Cantares|Isaías|Jeremías|Lamentaciones|Ezequiel|Daniel|Oseas|Joel|Amós|Abdías|Jonás|Miqueas|Nahúm|Habacuc|Sofonías|Hageo|Zacarías|Malaquías|Mateo|Marcos|Lucas|Juan|Hechos|Romanos|1 Corintios|2 Corintios|Gálatas|Efesios|Filipenses|Colosenses|1 Tesalonicenses|2 Tesalonicenses|1 Timoteo|2 Timoteo|Tito|Filemón|Hebreos|Santiago|1 Pedro|2 Pedro|1 Juan|2 Juan|3 Juan|Judas|Apocalipsis".split(
    "|",
  );

/** RV1909 as installed: canon order, its English-style abbrevs, Spanish names. */
const rv1909: BibleBookDTO[] = RV1909_NAMES.map((name, i) => ({
  id: i + 1,
  versionId: 1,
  position: i + 1,
  abbrev: CANON_ABBREVS[i]!,
  name,
  testament: i < 39 ? "OT" : "NT",
  chapterCount: i === 18 ? 150 : 66,
}));
const first = (query: string, books = rv1909, locale: "es" | "en" | "it" | "pt" = "es") => {
  const [match] = matchReference(books, query, locale);
  return match ? `${match.book.name} ${match.chapter ?? ""}`.trim() : null;
};

test("a Spanish abbreviation puts its book first, not the first book that contains the letters", () => {
  const cases: [string, string][] = [
    ["Ro 8", "Romanos 8"],
    ["Is 40", "Isaías 40"],
    ["Os 1", "Oseas 1"],
    ["Am 1", "Amós 1"],
    ["Ec 3", "Eclesiastés 3"],
    ["He 11", "Hebreos 11"],
    ["Jn 3", "Juan 3"],
    ["Lc 15", "Lucas 15"],
    ["Mr 1", "Marcos 1"],
    ["Mc 1", "Marcos 1"],
    ["Hch 2", "Hechos 2"],
    ["1 Co 13", "1 Corintios 13"],
    ["1co13", "1 Corintios 13"],
    ["Ap 21", "Apocalipsis 21"],
    ["Sal 23", "Salmos 23"],
    ["Jud 1", "Judas 1"],
    ["genesis 1", "Génesis 1"],
    ["juan", "Juan"],
    ["fil 2", "Filipenses 2"],
  ];
  expect(cases.map(([typed]) => first(typed))).toEqual(cases.map(([, want]) => want));
});

test("the rest still match after the best one, and the start of a name before the middle of one", () => {
  const names = matchReference(rv1909, "he", "es").map((m) => m.book.name);
  expect(names.slice(0, 2)).toEqual(["Hebreos", "Hechos"]);
  expect(matchReference(rv1909, "Juan", "es").map((m) => m.book.name)).toEqual(["Juan", "1 Juan", "2 Juan", "3 Juan"]);
});

test("each interface language has its own abbreviations, over the same version", () => {
  expect(first("Jn 3", rv1909, "en")).toBe("Juan 3");
  expect(first("Mk 1", rv1909, "en")).toBe("Marcos 1");
  expect(first("Gv 3", rv1909, "it")).toBe("Juan 3");
  expect(first("Gb 1", rv1909, "it")).toBe("Job 1");
  // «Jo» is João and «Jó» is Job, accent-blind or not.
  expect(first("Jo 3", rv1909, "pt")).toBe("Juan 3");
  expect(first("Jó 1", rv1909, "pt")).toBe("Job 1");
});

test("an imported version's own book names, in any language, are found by canonical position", () => {
  const english: Record<number, string> = { 42: "John", 44: "Romans" };
  const kjv = rv1909.map((book, i) => ({ ...book, abbrev: `x${i}`, name: english[i] ?? book.name }));
  expect(first("Jn 3", kjv)).toBe("John 3");
  expect(first("Ro 8", kjv)).toBe("Romans 8");
  // A partial one by the app's own abbreviation.
  const john = [{ ...rv1909[42]!, position: 1 }];
  expect(first("Jn 3", john)).toBe("Juan 3");
});

test("a chapter the book does not have is no result", () => {
  expect(matchReference(rv1909, "Ro 67", "es")).toEqual([]);
  expect(first("Sal 150")).toBe("Salmos 150");
});

test("a whole reference: chapter and verses, with any separator, half typed too", () => {
  expect(parseReference("Juan 3:16")).toEqual({ name: "Juan", chapter: 3, verseFrom: 16, verseTo: null });
  expect(parseReference("Juan 3:16-18")).toEqual({ name: "Juan", chapter: 3, verseFrom: 16, verseTo: 18 });
  expect(parseReference("Jn 3.16")).toMatchObject({ name: "Jn", chapter: 3, verseFrom: 16 });
  expect(parseReference("Jn 3,16")).toMatchObject({ name: "Jn", chapter: 3, verseFrom: 16 });
  expect(parseReference("1 Juan 3")).toEqual({ name: "1 Juan", chapter: 3, verseFrom: null, verseTo: null });
  expect(parseReference("1 Juan")).toEqual({ name: "1 Juan", chapter: null, verseFrom: null, verseTo: null });
  expect(parseReference("Juan 3:")).toMatchObject({ name: "Juan", chapter: 3, verseFrom: null });
  expect(parseReference("Juan 3:18-16")).toMatchObject({ verseFrom: 18, verseTo: null });
  expect(matchReference(rv1909, "Jn 3:16-18", "es")[0]).toMatchObject({ book: { name: "Juan" }, chapter: 3, verseFrom: 16, verseTo: 18 });
  // A space is a separator too (owner, 2026-11-10): typed fast, «Juan 3 16» was book «Juan 3», chapter 16 — nothing.
  expect(parseReference("Juan 3 16")).toEqual({ name: "Juan", chapter: 3, verseFrom: 16, verseTo: null });
  expect(parseReference("1 Juan 3 2")).toEqual({ name: "1 Juan", chapter: 3, verseFrom: 2, verseTo: null });
  expect(parseReference("Sal 119 105-112")).toEqual({ name: "Sal", chapter: 119, verseFrom: 105, verseTo: 112 });
});

test("a number alone is a verse of the open chapter, and without one it is still a book's start", () => {
  const juan = rv1909[42]!;
  expect(matchReference(rv1909, "16", "es", { book: juan, chapter: 3 })).toEqual([
    { name: "", book: juan, chapter: 3, verseFrom: 16, verseTo: null },
  ]);
  expect(matchReference(rv1909, "1 Co 13", "es", { book: juan, chapter: 3 })[0]).toMatchObject({ book: { name: "1 Corintios" } });
  expect(matchReference(rv1909, "0", "es", { book: juan, chapter: 3 })).not.toContainEqual(expect.objectContaining({ verseFrom: 0 }));
  expect(matchReference(rv1909, "2", "es")[0]).toMatchObject({ book: { name: "2 Samuel" } });
});

test("the same book across versions: by canonical position, or by abbreviation in a partial one", () => {
  const juan = rv1909[42]!;
  const partial = { ...juan, id: 500, versionId: 2, position: 1, name: "John" };
  expect(sameBook(partial, 1, juan, 66)).toBe(true);
  expect(sameBook(rv1909[31]!, 66, juan, 66)).toBe(false);
});
