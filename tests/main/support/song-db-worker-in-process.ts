import { EventEmitter } from "node:events";
import { readEasyWorship } from "../../../src/main/songs/easyworship";
import { readOpenLpDatabase } from "../../../src/main/songs/openlp";
import type { SongDbJob, SongDbReply } from "../../../src/main/songs/song-db-worker";

/** `song-db-worker.ts` in this process, for `vi.mock` of its `?nodeWorker` (electron-vite's, which this suite has
 *  not): the same reads, answered on the next turn the way a thread's message comes. */
export default function createSongDbWorker({ workerData: job }: { workerData: SongDbJob }) {
  const worker = Object.assign(new EventEmitter(), { terminate: () => Promise.resolve(0) });
  setImmediate(() => {
    let reply: SongDbReply;
    try {
      reply = { read: "openLp" in job ? readOpenLpDatabase(job.openLp) : readEasyWorship(job.easyWorship, job.locale) };
    } catch (error) {
      reply = { error: error instanceof Error ? error.message : String(error) };
    }
    worker.emit("message", reply);
  });
  return worker;
}
