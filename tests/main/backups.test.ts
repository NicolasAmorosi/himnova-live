/**
 * «Restaurar una copia» (`db/backups.ts`): a copy is staged (refused when it is not a sound Himnova database
 * this build can read) and swapped in at the next launch, before the database opens, after a copy of what it
 * replaces. A copy from before an update comes up to date through the launch's own migrations.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openDatabase } from "../../src/main/db/client";
import { journalNewest, openForLaunch, runMigrations } from "../../src/main/db/migrate";
import {
  applyPendingRestore,
  backupEntries,
  stageRestore,
  stagedRestorePath,
  takeLaunchRestore,
} from "../../src/main/db/backups";
import { ProgramsRepo } from "../../src/main/db/repositories/programs.repo";

const drizzleDir = path.join(process.cwd(), "drizzle");
const newest = journalNewest(drizzleDir);
const journal = JSON.parse(fs.readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf-8")) as {
  entries: { tag: string }[];
};

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "worship-backups-"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let serial = 0;
const fresh = (name: string) => path.join(tmp, `${serial++}-${name}`);

/** A database of this build holding one program called `program`, migrated with `folder`. */
function profileDb(file: string, program: string, folder = drizzleDir): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { sqlite, db } = openDatabase(file);
  runMigrations(db, folder);
  new ProgramsRepo(db, sqlite).save({ name: program, items: [] });
  sqlite.close();
  return file;
}

const programNames = (file: string): string[] => {
  const sqlite = new Database(file, { readonly: true });
  try {
    return (sqlite.prepare("SELECT name FROM programs ORDER BY name").all() as { name: string }[]).map((row) => row.name);
  } finally {
    sqlite.close();
  }
};

describe("staging a copy", () => {
  test("stages a sound copy of this build, keeping its date", () => {
    const source = profileDb(fresh("copia.db"), "Culto de ayer");
    const when = new Date("2026-11-01T10:30:00Z");
    fs.utimesSync(source, when, when);
    const staged = path.join(fresh("backups"), "restore-pending", "worship.db");

    expect(stageRestore(source, staged, newest)).toBeNull();
    expect(programNames(staged)).toEqual(["Culto de ayer"]);
    expect(fs.statSync(staged).mtimeMs).toBe(when.getTime());
  });

  test("refuses what is not a database, not Himnova's, or from a newer version, and stages nothing", () => {
    const staged = path.join(fresh("backups"), "restore-pending", "worship.db");
    const text = fresh("notas.db");
    fs.writeFileSync(text, "esto no es una base");
    expect(stageRestore(text, staged, newest)).toBe("unreadable");

    const other = fresh("otra.db");
    const sqlite = new Database(other);
    sqlite.exec("CREATE TABLE contacts (name TEXT)");
    sqlite.close();
    expect(stageRestore(other, staged, newest)).toBe("notHimnova");

    const newer = profileDb(fresh("nueva.db"), "Del futuro");
    const db = new Database(newer);
    db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('x', ?)").run((newest ?? 0) + 1);
    db.close();
    expect(stageRestore(newer, staged, newest)).toBe("newer");

    expect(fs.existsSync(path.dirname(staged))).toBe(false);
  });

  test("a copy that stops half-way is never what the next launch swaps in", () => {
    const profile = fresh("profile");
    const dbFile = profileDb(path.join(profile, "worship.db"), "Culto de hoy");
    const backups = path.join(profile, "backups");
    // What a refusal Windows could not delete, or a throw mid-copy, would leave behind.
    const staged = stagedRestorePath(backups);
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.copyFileSync(profileDb(fresh("ajena.db"), "De otra iglesia"), `${staged}.partial`);

    expect(applyPendingRestore(dbFile, backups)).toBeNull();
    expect(programNames(dbFile)).toEqual(["Culto de hoy"]);
  });
});

describe("applying it at launch", () => {
  test("swaps the staged copy in after a copy of what it replaces, once, and drops the old -wal", () => {
    const profile = fresh("profile");
    const dbFile = profileDb(path.join(profile, "worship.db"), "Culto de hoy");
    const backups = path.join(profile, "backups");
    expect(stageRestore(profileDb(fresh("copia.db"), "Culto de ayer"), stagedRestorePath(backups), newest)).toBeNull();
    // A `-wal` left next to the database would be replayed onto the restored file.
    fs.writeFileSync(`${dbFile}-wal`, "páginas de la base de antes");

    const outcome = applyPendingRestore(dbFile, backups);

    expect(outcome).toMatchObject({ status: "ok" });
    expect(programNames(dbFile)).toEqual(["Culto de ayer"]);
    expect(fs.existsSync(`${dbFile}-wal`)).toBe(false);
    expect(fs.existsSync(path.dirname(stagedRestorePath(backups)))).toBe(false);
    const [before] = backupEntries(backups);
    expect(before).toMatchObject({ kind: "restore", programs: 1 });
    expect(programNames(before!.path)).toEqual(["Culto de hoy"]);
    expect(takeLaunchRestore()).toEqual(outcome);
    expect(takeLaunchRestore()).toBeNull();
    // Nothing staged, nothing done.
    expect(applyPendingRestore(dbFile, backups)).toBeNull();
  });

  test("a copy from before an update is migrated by the launch, with the pre-migration copy taken", () => {
    const older = path.join(tmp, "drizzle-older");
    fs.mkdirSync(path.join(older, "meta"), { recursive: true });
    const entries = journal.entries.slice(0, -1);
    for (const e of entries) fs.copyFileSync(path.join(drizzleDir, `${e.tag}.sql`), path.join(older, `${e.tag}.sql`));
    fs.writeFileSync(path.join(older, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));

    const profile = fresh("profile");
    const dbFile = profileDb(path.join(profile, "worship.db"), "Culto de hoy");
    const backups = path.join(profile, "backups");
    const old = profileDb(fresh("vieja.db"), "Culto del mes pasado", older);
    expect(stageRestore(old, stagedRestorePath(backups), newest)).toBeNull();
    applyPendingRestore(dbFile, backups);
    takeLaunchRestore();

    const launched = openForLaunch(dbFile, backups, drizzleDir, () => {});
    try {
      expect(launched.backup.status).toBe("ok");
      const applied = launched.sqlite.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as { n: number };
      expect(applied.n).toBe(journal.entries.length);
      expect(new ProgramsRepo(launched.db, launched.sqlite).list().map((p) => p.name)).toEqual(["Culto del mes pasado"]);
    } finally {
      launched.sqlite.close();
    }
  });
});

test("the list holds every kind of copy, newest first, with what each holds", () => {
  const backups = fresh("backups");
  const at = (file: string, iso: string) => {
    const when = new Date(iso);
    fs.utimesSync(file, when, when);
    return file;
  };
  at(profileDb(path.join(backups, "daily", "worship-a.db"), "Diaria"), "2026-11-12T10:00:00Z");
  at(profileDb(path.join(backups, "worship-b.db"), "Antes de actualizar"), "2026-11-10T10:00:00Z");
  at(profileDb(path.join(backups, "before-restore", "worship-c.db"), "Antes de restaurar"), "2026-11-13T10:00:00Z");
  fs.writeFileSync(path.join(backups, "daily", "rota.db"), "no es una base");
  at(path.join(backups, "daily", "rota.db"), "2026-11-01T10:00:00Z");

  const entries = backupEntries(backups);

  expect(entries.map((entry) => [entry.kind, entry.programs, entry.songs])).toEqual([
    ["restore", 1, 0],
    ["daily", 1, 0],
    ["update", 1, 0],
    ["daily", null, null],
  ]);
});
