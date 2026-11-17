import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { BackupEntry, BackupKind, LaunchRestore } from "@shared/types/backups";
import { listBackups, takeSnapshot, verifySnapshot, writeSnapshot } from "./migrate";

/**
 * «Restaurar una copia» (owner, 2026-11-13). A restore never touches the open
 * database: the chosen copy is STAGED (snapshotted, verified, checked to be a Himnova database no newer than
 * this build) and the app restarts; at the next launch, before the database is opened, what is there now is
 * copied to `before-restore/` and the staged file takes its place (`applyPendingRestore`). The migrations
 * then run as on any launch, so a copy from before an update comes up to date by itself.
 */

/** Each kind's folder under the profile's `backups/`: the pre-migration copies are the folder itself. */
const KIND_FOLDERS: Record<Exclude<BackupKind, "file">, string> = { daily: "daily", update: "", restore: "before-restore" };

export const dailyBackupDir = (backupDir: string): string => path.join(backupDir, KIND_FOLDERS.daily);
/** The copy waiting for the next launch. Its own folder: at the top of `backups/` it would read as a
 *  pre-migration copy, and be rotated out. */
export const stagedRestorePath = (backupDir: string): string => path.join(backupDir, "restore-pending", "worship.db");

/** Every copy the app keeps, newest first. */
export function backupEntries(backupDir: string): BackupEntry[] {
  return (Object.entries(KIND_FOLDERS) as [Exclude<BackupKind, "file">, string][])
    .flatMap(([kind, folder]) => {
      const dir = path.join(backupDir, folder);
      return listBackups(dir).map((name) => describeBackup(path.join(dir, name), kind));
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => b.takenAt - a.takenAt);
}

/** One copy, with what it holds; `null` when the file is gone. Opened read-only, a few ms each. */
export function describeBackup(file: string, kind: BackupKind): BackupEntry | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  let programs: number | null = null;
  let songs: number | null = null;
  try {
    const sqlite = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const count = (table: string): number | null => {
        try {
          return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
        } catch {
          return null;
        }
      };
      programs = count("programs");
      songs = count("songs");
    } finally {
      sqlite.close();
    }
  } catch {
    // Not a database we can read: listed all the same, and refused with a reason if it is chosen.
  }
  return { path: file, kind, takenAt: stat.mtimeMs, sizeBytes: stat.size, programs, songs };
}

/** Why a copy cannot be restored, for the operator: a stable code main words (`mt("backups.*")`). */
export type RestoreRefusal = "unreadable" | "damaged" | "notHimnova" | "newer";

const REQUIRED_TABLES = ["settings", "media_assets", "programs", "__drizzle_migrations"];

/**
 * Stages `source` for the next launch: a fresh snapshot of it at `staged` (never the file itself: a copy on a
 * USB stick may be gone by then, and a database left open elsewhere has its latest rows in its `-wal`),
 * verified, with Himnova's tables and no migration newer than `newestMigration` (the newer build's schema
 * would be read by this one's code). It keeps the source's date, which the next launch says. Seconds on a
 * large file: run off the main thread (`backup-worker.ts`).
 */
export function stageRestore(source: string, staged: string, newestMigration: number | null): RestoreRefusal | null {
  const dir = path.dirname(staged);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // Built under another name and renamed only once it passed: whatever stops half-way (a refusal, a throw, a
  // file Windows will not delete) leaves nothing `applyPendingRestore` would swap in for the church's database.
  const partial = `${staged}.partial`;
  const refused = checkCopy(source, partial, newestMigration);
  if (refused) {
    // Every handle on the copy is closed by now: on Windows an open file cannot be deleted (CI, 2026-11-13).
    fs.rmSync(dir, { recursive: true, force: true });
    return refused;
  }
  fs.utimesSync(partial, new Date(), fs.statSync(source).mtime);
  fs.renameSync(partial, staged);
  return null;
}

/** Snapshots `source` to `dest` and says why it cannot be restored, if it cannot. Closes what it opens. */
function checkCopy(source: string, dest: string, newestMigration: number | null): RestoreRefusal | null {
  try {
    writeSnapshot(source, dest);
  } catch {
    return "unreadable";
  }
  try {
    verifySnapshot(dest);
  } catch {
    return "damaged";
  }
  const sqlite = new Database(dest, { readonly: true });
  try {
    const tables = new Set(
      (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name),
    );
    if (!REQUIRED_TABLES.every((table) => tables.has(table))) return "notHimnova";
    const row = sqlite.prepare("SELECT MAX(created_at) AS newest FROM __drizzle_migrations").get() as { newest: number | null };
    if (newestMigration !== null && (row.newest ?? 0) > newestMigration) return "newer";
    return null;
  } finally {
    sqlite.close();
  }
}

let launchRestore: LaunchRestore | null = null;

/**
 * At launch, BEFORE the database is opened: the staged copy takes the database's place, if there is one. What
 * is there now goes to `before-restore/` first (the last 3 kept): a verified copy, or, when the database is too
 * damaged to give one, its file as it is (`-damaged.db`, with its `-wal`); without either, nothing is replaced.
 * The `-wal` goes before the swap, and if it cannot, nothing is replaced either: SQLite would replay those
 * pages onto the restored file. The quit that led here checkpointed it, and the copy above holds it anyway.
 */
export function applyPendingRestore(dbFilePath: string, backupDir: string, now = new Date()): LaunchRestore | null {
  const staged = stagedRestorePath(backupDir);
  if (!fs.existsSync(staged)) return null;
  const takenAt = fs.statSync(staged).mtimeMs;
  const failed = (reason: string): LaunchRestore => {
    fs.rmSync(path.dirname(staged), { recursive: true, force: true });
    console.warn("[db] restore failed:", reason);
    return (launchRestore = { status: "failed", reason });
  };
  if (fs.existsSync(dbFilePath)) {
    const beforeDir = path.join(backupDir, KIND_FOLDERS.restore);
    const before = takeSnapshot(dbFilePath, beforeDir, 3, now);
    if (before.status === "failed") {
      // A damaged page makes `VACUUM INTO` throw: the database a restore exists for got no copy, nothing was
      // replaced and every try did the same (2026-11-15 audit, D2). The file itself is kept instead. It is closed.
      const raw = keepAsItIs(dbFilePath, beforeDir, now);
      if (raw !== null) return failed(`no copy of the current database: ${before.reason}; nor as it is: ${raw}`);
      console.warn("[db] the database could not be copied cleanly, kept as it is:", before.reason);
    }
  }
  try {
    fs.rmSync(`${dbFilePath}-wal`, { force: true });
    fs.rmSync(`${dbFilePath}-shm`, { force: true });
    fs.renameSync(staged, dbFilePath);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
  fs.rmSync(path.dirname(staged), { recursive: true, force: true });
  return (launchRestore = { status: "ok", takenAt });
}

/** `dbFilePath` and its `-wal`, copied byte for byte into `dir` under a name that says what they are. The reason
 *  when they could not be. */
function keepAsItIs(dbFilePath: string, dir: string, now: Date): string | null {
  const dest = path.join(dir, `worship-${now.toISOString().replace(/[:.]/g, "-")}-damaged.db`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(dbFilePath, dest);
    if (fs.existsSync(`${dbFilePath}-wal`)) fs.copyFileSync(`${dbFilePath}-wal`, `${dest}-wal`);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The copy a launch that cannot open its database offers to restore (audit D3): the newest daily copy that reads. */
export function newestDailyCopy(backupDir: string): BackupEntry | null {
  return backupEntries(backupDir).find((entry) => entry.kind === "daily" && entry.programs !== null) ?? null;
}

/** Whether a launch failed because the database file is damaged, which a copy can mend; not a migration that
 *  failed on sound data, which a day-old copy would only fail again. */
export function isDamagedDatabase(error: unknown): boolean {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === "string" && (code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB");
}

/** What this launch's restore did, once: the control window says it when it opens. */
export function takeLaunchRestore(): LaunchRestore | null {
  const outcome = launchRestore;
  launchRestore = null;
  return outcome;
}
