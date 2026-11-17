/**
 * Backup jobs run one at a time (`runBackupJob`): the daily copy and «Hacer una copia» write into the same folder, and
 * a snapshot starts by deleting every `.partial` there (2026-11-15 audit, R1). The thread itself is electron-vite's
 * `?nodeWorker`, replaced here by a worker that answers what each test says, or never.
 */
import { expect, test, vi } from "vitest";
import type { BackupJob, BackupReply } from "../../src/main/db/backup-worker";
import { runBackupJob } from "../../src/main/db/backup-thread";

const h = vi.hoisted(() => ({
  /** What the worker for each job answers; `undefined` = it never does (a copy read from a share that hangs). */
  answer: (_job: unknown): unknown => undefined,
}));

vi.mock("../../src/main/db/backup-worker?nodeWorker", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: ({ workerData }: { workerData: BackupJob }) => {
      const worker = new EventEmitter();
      const reply = h.answer(workerData);
      if (reply !== undefined) setTimeout(() => worker.emit("message", reply));
      return worker;
    },
  };
});

const snapshot: BackupJob = { op: "snapshot", dbPath: "/db", dir: "/daily", keep: 7 };
const stage: BackupJob = { op: "stage", source: "/copy.db", staged: "/restore-pending/worship.db", newestMigration: null };
const ok: BackupReply = { snapshot: { status: "ok", path: "/daily/copy.db" } };

test("a job that failed does not stop the next one", async () => {
  h.answer = (job) => ((job as { dir?: string }).dir === "/full" ? { error: "disk full" } : ok);
  const failed = runBackupJob({ ...snapshot, dir: "/full" });
  // Asked while the failed one still runs: it waits for it, then runs.
  const next = runBackupJob(snapshot);

  await expect(failed).rejects.toThrow("disk full");
  await expect(next).resolves.toEqual(ok);
});

test("a restore read from a share that hangs holds neither a copy nor another restore", async () => {
  // «Restaurar» writes only into restore-pending/, apart from the copies. Chained, one that never answered held every
  // «Hacer una copia» and «Restaurar» after it for the rest of the session (review follow-up).
  h.answer = (job) => {
    const { op, source } = job as { op: string; source?: string };
    return op === "snapshot" ? ok : source === "/share/copy.db" ? undefined : { refused: null };
  };
  void runBackupJob({ ...stage, source: "/share/copy.db" });
  const held = new Promise((resolve) => setTimeout(() => resolve("held behind the restore"), 1000));

  await expect(Promise.race([runBackupJob(snapshot), held])).resolves.toEqual(ok);
  await expect(Promise.race([runBackupJob(stage), held])).resolves.toEqual({ refused: null });
});
