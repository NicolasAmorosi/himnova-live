import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Db } from "./client";

/**
 * Whether `runMigrations` would actually apply anything.
 *
 * Drizzle's migrator compares each journal entry's `when` against the newest
 * `created_at` in `__drizzle_migrations`; this asks the same question without
 * running it. Opened as its own read-only connection because the caller runs
 * BEFORE `openDatabase` — the whole point is to decide about the file before
 * touching it.
 */
function hasPendingMigrations(dbFilePath: string, migrationsFolder: string): boolean {
  let journalMax: number;
  try {
    const journal = JSON.parse(
      fs.readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf-8"),
    ) as { entries?: { when: number }[] };
    const entries = journal.entries ?? [];
    if (entries.length === 0) return false;
    journalMax = Math.max(...entries.map((e) => e.when));
  } catch {
    // No journal we can read: assume the worst and take the backup.
    return true;
  }

  let applied: number;
  try {
    const sqlite = new Database(dbFilePath, { readonly: true });
    try {
      const row = sqlite
        .prepare(`SELECT MAX(created_at) AS max FROM __drizzle_migrations`)
        .get() as { max: number | null } | undefined;
      applied = row?.max ?? 0;
    } finally {
      sqlite.close();
    }
  } catch {
    // No migrations table yet (a database from before drizzle, or a file we
    // cannot open read-only) — treat as pending.
    return true;
  }

  return journalMax > applied;
}

/**
 * What `backupBeforeMigrate` actually managed to do, so the caller can tell
 * the operator the truth. A migration error box that promises a copy which was
 * never taken — or never verified — is worse than one that admits there isn't
 * one: it sends someone looking for a recovery that does not exist.
 */
export type BackupResult =
  | { status: "skipped" }
  | { status: "ok"; path: string }
  | { status: "failed"; reason: string };

/**
 * Snapshots the database before applying pending migrations, keeping the last 3.
 * A migration failing on a user's machine on a Sunday morning must be
 * recoverable — SQLite's DDL is transactional so a failed migration itself
 * rolls back, but this covers the case where the *result* is wrong in a way
 * that only shows up after commit.
 *
 * **Only when something is actually pending.** It used to copy the whole file
 * on EVERY launch, which cost a 10 MB `copyFileSync` before the window existed
 * — but far worse, the three kept slots were consumed by post-migration
 * copies: three ordinary launches after a migration and the pre-migration
 * snapshot, the only one this function exists to keep, had been rotated out.
 */
export function backupBeforeMigrate(
  dbFilePath: string,
  backupDir: string,
  migrationsFolder: string,
): BackupResult {
  if (!fs.existsSync(dbFilePath)) return { status: "skipped" };
  if (!hasPendingMigrations(dbFilePath, migrationsFolder)) return { status: "skipped" };
  fs.mkdirSync(backupDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(backupDir, `worship-${stamp}.db`);

  try {
    writeSnapshot(dbFilePath, dest);
    verifySnapshot(dest);
  } catch (error) {
    // A half-written or corrupt copy is worse than no copy: it survives the
    // rotation below and gets restored with confidence on the worst day.
    try {
      fs.rmSync(dest, { force: true });
    } catch {
      // Nothing more to do — the reason below is what gets reported.
    }
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }

  pruneOldBackups(backupDir);
  return { status: "ok", path: dest };
}

/**
 * `VACUUM INTO`, not `fs.copyFileSync`.
 *
 * The database runs in `journal_mode = WAL` (`db/client.ts`), and in WAL the
 * recent transactions live in `worship.db-wal`, not in `worship.db`. Copying
 * the main file alone silently drops every write since the last checkpoint,
 * and SQLite is explicit that a filesystem copy is not a valid backup of a
 * WAL database.
 *
 * The old copy usually came out complete — this function runs before the app
 * opens the database, so the WAL is normally checkpointed. It failed exactly
 * when it was needed: after a dirty shutdown, a power cut or a SIGKILL, which
 * is precisely what leaves a large un-checkpointed `-wal` behind.
 *
 * Opened read-WRITE on purpose: that is what lets SQLite replay a hot `-wal`
 * before the snapshot is read. `VACUUM INTO` then writes one compact,
 * consistent, defragmented file, and refuses to overwrite an existing path —
 * which the timestamped name already guarantees.
 */
function writeSnapshot(dbFilePath: string, dest: string): void {
  const sqlite = new Database(dbFilePath);
  try {
    sqlite.pragma("busy_timeout = 5000");
    sqlite.prepare("VACUUM INTO ?").run(dest);
  } finally {
    sqlite.close();
  }
}

/** A backup nobody has read is an assumption. `integrity_check` against the
 *  copy — not the original — is what turns it into a fact, and on a file this
 *  size it costs milliseconds. */
function verifySnapshot(dest: string): void {
  const sqlite = new Database(dest, { readonly: true });
  try {
    const rows = sqlite.pragma("integrity_check") as { integrity_check?: string }[];
    const verdict = rows[0]?.integrity_check;
    if (verdict !== "ok") throw new Error(`integrity_check returned "${verdict ?? "nothing"}"`);
  } finally {
    sqlite.close();
  }
}

/** Best-effort: a backup that cannot be deleted (read-only, held open by an
 *  antivirus on Windows: `EPERM`/`EBUSY`) costs some disk, and must never cost
 *  the launch the fresh backup was taken for. */
function pruneOldBackups(backupDir: string): void {
  const existing = fs
    .readdirSync(backupDir)
    .filter((f) => f.endsWith(".db"))
    .sort();
  for (const stale of existing.slice(0, Math.max(0, existing.length - 3))) {
    try {
      fs.unlinkSync(path.join(backupDir, stale));
    } catch (error) {
      console.warn(`[db] could not prune old backup ${stale}`, error);
    }
  }
}

/**
 * Repairs every row that points at a parent that no longer exists, the way its foreign key would
 * have on that parent's delete: `SET NULL` clears the column, anything else (`CASCADE`, `RESTRICT`)
 * removes the row. Returns how many rows it touched, for the log.
 *
 * Run before `runMigrations`. A migration that rebuilds a table (`program_items` in 0009, 0011, 0015,
 * 0019) copies it with foreign keys ON, and drizzle applies every pending migration in ONE
 * transaction: a single dangling reference rolled the whole upgrade back, and the app showed the
 * error and closed on every launch after — with a backup holding the same row (2026-11-10 review,
 * agent6-02). Such rows have existed: the 184 orphan deck rows of 2026-09-15, cause never found.
 */
export function repairDanglingReferences(sqlite: Database.Database): number {
  const violations = sqlite.pragma("foreign_key_check") as { table: string; rowid: number | null; fkid: number }[];
  let repaired = 0;
  for (const { table, rowid, fkid } of violations) {
    if (rowid === null) continue;
    const keys = sqlite.pragma(`foreign_key_list("${table.replace(/"/g, '""')}")`) as {
      id: number;
      from: string;
      on_delete: string;
    }[];
    const key = keys.find((candidate) => candidate.id === fkid);
    const quoted = `"${table.replace(/"/g, '""')}"`;
    try {
      if (key?.on_delete.toUpperCase() !== "SET NULL") throw new Error("not set null");
      // A CHECK may forbid the null (a schedule row's kind needs its id): then it goes.
      sqlite.prepare(`UPDATE ${quoted} SET "${key.from.replace(/"/g, '""')}" = NULL WHERE rowid = ?`).run(rowid);
    } catch {
      sqlite.prepare(`DELETE FROM ${quoted} WHERE rowid = ?`).run(rowid);
    }
    repaired += 1;
  }
  return repaired;
}

export function runMigrations(db: Db, migrationsFolder: string): void {
  migrate(db, { migrationsFolder });
}
