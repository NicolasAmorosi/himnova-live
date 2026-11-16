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
import { journalNewest, openForLaunch, runMigrations, takeSnapshot } from "../../src/main/db/migrate";
import {
  applyPendingRestore,
  backupEntries,
  isDamagedDatabase,
  newestDailyCopy,
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

/** A database of this build whose programs index no longer matches its rows. Overwritten bytes make `VACUUM INTO`
 *  throw before any copy exists; this damage is copied as it is, so only `integrity_check` on the copy sees it
 *  (2026-11-15 audit, P6). */
function damagedDb(file: string): string {
  profileDb(file, "Culto dañado");
  const sqlite = new Database(file);
  try {
    sqlite.unsafeMode(true);
    sqlite.pragma("writable_schema = ON");
    sqlite.prepare("UPDATE sqlite_master SET sql = ? WHERE name = 'ix_programs_order'").run(
      "CREATE INDEX `ix_programs_order` ON `programs` (`name`)",
    );
  } finally {
    sqlite.close();
  }
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

  test("a damaged copy is refused, and nothing is staged (2026-11-15 audit, P6)", () => {
    const staged = path.join(fresh("backups"), "restore-pending", "worship.db");
    expect(stageRestore(damagedDb(fresh("dañada.db")), staged, newest)).toBe("damaged");
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

  test("over a damaged database, the copy goes in all the same, the damaged file kept raw beside it (audit D2)", () => {
    // The case a restore exists for: the database opens, but a damaged page makes `VACUUM INTO` throw, so there was
    // no verified copy of it, nothing was replaced and the staged copy was deleted. Every try did the same.
    const profile = fresh("profile");
    const dbFile = path.join(profile, "worship.db");
    const { sqlite, db } = (fs.mkdirSync(profile, { recursive: true }), openDatabase(dbFile));
    runMigrations(db, drizzleDir);
    const programs = new ProgramsRepo(db, sqlite);
    for (let i = 0; i < 400; i++) programs.save({ name: `Culto ${i} ${"x".repeat(200)}`, items: [] });
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    sqlite.close();
    const bytes = fs.readFileSync(dbFile);
    bytes.fill(0xa5, bytes.length - 40 * 4096, bytes.length - 30 * 4096);
    fs.writeFileSync(dbFile, bytes);
    const backups = path.join(profile, "backups");
    expect(stageRestore(profileDb(fresh("copia.db"), "Culto de ayer"), stagedRestorePath(backups), newest)).toBeNull();

    expect(applyPendingRestore(dbFile, backups)).toMatchObject({ status: "ok" });

    expect(programNames(dbFile)).toEqual(["Culto de ayer"]);
    const kept = fs.readdirSync(path.join(backups, "before-restore"));
    const raw = kept.find((name) => name.endsWith("-damaged.db"));
    expect(raw).toBeDefined();
    expect(fs.readFileSync(path.join(backups, "before-restore", raw!)).equals(bytes)).toBe(true);
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

test("a snapshot of a damaged database fails, and leaves no file behind (2026-11-15 audit, P6)", () => {
  const dir = fresh("daily");
  const result = takeSnapshot(damagedDb(fresh("worship.db")), dir, 7, new Date("2026-11-15T10:00:00Z"));
  expect(result.status).toBe("failed");
  expect(result.status === "failed" && result.reason).toMatch(/integrity_check/);
  expect(fs.readdirSync(dir)).toEqual([]);
});

describe("a launch that cannot open its database (audit D3)", () => {
  test("offers the newest daily copy that reads, or none", () => {
    const backups = fresh("backups");
    const daily = path.join(backups, "daily");
    expect(newestDailyCopy(backups)).toBeNull();
    const good = profileDb(path.join(daily, "worship-2026-11-13T09-00-00-000Z.db"), "Culto del jueves");
    fs.utimesSync(good, new Date("2026-11-13T09:00:00Z"), new Date("2026-11-13T09:00:00Z"));
    // A newer one that does not read (a copy cut half-way) is skipped.
    fs.writeFileSync(path.join(daily, "worship-2026-11-14T09-00-00-000Z.db"), "SQLite format 3\0 cortada");
    expect(newestDailyCopy(backups)?.path).toBe(good);
  });

  test("offers it for a damaged file only, not for a migration that failed on sound data", () => {
    const dbFile = fresh("worship.db");
    const { sqlite, db } = openDatabase(dbFile);
    runMigrations(db, drizzleDir);
    const programs = new ProgramsRepo(db, sqlite);
    for (let i = 0; i < 400; i++) programs.save({ name: `Culto ${i} ${"x".repeat(200)}`, items: [] });
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    sqlite.close();
    const bytes = fs.readFileSync(dbFile);
    bytes.fill(0xa5, bytes.length - 40 * 4096, bytes.length - 30 * 4096);
    fs.writeFileSync(dbFile, bytes);
    const damaged = new Database(dbFile);
    let thrown: unknown = null;
    try {
      // What the launch's copies do first.
      damaged.exec(`VACUUM INTO '${fresh("copia.db")}'`);
    } catch (error) {
      thrown = error;
    }
    damaged.close();
    expect(isDamagedDatabase(thrown)).toBe(true);

    const sound = new Database(":memory:");
    sound.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    sound.exec("INSERT INTO t VALUES (1)");
    let constraint: unknown = null;
    try {
      sound.exec("INSERT INTO t VALUES (1)");
    } catch (error) {
      constraint = error;
    }
    sound.close();
    expect(isDamagedDatabase(constraint)).toBe(false);
    expect(isDamagedDatabase(new Error("disk image"))).toBe(false);
  });
});
