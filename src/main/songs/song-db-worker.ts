import { parentPort, workerData } from "node:worker_threads";
import type { Locale } from "@shared/types/settings";
import { readEasyWorship, type SongsRead } from "./easyworship";
import { readOpenLpDatabase } from "./openlp";

/**
 * An OpenLP or EasyWorship song database read off the main thread (2026-11-22 audit, SE3): its SQL is a file's
 * from anywhere, and a query that never ends held main, and the projector with it, for good. Here it holds only
 * this thread, and `song-import.ts` stops waiting at its clock. Only the read: the songs go back to main, which
 * writes them. One worker per database, gone once it answers.
 */
export type SongDbJob = { openLp: string } | { easyWorship: string; locale: Locale };
export type SongDbReply = { read: SongsRead } | { error: string };

const job = workerData as SongDbJob;
let reply: SongDbReply;
try {
  reply = { read: "openLp" in job ? readOpenLpDatabase(job.openLp) : readEasyWorship(job.easyWorship, job.locale) };
} catch (error) {
  reply = { error: error instanceof Error ? error.message : String(error) };
}
parentPort?.postMessage(reply);
