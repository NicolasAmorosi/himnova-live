/**
 * A launch hashes a bundled Bible only when its file is not the one this profile last seeded (2026-11-15 audit,
 * R18): the stamp is the app's version, the file's size and its mtime. An unchanged file is not read at all; a
 * corrected one still re-seeds; a touched one with the same bytes is hashed again and left as it is.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase } from "../../src/main/db/client";
import { runMigrations } from "../../src/main/db/migrate";
import { bibleVerses, bibleVersions } from "../../src/main/db/schema";
import { SettingsRepo } from "../../src/main/db/repositories/settings.repo";
import { seedBuiltinBibles } from "../../src/main/db/seed/seed-bible";
import { BUILTIN_BIBLE_CODE } from "../../src/shared/constants";

const drizzleDir = path.join(process.cwd(), "drizzle");

let tmpDir: string;
let biblesDir: string;
let bibleFile: string;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-bible-stamps-"));
  biblesDir = path.join(tmpDir, "bibles");
  fs.mkdirSync(biblesDir);
  bibleFile = path.join(biblesDir, "rv1909.json");
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const writeBible = (text: string, mtime: Date): void => {
  fs.writeFileSync(bibleFile, JSON.stringify([{ abbrev: "gn", chapters: [[text]] }]));
  fs.utimesSync(bibleFile, mtime, mtime);
};

const profile = () => {
  const opened = openDatabase(path.join(tmpDir, "profile.db"));
  runMigrations(opened.db, drizzleDir);
  return { ...opened, settings: new SettingsRepo(opened.db) };
};

test("a launch reads a bundled Bible only when its file or the app changed", () => {
  writeBible("In the beginning.", new Date(2026, 0, 1));
  const { db, sqlite, settings } = profile();
  const row = () => db.select().from(bibleVersions).where(eq(bibleVersions.code, BUILTIN_BIBLE_CODE)).get();
  const firstVerse = () => db.select({ text: bibleVerses.text }).from(bibleVerses).get()?.text;
  const reads = vi.spyOn(fs, "readFileSync");
  const readsOfTheBible = () => reads.mock.calls.filter(([file]) => file === bibleFile).length;
  const launch = (appVersion: string): void => {
    reads.mockClear();
    seedBuiltinBibles(db, sqlite, biblesDir, settings, false, appVersion);
  };

  launch("2.11.0");
  const seededId = row()!.id;
  expect(firstVerse()).toBe("In the beginning.");

  // The same file, the same build: not read.
  launch("2.11.0");
  expect(readsOfTheBible()).toBe(0);
  expect(row()!.id).toBe(seededId);

  // The same bytes touched, or a new build: hashed again, not re-seeded.
  fs.utimesSync(bibleFile, new Date(2026, 0, 2), new Date(2026, 0, 2));
  launch("2.11.0");
  expect(readsOfTheBible()).toBeGreaterThan(0);
  launch("2.12.0");
  expect(readsOfTheBible()).toBeGreaterThan(0);
  expect(row()!.id).toBe(seededId);
  launch("2.12.0");
  expect(readsOfTheBible()).toBe(0);

  // A corrected file in an update re-seeds, even one of the same size whose mtime the installer kept.
  writeBible("In the Beginning.", new Date(2026, 0, 2));
  launch("2.13.0");
  expect(firstVerse()).toBe("In the Beginning.");
  sqlite.close();
});
