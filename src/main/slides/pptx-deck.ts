import { ooxmlDir } from "../paths";
import { createDeckQueue } from "./deck-queue";
import createPptxWorker from "./pptx-worker?nodeWorker";
import type { PptxClips, PptxExtract, PptxRead, PptxReply, PptxRequest } from "./pptx-worker";

export type { PptxRead } from "./pptx-worker";

/**
 * Reads a deck into its model in `pptx-worker.ts`, one deck after another on
 * one worker thread, started with the first deck. `null` when the file can't be
 * read as a presentation at all, or when the worker died on it: that deck
 * fails as unreadable, and is never retried here on main, where the same file
 * would take the whole app down instead of one thread.
 */
const queue = createDeckQueue<PptxRequest, PptxReply>(() => {
  const started = createPptxWorker({ workerData: { ooxmlDir } });
  // Never what keeps the process alive: quitting doesn't wait for a read.
  started.unref();
  return started;
});
let nextId = 0;

export async function readPptx(sourcePath: string): Promise<PptxRead | null> {
  const reply = await queue.ask(sourcePath, { id: ++nextId, file: sourcePath });
  return reply && "read" in reply ? reply.read : null;
}

/** The deck's embedded sound and video, copied into its cache on the worker thread. `null` when the
 *  worker could not (the deck then goes without them, as with a part that won't read). */
export async function extractClips(extract: PptxExtract): Promise<PptxClips | null> {
  const reply = await queue.ask(extract.file, { id: ++nextId, extract });
  return reply && "clips" in reply ? reply.clips : null;
}
