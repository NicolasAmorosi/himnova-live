import { parentPort, workerData } from "node:worker_threads";
import type { Locale } from "@shared/types/settings";
import { openDatabase } from "../client";
import { BibleRepo } from "../repositories/bible.repo";
import { setMainLocale } from "../../i18n";
import { BibleFormatError } from "./bible-formats";
import { seedBibleFromFile, type SeedBibleOptions } from "./seed-bible";

/**
 * A Bible installed or imported off the main thread (2026-11-10 review, agent1-03): reading a version and
 * writing its ~31 000 rows held main ~260 ms, and every media-engine frame crosses main — a video on air froze
 * that long. Here it runs on a connection of its own: main keeps reading (WAL), and a write of main's waits
 * for this one transaction (`busy_timeout`). One worker per job, gone once it answers (`seed-bible-thread.ts`).
 *
 * Deleting a version runs here too: the FTS trigger `bible_verses_ad` fires once per verse, 90 to 300 ms for a
 * whole Bible on an M-series Mac, all of it on main before (2026-11-15 audit, R17).
 */
export type SeedBibleJob =
  | { dbPath: string; filePath: string; options: SeedBibleOptions; locale: Locale }
  | { dbPath: string; deleteVersionId: number; locale: Locale };
export type SeedBibleReply =
  | { seeded: { versionId: number; verseCount: number } | null }
  | { deleted: number }
  /** `detail`: what the parser or the disk said under the operator's message, for main's log (EC-2). */
  | { error: string; format: boolean; detail: string };

const job = workerData as SeedBibleJob;
// The reader's errors reach a toast: in the operator's language, like on main.
setMainLocale(job.locale);
const { sqlite, db } = openDatabase(job.dbPath);
let reply: SeedBibleReply;
try {
  if ("deleteVersionId" in job) {
    new BibleRepo(db, sqlite).deleteVersion(job.deleteVersionId);
    reply = { deleted: job.deleteVersionId };
  } else {
    reply = { seeded: seedBibleFromFile(db, sqlite, job.filePath, job.options) };
  }
} catch (error) {
  reply = {
    error: error instanceof Error ? error.message : String(error),
    format: error instanceof BibleFormatError,
    detail: String(error instanceof Error && error.cause !== undefined ? error.cause : error),
  };
} finally {
  sqlite.close();
}
parentPort?.postMessage(reply);
