import type { Worker } from "node:worker_threads";
import { ooxmlDir } from "../paths";
import createPptxWorker from "./pptx-worker?nodeWorker";
import type { PptxClips, PptxExtract, PptxRead, PptxReply, PptxRequest } from "./pptx-worker";

export type { PptxRead } from "./pptx-worker";

/**
 * Reads a deck into its model in `pptx-worker.ts`, one deck after another on
 * one worker thread, started with the first deck. `null` when the file can't be
 * read as a presentation at all — or when the worker died on it: that deck
 * fails as unreadable, and is never retried here on main, where the same file
 * would take the whole app down instead of one thread.
 */
let worker: Worker | null = null;
let nextId = 0;
const waiting = new Map<number, { file: string; done: (reply: PptxReply | null) => void }>();

function pptxWorker(): Worker {
  if (worker) return worker;
  const started = createPptxWorker({ workerData: { ooxmlDir } });
  // Never what keeps the process alive: quitting doesn't wait for a read.
  started.unref();
  started.on("message", (reply: PptxReply) => {
    const request = waiting.get(reply.id);
    waiting.delete(reply.id);
    if ("error" in reply) console.warn(`[slides] no reader could open ${request?.file}: ${reply.error}`);
    request?.done(reply);
  });
  const lost = (why: string): void => {
    if (worker !== started) return;
    worker = null;
    for (const [id, request] of waiting) {
      console.warn(`[slides] the deck reader stopped (${why}) while reading ${request.file}`);
      waiting.delete(id);
      request.done(null);
    }
  };
  started.on("error", (error) => lost(String(error)));
  started.on("exit", (code) => lost(`exit ${code}`));
  worker = started;
  return started;
}

function ask(file: string, request: PptxRequest): Promise<PptxReply | null> {
  return new Promise((done) => {
    waiting.set(request.id, { file, done });
    pptxWorker().postMessage(request);
  });
}

export async function readPptx(sourcePath: string): Promise<PptxRead | null> {
  const reply = await ask(sourcePath, { id: ++nextId, file: sourcePath });
  return reply && "read" in reply ? reply.read : null;
}

/** The deck's embedded sound and video, copied into its cache on the worker thread. `null` when the
 *  worker could not (the deck then goes without them, as with a part that won't read). */
export async function extractClips(extract: PptxExtract): Promise<PptxClips | null> {
  const reply = await ask(extract.file, { id: ++nextId, extract });
  return reply && "clips" in reply ? reply.clips : null;
}
