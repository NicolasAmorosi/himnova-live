/**
 * The Bible versions inside the installer (`main/db/seed/bundled-bibles.ts`): the seed rules a profile goes through.
 * A new one gets its language's versions, an existing one only re-seeds what it has, and a deleted version stays
 * deleted until the operator installs it again. Every file read by the parser is `bundled-bible-files.test.ts`.
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
import { BUILTIN_BIBLE_CODE, BUNDLED_BIBLE_SHORT } from "../../src/shared/constants";
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

// The version picker's short names (2026-11-15 audit, U14): one for every included version, none twice, short enough to
// be the point of having them. A version added to the catalog without one would read «Rive…» again at 1000 px.
test("every included version has its own short name for a narrow picker", () => {
  const shorts = BUNDLED_BIBLES.map((bible) => BUNDLED_BIBLE_SHORT[bible.code]);
  expect(shorts.every((short) => typeof short === "string" && short.length > 0 && short.length <= 6)).toBe(true);
  expect(new Set(shorts).size).toBe(BUNDLED_BIBLES.length);
  expect(Object.keys(BUNDLED_BIBLE_SHORT).sort()).toEqual(BUNDLED_BIBLES.map((bible) => bible.code).sort());
});
