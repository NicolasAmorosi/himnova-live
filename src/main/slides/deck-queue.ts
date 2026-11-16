import type { EventEmitter } from "node:events";

/** What the queue needs of the deck worker: a `Worker` is one, and so is a test's fake. */
export type DeckWorker = EventEmitter & { postMessage(request: unknown): void; terminate(): unknown };

/**
 * The requests to the deck worker (`pptx-worker.ts`) and their answers, apart
 * from the worker itself so they can be tested with a fake one. `spawn` starts
 * a worker, the first time something is asked. A request is answered with the
 * worker's reply, or `null` when the worker stopped before replying.
 */
export function createDeckQueue<Req extends { id: number }, Reply extends { id: number }>(spawn: () => DeckWorker) {
  let worker: DeckWorker | null = null;
  const waiting = new Map<number, { file: string; done: (reply: Reply | null) => void }>();

  function current(): DeckWorker {
    if (worker) return worker;
    const started = spawn();
    started.on("message", (reply: Reply) => {
      const request = waiting.get(reply.id);
      waiting.delete(reply.id);
      if ("error" in reply) console.warn(`[slides] no reader could open ${request?.file}: ${String(reply.error)}`);
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

  return {
    ask(file: string, request: Req): Promise<Reply | null> {
      return new Promise((done) => {
        waiting.set(request.id, { file, done });
        current().postMessage(request);
      });
    },
  };
}
