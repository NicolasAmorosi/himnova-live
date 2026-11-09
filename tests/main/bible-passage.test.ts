/**
 * `bible:passage` — the same passage in another version, for a verse going out
 * in two languages side by side: the book is found by what it is in every
 * version, never by its row, and the reference is in that version's words.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { openDatabase } from "../../src/main/db/client";
import { runMigrations } from "../../src/main/db/migrate";
import { seedBibleFromFile, seedBuiltinBibles } from "../../src/main/db/seed/seed-bible";
import { BibleRepo } from "../../src/main/db/repositories/bible.repo";
import { SettingsRepo } from "../../src/main/db/repositories/settings.repo";
import { SETTINGS_VALIDATORS } from "../../src/shared/types/settings";

let dir: string;
let sqlite: ReturnType<typeof openDatabase>["sqlite"];
let repo: BibleRepo;
let spanish: number;
let english: number;
let partial: number;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-bible-passage-"));
  const opened = openDatabase(path.join(dir, "passage.db"));
  sqlite = opened.sqlite;
  runMigrations(opened.db, path.join(process.cwd(), "drizzle"));
  seedBuiltinBibles(opened.db, sqlite, path.join(process.cwd(), "resources/bibles"), new SettingsRepo(opened.db), false);
  repo = new BibleRepo(opened.db, sqlite);
  spanish = repo.listVersions()[0]!.id;

  // A partial canon (Zefania: the importer writes the app's own abbrevs), with
  // John 3:17 missing — a verse some versions leave out.
  const zefania = path.join(dir, "english.xml");
  fs.writeFileSync(
    zefania,
    `<?xml version="1.0" encoding="UTF-8"?>
<XMLBIBLE biblename="English">
  <BIBLEBOOK bnumber="43" bname="John">
    <CHAPTER cnumber="3">
      <VERS vnumber="16">For God so loved the world.</VERS>
      <VERS vnumber="18">He who believes in him is not judged.</VERS>
    </CHAPTER>
  </BIBLEBOOK>
</XMLBIBLE>`,
  );
  english = seedBibleFromFile(opened.db, sqlite, zefania, { code: "english", fallbackName: "English" })!.versionId;

  // A hand-made JSON spells its books its own way.
  const json = path.join(dir, "partial.json");
  fs.writeFileSync(json, JSON.stringify([{ abbrev: "Gv", name: "Giovanni", chapters: [["Uno.", "Due."]] }]));
  partial = seedBibleFromFile(opened.db, sqlite, json, { code: "partial", fallbackName: "Partial" })!.versionId;
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("finds the book by the app's abbrev in another version, named in that version", () => {
  expect(repo.getPassage(english, "jo", 3, 16, 16)).toEqual({
    text: "For God so loved the world.",
    reference: "John 3:16",
  });
  // The bundled bible is a whole canon: found by position, whatever it spells.
  expect(repo.getPassage(spanish, "jo", 3, 16, 16)?.reference).toBe("Juan 3:16");
});

test("a range is its verses joined, under the range's reference", () => {
  const sixteen = repo.getPassage(spanish, "jo", 3, 16, 16)!.text;
  const seventeen = repo.getPassage(spanish, "jo", 3, 17, 17)!.text;
  expect(repo.getPassage(spanish, "jo", 3, 16, 17)).toEqual({
    text: `${sixteen} ${seventeen}`,
    reference: "Juan 3:16-17",
  });
  // A verse the version leaves out is left out of the text, not the passage.
  expect(repo.getPassage(english, "jo", 3, 16, 18)).toEqual({
    text: "For God so loved the world. He who believes in him is not judged.",
    reference: "John 3:16-18",
  });
});

test("a passage the version lacks is null", () => {
  expect(repo.getPassage(english, "jo", 3, 17, 17)).toBeNull();
  expect(repo.getPassage(english, "jo", 4, 1, 1)).toBeNull();
  expect(repo.getPassage(english, "gn", 1, 1, 1)).toBeNull();
  expect(repo.getPassage(english, "nothing", 1, 1, 1)).toBeNull();
});

test("a book the canon does not know is matched by its own spelling", () => {
  expect(repo.getPassage(partial, "Gv", 1, 2, 2)).toEqual({ text: "Due.", reference: "Giovanni 1:2" });
  expect(repo.getPassage(partial, "jo", 1, 2, 2)).toBeNull();
});

test("the parallel version setting is a version id or none", () => {
  const valid = SETTINGS_VALIDATORS["bible.parallelVersionId"];
  expect([null, 1, 42].every(valid)).toBe(true);
  expect([0, -1, 1.5, "2", undefined].some(valid)).toBe(false);
});
