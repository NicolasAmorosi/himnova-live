/**
 * The CCLI usage report (owner, 2026-11-05): a song counts once per day it
 * went live; a song still in the library reports under its current title and
 * CCLI number, a deleted one under what it was; the CSV is Excel's.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { openDatabase } from "../../src/main/db/client";
import { runMigrations } from "../../src/main/db/migrate";
import { setMainLocale } from "../../src/main/i18n";
import { getSongsRepo, initRepos } from "../../src/main/services/repos";
import { songUsageCsv } from "../../src/main/songs/usage-report";
import { parseLyrics } from "../../src/shared/song-text";

let tmpDir: string;
let sqlite: ReturnType<typeof openDatabase>["sqlite"];

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-usage-"));
  const opened = openDatabase(path.join(tmpDir, "library.db"));
  sqlite = opened.sqlite;
  runMigrations(opened.db, path.join(process.cwd(), "drizzle"));
  initRepos(opened.db, sqlite);
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => setMainLocale("es"));

const song = (title: string, ccliNumber: string | null, authors: string | null = null) =>
  getSongsRepo().create({
    title,
    number: null,
    authors,
    copyright: null,
    ccliNumber,
    notes: null,
    sections: parseLyrics("[Estrofa 1]\nUna línea", "es").sections,
    order: [],
    themeId: null,
  });

const at = (day: string, time = "10:00") => new Date(`${day}T${time}:00`).getTime();

describe("the uses", () => {
  test("once per song per day; a deleted song keeps what it was; a CCLI number added later counts", () => {
    const repo = getSongsRepo();
    const gracia = song("Sublime gracia", null, "John Newton");
    const castillo = song("Castillo fuerte", "42964");
    repo.recordUse(gracia.id, at("2026-11-01", "10:00"));
    repo.recordUse(gracia.id, at("2026-11-01", "19:30")); // same day: not again
    repo.recordUse(gracia.id, at("2026-11-08"));
    repo.recordUse(castillo.id, at("2026-11-08"));
    repo.recordUse(castillo.id, at("2026-12-20")); // outside the range below

    repo.update(gracia.id, { ...gracia, ccliNumber: "22025" });
    repo.delete(castillo.id);

    const uses = repo.usesBetween(at("2026-11-01", "00:00"), at("2026-12-01", "00:00"));
    expect(uses).toEqual([
      { title: "Sublime gracia", authors: "John Newton", ccliNumber: "22025", days: [at("2026-11-01"), at("2026-11-08")] },
      { title: "Castillo fuerte", authors: null, ccliNumber: "42964", days: [at("2026-11-08")] },
    ]);
  });
});

describe("the CSV", () => {
  const uses = [
    { title: "Uno", authors: null, ccliNumber: null, days: [at("2026-11-08")] },
    { title: 'Dos; "tres"', authors: "A, B", ccliNumber: "123456", days: [at("2026-11-01"), at("2026-11-08")] },
  ];

  test("Spanish: «;», a BOM, the most used first, a field with «;», «,» or quotes quoted", () => {
    expect(songUsageCsv(uses)).toBe(
      "\uFEFFTítulo;Autores;Número CCLI;Usos;Fechas\r\n" +
        '"Dos; ""tres""";"A, B";123456;2;2026-11-01 2026-11-08\r\n' +
        "Uno;;;1;2026-11-08\r\n",
    );
  });

  test("English: «,»", () => {
    setMainLocale("en");
    expect(songUsageCsv(uses).split("\r\n")[0]).toBe("\uFEFFTitle,Authors,CCLI number,Uses,Dates");
    expect(songUsageCsv(uses).split("\r\n")[1]).toBe('"Dos; ""tres""","A, B",123456,2,2026-11-01 2026-11-08');
  });
});
