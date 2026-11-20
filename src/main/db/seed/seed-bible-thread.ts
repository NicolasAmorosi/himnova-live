import { dbPath } from "../../paths";
import { mainLocale } from "../../i18n";
import { BibleFormatError } from "./bible-formats";
import type { SeedBibleOptions } from "./seed-bible";
import createSeedBibleWorker from "./seed-bible-worker?nodeWorker";
import type { SeedBibleJob, SeedBibleReply } from "./seed-bible-worker";

/** One `seed-bible-worker.ts` job, answered. Its errors come back as they were thrown there: a
 *  `BibleFormatError` stays one, with its message for the operator. */
function runBibleJob(job: SeedBibleJob): Promise<Exclude<SeedBibleReply, { error: string }>> {
  return new Promise((resolve, reject) => {
    const worker = createSeedBibleWorker({ workerData: job });
    worker.once("message", (reply: SeedBibleReply) => {
      if ("error" in reply) reject(reply.format ? new BibleFormatError(reply.error) : new Error(reply.error));
      else resolve(reply);
    });
    worker.once("error", reject);
    // After a reply this settles nothing; without one, the worker died.
    worker.once("exit", (code) => reject(new Error(`The Bible install thread stopped (exit ${code})`)));
  });
}

/** `seedBibleFromFile` on a worker thread: what `bible:import` and `bible:installBundled` run, so a video of the
 *  engine on air never stops for a Bible. */
export async function seedBibleOffThread(
  filePath: string,
  options: SeedBibleOptions,
): Promise<{ versionId: number; verseCount: number } | null> {
  const reply = await runBibleJob({ dbPath, filePath, options, locale: mainLocale() });
  return "seeded" in reply ? reply.seeded : null;
}

/** `BibleRepo.deleteVersion` on the same thread, for the same reason: `bible:delete`. */
export async function deleteBibleVersionOffThread(versionId: number): Promise<void> {
  await runBibleJob({ dbPath, deleteVersionId: versionId, locale: mainLocale() });
}
