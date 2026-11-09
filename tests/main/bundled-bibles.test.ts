/**
 * The Bible versions inside the installer (`main/db/seed/bundled-bibles.ts`): every file read by the app's own
 * parser, and the seed rules a profile goes through — a new one gets its language's versions, an existing one
 * only re-seeds what it has, and a deleted version stays deleted until the operator installs it again.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase } from "../../src/main/db/client";
import { runMigrations } from "../../src/main/db/migrate";
import { bibleVersions } from "../../src/main/db/schema";
import { BibleRepo } from "../../src/main/db/repositories/bible.repo";
import { SettingsRepo } from "../../src/main/db/repositories/settings.repo";
import { installBundledBible, seedBuiltinBibles } from "../../src/main/db/seed/seed-bible";
import { BUNDLED_BIBLES, bundledBibleDTOs } from "../../src/main/db/seed/bundled-bibles";
import { parseBibleFile, type ParsedBible } from "../../src/main/db/seed/bible-formats";
import { BUILTIN_BIBLE_CODE } from "../../src/shared/constants";
import { isBibleLanguage } from "../../src/shared/types/bible";
import type { Locale } from "../../src/shared/types/settings";

const biblesDir = path.join(process.cwd(), "resources/bibles");
const drizzleDir = path.join(process.cwd(), "drizzle");

let tmpDir: string;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-bundled-bibles-"));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let dbCount = 0;
function freshProfile(locale: Locale) {
  const opened = openDatabase(path.join(tmpDir, `${dbCount++}.db`));
  runMigrations(opened.db, drizzleDir);
  const settings = new SettingsRepo(opened.db);
  settings.setMany({ "ui.locale": locale });
  return { ...opened, settings, repo: new BibleRepo(opened.db, opened.sqlite) };
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
    const parsed = parseBibleFile(path.join(biblesDir, bible.file));
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
    const asv = parseBibleFile(path.join(biblesDir, "asv.xml"));
    expect(verse(asv, 40, 17, 21)).toBeUndefined();
    expect(verse(asv, 40, 17, 22)).toMatch(/^And while they abode in Galilee/);
    expect(verse(asv, 43, 5, 4)).toBeUndefined();
    expect(verse(asv, 43, 5, 5)).toMatch(/^And a certain man was there/);
    expect(verse(asv, 45, 16, 24)).toBeUndefined();
    expect(verse(asv, 45, 16, 25)).toMatch(/^Now to him that is able to establish you/);
  });

  test("book names are the text's own", () => {
    const names = (file: string) => parseBibleFile(path.join(biblesDir, file)).books.map((book) => book.name);
    expect(names("kjv.xml")[42]).toBe("John");
    expect(names("vbl.xml")[42]).toBe("Juan");
    expect(names("riveduta1927.xml")[43]).toBe("Atti");
    expect(names("diodati1885.xml")[45]).toBe("1 Corinti");
    expect(names("almeida1911.xml")[0]).toBe("Génesis");
    expect(names("biblialivre.xml")[0]).toBe("Gênesis");
  });
});

describe("a new profile gets the versions of its language", () => {
  test.each([
    ["es", [BUILTIN_BIBLE_CODE, "vbl"]],
    ["en", ["kjv", "asv", "web"]],
    ["it", ["riveduta1927", "diodati1885"]],
    ["pt", ["almeida1911", "biblialivre"]],
  ] as const)("%s", (locale, codes) => {
    const profile = freshProfile(locale);
    seedBuiltinBibles(profile.db, profile.sqlite, biblesDir, profile.settings, true);
    const versions = profile.repo.listVersions();
    expect(versions.map((version) => version.code)).toEqual(codes);
    expect(versions.every((version) => version.isBuiltin && version.language === locale)).toBe(true);
    expect(profile.settings.get("bible.defaultVersionId")).toBe(versions[0]?.id);
    expect(profile.settings.get("bible.builtinSeeded")).toBe(true);
    // The next launch is an existing profile: nothing more arrives on its own.
    seedBuiltinBibles(profile.db, profile.sqlite, biblesDir, profile.settings, false);
    expect(profile.repo.listVersions().map((version) => version.code)).toEqual(codes);
    profile.sqlite.close();
  });
});

describe("an existing profile", () => {
  test("re-seeds an installed version whose file changed, keeping its name and place", () => {
    const profile = freshProfile("en");
    seedBuiltinBibles(profile.db, profile.sqlite, biblesDir, profile.settings, true);
    const [kjv, asv] = profile.repo.listVersions();
    profile.repo.renameVersion(asv!.id, "ASV");
    profile.repo.reorderVersions([asv!.id, kjv!.id, ...profile.repo.listVersions().slice(2).map((v) => v.id)]);
    // What a corrected `asv.xml` in a later build looks like from here.
    profile.db.update(bibleVersions).set({ sourceHash: "stale" }).where(eq(bibleVersions.id, asv!.id)).run();
    const versesBefore = profile.sqlite.prepare("SELECT MAX(id) AS id FROM bible_verses").get() as { id: number };

    seedBuiltinBibles(profile.db, profile.sqlite, biblesDir, profile.settings, false);

    const after = profile.repo.listVersions();
    expect(after.map((version) => version.code)).toEqual(["asv", "kjv", "web"]);
    expect(after[0]?.name).toBe("ASV");
    expect(after[0]?.verseCount).toBe(31086);
    const reinserted = profile.sqlite
      .prepare("SELECT MIN(v.id) AS id FROM bible_verses v JOIN bible_versions b ON b.id = v.version_id WHERE b.code = 'asv'")
      .get() as { id: number };
    expect(reinserted.id).toBeGreaterThan(versesBefore.id);
    profile.sqlite.close();
  });

  test("never installs a version on its own, but still offers the RV1909 to a database that never had it", () => {
    const profile = freshProfile("en");
    seedBuiltinBibles(profile.db, profile.sqlite, biblesDir, profile.settings, false);
    expect(profile.repo.listVersions().map((version) => version.code)).toEqual([BUILTIN_BIBLE_CODE]);
    expect(profile.settings.get("bible.builtinSeeded")).toBe(true);
    profile.sqlite.close();
  });
});

describe("installing from Settings", () => {
  test("install, delete and install again; the listing follows", () => {
    const profile = freshProfile("es");
    seedBuiltinBibles(profile.db, profile.sqlite, biblesDir, profile.settings, true);
    const installedId = (code: string) =>
      bundledBibleDTOs(profile.repo.listVersions()).find((bible) => bible.code === code)?.versionId ?? null;
    expect(installedId("kjv")).toBeNull();

    const id = installBundledBible(profile.db, profile.sqlite, biblesDir, "kjv");
    expect(installedId("kjv")).toBe(id);
    expect(profile.repo.getVersion(id)).toMatchObject({ name: "King James Version", language: "en", isBuiltin: true });
    // A second click while the first one was still running answers with the same version.
    expect(installBundledBible(profile.db, profile.sqlite, biblesDir, "kjv")).toBe(id);
    expect(profile.repo.listVersions().map((version) => version.code)).toEqual([BUILTIN_BIBLE_CODE, "vbl", "kjv"]);
    // The search index holds the new version's rows (indexed in bulk, with the insert trigger set aside and put
    // back), and still agrees with the table.
    expect(profile.repo.search(id, "begotten").length).toBeGreaterThan(0);
    expect(profile.repo.search(profile.repo.listVersions()[0]!.id, "espiritu").length).toBeGreaterThan(0);
    expect(() =>
      profile.sqlite.exec(`INSERT INTO bible_verses_fts(bible_verses_fts, rank) VALUES('integrity-check', 1)`),
    ).not.toThrow();
    expect(profile.sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'bible_verses_ai'`).get()).toBeTruthy();

    profile.repo.deleteVersion(id);
    seedBuiltinBibles(profile.db, profile.sqlite, biblesDir, profile.settings, false);
    expect(installedId("kjv")).toBeNull();
    for (const version of profile.repo.listVersions()) profile.repo.deleteVersion(version.id);
    seedBuiltinBibles(profile.db, profile.sqlite, biblesDir, profile.settings, false);
    expect(profile.repo.listVersions()).toEqual([]);

    expect(installedId(BUILTIN_BIBLE_CODE)).toBeNull();
    installBundledBible(profile.db, profile.sqlite, biblesDir, BUILTIN_BIBLE_CODE);
    expect(profile.repo.listVersions()[0]).toMatchObject({ code: BUILTIN_BIBLE_CODE, name: "Reina-Valera 1909" });
    expect(() => installBundledBible(profile.db, profile.sqlite, biblesDir, "nope")).toThrow();
    profile.sqlite.close();
  });

  test("the listing carries each version's credit", () => {
    const listing = bundledBibleDTOs([]);
    expect(listing.map((bible) => bible.code)).toEqual(BUNDLED_BIBLES.map((bible) => bible.code));
    expect(listing.find((bible) => bible.code === "biblialivre")?.credit).toMatch(/BLIVRE.*Creative Commons/);
    expect(listing.find((bible) => bible.code === "vbl")?.credit).toMatch(/Gallagher.*CompartirIgual/);
    expect(listing.filter((bible) => bible.credit !== null)).toHaveLength(2);
  });
});

describe("a version's language", () => {
  test("only a two-letter tag is accepted, and the repo stores it", () => {
    for (const ok of ["en", "es", "pt", "de"]) expect(isBibleLanguage(ok), ok).toBe(true);
    for (const bad of ["", "EN", "eng", "en-US", "e", 7, null, undefined]) expect(isBibleLanguage(bad), String(bad)).toBe(false);

    const profile = freshProfile("es");
    seedBuiltinBibles(profile.db, profile.sqlite, biblesDir, profile.settings, true);
    const [rv] = profile.repo.listVersions();
    expect(profile.repo.setLanguage(rv!.id, "en")?.language).toBe("en");
    expect(profile.repo.setLanguage(9999, "en")).toBeNull();
    profile.sqlite.close();
  });
});
