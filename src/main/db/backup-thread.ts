import createBackupWorker from "./backup-worker?nodeWorker";
import type { BackupJob, BackupReply } from "./backup-worker";

/** A `backup-worker.ts` job, answered. Its own file, apart from `backups.ts`: the `?nodeWorker` import is
 *  electron-vite's, and the unit suite imports `backups.ts` without it. */
export function runBackupJob(job: BackupJob): Promise<Exclude<BackupReply, { error: string }>> {
  return new Promise((resolve, reject) => {
    const worker = createBackupWorker({ workerData: job });
    worker.once("message", (reply: BackupReply) => {
      if ("error" in reply) reject(new Error(reply.error));
      else resolve(reply);
    });
    worker.once("error", reject);
    // After a reply this settles nothing; without one, the worker died.
    worker.once("exit", (code) => reject(new Error(`The backup thread stopped (exit ${code})`)));
  });
}
