import { dbPath } from "../../paths";
import { mainLocale } from "../../i18n";
import { BibleFormatError } from "./bible-formats";
import type { SeedBibleOptions } from "./seed-bible";
import createSeedBibleWorker from "./seed-bible-worker?nodeWorker";
import type { SeedBibleJob, SeedBibleReply } from "./seed-bible-worker";

/** `seedBibleFromFile` on a worker thread (`seed-bible-worker.ts`): what `bible:import` and
 *  `bible:installBundled` run, so a video of the engine on air never stops for a Bible. Its errors come back
 *  as they were thrown there — a `BibleFormatError` stays one, with its message for the operator. */
export function seedBibleOffThread(
  filePath: string,
  options: SeedBibleOptions,
): Promise<{ versionId: number; verseCount: number } | null> {
  return new Promise((resolve, reject) => {
    const job: SeedBibleJob = { dbPath, filePath, options, locale: mainLocale() };
    const worker = createSeedBibleWorker({ workerData: job });
    worker.once("message", (reply: SeedBibleReply) => {
      if ("error" in reply) reject(reply.format ? new BibleFormatError(reply.error) : new Error(reply.error));
      else resolve(reply.seeded);
    });
    worker.once("error", reject);
    // After a reply this settles nothing; without one, the worker died.
    worker.once("exit", (code) => reject(new Error(`The Bible install thread stopped (exit ${code})`)));
  });
}
