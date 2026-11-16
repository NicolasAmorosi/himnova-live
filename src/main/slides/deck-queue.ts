import type { EventEmitter } from "node:events";

/** What the queue needs of the deck worker: a `Worker` is one, and so is a test's fake. */
export type DeckWorker = EventEmitter & { postMessage(request: unknown): void; terminate(): unknown };

/**
 * The requests to the deck worker (`pptx-worker.ts`) and their answers, apart
 * from the worker itself so they can be tested with a fake one. `spawn` starts
 * a worker, the first time something is asked. A request is answered with the
 * worker's reply, or `null` when the worker stopped while reading it.
 *
 * The queue is here, on main, and the worker gets one request at a time: when
 * it dies, only the deck it was reading fails, and the decks still waiting go
 * to the next worker. When it held them all, every healthy deck behind the bad
 * one failed as damaged with it (2026-11-15 audit, D6).
 */
export function createDeckQueue<Req extends { id: number }, Reply extends { id: number }>(
  spawn: () => DeckWorker,
  hangMs: number,
) {
  type Job = { file: string; request: Req; done: (reply: Reply | null) => void };
  let worker: DeckWorker | null = null;
  const queued: Job[] = [];
  let running: Job | null = null;
  let hangTimer: ReturnType<typeof setTimeout> | null = null;

  function finish(reply: Reply | null): void {
    if (hangTimer) clearTimeout(hangTimer);
    hangTimer = null;
    const job = running;
    running = null;
    job?.done(reply);
    pump();
  }

  function pump(): void {
    if (running) return;
    running = queued.shift() ?? null;
    if (!running) return;
    current().postMessage(running.request);
    // A file that never finishes (a loop a crafted SmartArt sends on forever,
    // 2026-11-15 audit, S4) held this deck, every deck after it and «Reintentar»
    // until a restart. Timed from when the worker gets the deck, never from
    // when it was queued: behind a long queue a healthy deck waits for minutes.
    hangTimer = setTimeout(() => {
      const stuck = worker;
      worker = null;
      console.warn(`[slides] the deck reader took over ${hangMs / 1000} s on ${running?.file}: stopped`);
      finish(null);
      void stuck?.terminate();
    }, hangMs);
  }

  function current(): DeckWorker {
    if (worker) return worker;
    const started = spawn();
    started.on("message", (reply: Reply) => {
      if (worker !== started || reply.id !== running?.request.id) return;
      if ("error" in reply) console.warn(`[slides] no reader could open ${running.file}: ${String(reply.error)}`);
      finish(reply);
    });
    // A crash emits `error` and then `exit`: the second finds `worker` already
    // moved on, and leaves alone the request the next worker is reading.
    const lost = (why: string): void => {
      if (worker !== started) return;
      worker = null;
      if (running) console.warn(`[slides] the deck reader stopped (${why}) while reading ${running.file}`);
      finish(null);
    };
    started.on("error", (error) => lost(String(error)));
    started.on("exit", (code) => lost(`exit ${code}`));
    worker = started;
    return started;
  }

  return {
    ask(file: string, request: Req): Promise<Reply | null> {
      return new Promise((done) => {
        queued.push({ file, request, done });
        pump();
      });
    },
  };
}
