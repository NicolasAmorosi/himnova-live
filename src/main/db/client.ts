import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Opens (or creates) the SQLite file at `filePath` with the pragmas this app
 * relies on. `foreignKeys` must be set on every connection — SQLite does not
 * persist it in the file. Exported as a function (not a singleton) so the
 * db-smoke script and tests can each get an isolated instance.
 */
export function openDatabase(filePath: string): { sqlite: Database.Database; db: Db } {
  const sqlite = new Database(filePath);
  sqlite.pragma("journal_mode = WAL");
  // NORMAL: a commit is not synced to disk, so a power cut can undo the last seconds (the database stays sound). The
  // operator's explicit saves pay for a sync through `writeDurably`. macOS only reaches the disk with F_FULLFSYNC
  // (other systems ignore the pragma): ~3 ms per explicit save and ~6.5 ms per WAL checkpoint, measured on an M3.
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("fullfsync = ON");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("temp_store = MEMORY");
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

/**
 * Runs one of the operator's explicit saves (a program, a song, a song theme, a plate, a scene) with
 * `synchronous = FULL`, so its commit is on disk when the save answers (2026-11-22 review, DU-2). Set before the write
 * because SQLite refuses to change it inside a transaction, and back to NORMAL even when the write throws. `write`
 * must be synchronous: held across an await, FULL would also sync whatever else wrote meanwhile (the draft).
 */
export function writeDurably<T>(sqlite: Database.Database, write: () => T): T {
  sqlite.pragma("synchronous = FULL");
  try {
    return write();
  } finally {
    sqlite.pragma("synchronous = NORMAL");
  }
}
