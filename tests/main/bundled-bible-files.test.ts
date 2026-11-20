/**
 * Every Bible file inside the installer (`main/db/seed/bundled-bibles.ts`), read by the app's own parser. Apart from
 * the seed rules (`bundled-bibles.test.ts`) so the two run on two workers: together they were the suite's longest file
 * (2026-11-15 audit, R34).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { BUNDLED_BIBLES } from "../../src/main/db/seed/bundled-bibles";
import { parseBibleFile, type ParsedBible } from "../../src/main/db/seed/bible-formats";
import { BUILTIN_BIBLE_CODE } from "../../src/shared/constants";

const biblesDir = path.join(process.cwd(), "resources/bibles");

/** Each file parsed once: three tests read the same files. */
const parsedFiles = new Map<string, ParsedBible>();
function parse(file: string): ParsedBible {
  let parsed = parsedFiles.get(file);
  if (!parsed) parsedFiles.set(file, (parsed = parseBibleFile(path.join(biblesDir, file))));
  return parsed;
}
function verse(bible: ParsedBible, book: number, chapter: number, number: number): string | undefined {
  return bible.books[book - 1]?.verses.find((v) => v.chapter === chapter && v.verse === number)?.text;
}

/** Each text's own Genesis 1:1 and John 3:16, and how many verses it numbers (the KJV versification has 31 102;
 *  the ASV and the VBL leave out 16 and the WEB 4, the Diodati follows the Italian one, the Almeida joins 2 Corinthians
 *  13:14 to 13:13). */
const EXPECTED: Record<string, { verses: number; genesis: string; john: string }> = {
  [BUILTIN_BIBLE_CODE]: {
    verses: 31102,
    genesis: "EN el principio crió Dios los cielos y la tierra.",
    john: "Porque de tal manera amó Dios al mundo, que ha dado á su Hijo unigénito, para que todo aquel que en él cree, no se pierda, mas tenga vida eterna.",
  },
  vbl: {
    verses: 31086,
    genesis: "En el principio, Dios creó los cielos y la tierra.",
    john: "“Porque Dios amó al mundo, y lo hizo de esta manera: entregó a su único Hijo, a fin de que todos los que crean en él no mueran, sino que tengan vida eterna.",
  },
  kjv: {
    verses: 31102,
    genesis: "In the beginning God created the heaven and the earth.",
    john: "For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.",
  },
  asv: {
    verses: 31086,
    genesis: "In the beginning God created the heavens and the earth.",
    john: "For God so loved the world, that he gave his only begotten Son, that whosoever believeth on him should not perish, but have eternal life.",
  },
  web: {
    verses: 31098,
    genesis: "In the beginning, God created the heavens and the earth.",
    john: "For God so loved the world, that he gave his only born Son, that whoever believes in him should not perish, but have eternal life.",
  },
  riveduta1927: {
    verses: 31102,
    genesis: "Nel principio Iddio creò i cieli e la terra.",
    john: "Poiché Iddio ha tanto amato il mondo, che ha dato il suo unigenito Figliuolo, affinché chiunque crede in lui non perisca, ma abbia vita eterna.",
  },
  diodati1885: {
    verses: 31095,
    genesis: "NEL principio Iddio creò il cielo e la terra.",
    john: "Perciocchè Iddio ha tanto amato il mondo, ch'egli ha dato il suo unigenito Figliuolo, acciocchè chiunque crede in lui non perisca, ma abbia vita eterna.",
  },
  almeida1911: {
    verses: 31101,
    genesis: "No principio creou Deus os céus e a terra.",
    john: "Porque Deus amou o mundo de tal maneira, que deu o seu Filho unigenito, para que todo aquelle que n'elle crê não pereça, mas tenha a vida eterna.",
  },
  biblialivre: {
    verses: 31102,
    genesis: "No princípio criou Deus os céus e a terra.",
    john: "Porque Deus amou ao mundo de tal maneira, que deu o seu Filho unigênito; para que todo aquele que nele crê não pereça, mas tenha a vida eterna.",
  },
};

describe("every bundled file, read by the app's own parser", () => {
  test("the catalog and the folder agree, and codes are unique", () => {
    expect(BUNDLED_BIBLES.map((bible) => bible.code).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(new Set(BUNDLED_BIBLES.map((bible) => bible.code)).size).toBe(BUNDLED_BIBLES.length);
    for (const bible of BUNDLED_BIBLES) expect(fs.existsSync(path.join(biblesDir, bible.file)), bible.file).toBe(true);
    expect(BUNDLED_BIBLES[0]?.code).toBe(BUILTIN_BIBLE_CODE);
  });

  test.each(BUNDLED_BIBLES.map((bible) => [bible.code, bible] as const))("%s", (code, bible) => {
    const parsed = parse(bible.file);
    const expected = EXPECTED[code]!;
    expect(parsed.books).toHaveLength(66);
    expect(parsed.books.filter((book) => book.testament === "OT")).toHaveLength(39);
    expect(parsed.books.reduce((sum, book) => sum + book.verses.length, 0)).toBe(expected.verses);
    expect(verse(parsed, 1, 1, 1)).toBe(expected.genesis);
    expect(verse(parsed, 43, 3, 16)).toBe(expected.john);
    // Its own name and language, or the catalog's when the file says neither (the RV1909's JSON).
    expect(parsed.name ?? bible.name).toBe(bible.name);
    expect(parsed.language ?? "es").toBe(bible.language);
    for (const book of parsed.books) {
      expect(book.name.trim().length, `${code} book ${book.abbrev}`).toBeGreaterThan(0);
      for (const v of book.verses) {
        // Nothing but the words: no markup, Strong's numbers, paragraph marks or OCR asterisks.
        expect(v.text, `${code} ${book.name} ${v.chapter}:${v.verse}`).not.toMatch(/[<>{}*¶\\]|\b[HG]\d{3,5}\b/);
      }
    }
  });

  test("a verse the ASV leaves out is absent, and the next one keeps its own number", () => {
    const asv = parse("asv.xml");
    expect(verse(asv, 40, 17, 21)).toBeUndefined();
    expect(verse(asv, 40, 17, 22)).toMatch(/^And while they abode in Galilee/);
    expect(verse(asv, 43, 5, 4)).toBeUndefined();
    expect(verse(asv, 43, 5, 5)).toMatch(/^And a certain man was there/);
    expect(verse(asv, 45, 16, 24)).toBeUndefined();
    expect(verse(asv, 45, 16, 25)).toMatch(/^Now to him that is able to establish you/);
  });

  test("book names are the text's own", () => {
    const names = (file: string) => parse(file).books.map((book) => book.name);
    expect(names("kjv.xml")[42]).toBe("John");
    expect(names("vbl.xml")[42]).toBe("Juan");
    expect(names("riveduta1927.xml")[43]).toBe("Atti");
    expect(names("diodati1885.xml")[45]).toBe("1 Corinti");
    expect(names("almeida1911.xml")[0]).toBe("Génesis");
    expect(names("biblialivre.xml")[0]).toBe("Gênesis");
  });
});
