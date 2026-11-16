import createBackupWorker from "./backup-worker?nodeWorker";
import type { BackupJob, BackupReply } from "./backup-worker";

/** The job before this one, settled or not: jobs run one at a time. The daily copy and «Hacer una copia» both write
 *  into `daily/`, and `takeSnapshot` starts by deleting every `.partial` there, the other job's copy in progress
 *  included (2026-11-15 audit, R1). */
let chain: Promise<unknown> = Promise.resolve();

/** A `backup-worker.ts` job, answered, after every job asked before it. Its own file, apart from `backups.ts`: the
 *  `?nodeWorker` import is electron-vite's, and the unit suite imports `backups.ts` without it. */
export function runBackupJob(job: BackupJob): Promise<Exclude<BackupReply, { error: string }>> {
  const run = chain.then(
    () =>
      new Promise<Exclude<BackupReply, { error: string }>>((resolve, reject) => {
        const worker = createBackupWorker({ workerData: job });
        worker.once("message", (reply: BackupReply) => {
          if ("error" in reply) reject(new Error(reply.error));
          else resolve(reply);
        });
        worker.once("error", reject);
        // After a reply this settles nothing; without one, the worker died.
        worker.once("exit", (code) => reject(new Error(`The backup thread stopped (exit ${code})`)));
      }),
  );
  // A job that failed must not stop the ones after it.
  chain = run.catch(() => undefined);
  return run;
}
