import type { Worker } from "node:worker_threads";
import { ooxmlDir } from "../paths";
import createPptxWorker from "./pptx-worker?nodeWorker";
import type { PptxRead, PptxReply, PptxRequest } from "./pptx-worker";

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
const waiting = new Map<number, { file: string; done: (read: PptxRead | null) => void }>();

function pptxWorker(): Worker {
  if (worker) return worker;
  const started = createPptxWorker({ workerData: { ooxmlDir } });
  // Never what keeps the process alive: quitting doesn't wait for a read.
  started.unref();
  started.on("message", (reply: PptxReply) => {
    const request = waiting.get(reply.id);
    waiting.delete(reply.id);
    if ("error" in reply) console.warn(`[slides] no reader could open ${request?.file}: ${reply.error}`);
    request?.done("read" in reply ? reply.read : null);
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

export function readPptx(sourcePath: string): Promise<PptxRead | null> {
  return new Promise((done) => {
    const id = ++nextId;
    waiting.set(id, { file: sourcePath, done });
    pptxWorker().postMessage({ id, file: sourcePath } satisfies PptxRequest);
  });
}
