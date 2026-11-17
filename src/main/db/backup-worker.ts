import { parentPort, workerData } from "node:worker_threads";
import { dailyBackup, takeSnapshot, type BackupResult } from "./migrate";
import { stageRestore, type RestoreRefusal } from "./backups";

/**
 * A copy of the database taken (the daily one, or «Hacer una copia»), or one staged for a restore, off the main
 * thread: on this Mac's 90 MB profile `VACUUM INTO` held the thread 453 ms and `integrity_check` 486 ms
 * (2026-11-13), and every media-engine frame crosses main, so a video on air froze that long. Its own connections;
 * main keeps reading (WAL). One worker per job, gone once it answers (`backup-thread.ts`).
 */
export type BackupJob =
  | { op: "snapshot"; dbPath: string; dir: string; keep: number }
  | { op: "daily"; dbPath: string; dir: string }
  | { op: "stage"; source: string; staged: string; newestMigration: number | null };
export type BackupReply = { snapshot: BackupResult } | { refused: RestoreRefusal | null } | { error: string };

const job = workerData as BackupJob;
let reply: BackupReply;
try {
  reply =
    job.op === "snapshot"
      ? { snapshot: takeSnapshot(job.dbPath, job.dir, job.keep, new Date()) }
      : job.op === "daily"
        ? { snapshot: dailyBackup(job.dbPath, job.dir) }
        : { refused: stageRestore(job.source, job.staged, job.newestMigration) };
} catch (error) {
  reply = { error: error instanceof Error ? error.message : String(error) };
}
parentPort?.postMessage(reply);
