import type { EventEmitter } from "node:events";
import type { RasterLane } from "./rasterizer";

/** What `ask` answers for a request stopped by its clock: the file took too long, which says nothing of whether it
 *  can be read (a slow PC, a share that went away). The operator is told so, apart from a damaged file (owner,
 *  2026-11-17). */
export const TOO_SLOW = "too-slow";

/** What the queue needs of the deck worker: a `Worker` is one, and so is a test's fake. */
export type DeckWorker = EventEmitter & { postMessage(request: unknown): void; terminate(): unknown };

/**
 * The requests to the deck worker (`pptx-worker.ts`) and their answers, apart
 * from the worker itself so they can be tested with a fake one. `spawn` starts
 * a worker, the first time something is asked. A request is answered with the
 * worker's reply, `null` when the worker stopped while reading it, or `TOO_SLOW`
 * when its clock stopped it.
 *
 * The queue is here, on main, and the worker gets one request at a time: when
 * it dies, only the deck it was reading fails, and the decks still waiting go
 * to the next worker. When it held them all, every healthy deck behind the bad
 * one failed as damaged with it (2026-11-15 audit, D6).
 *
 * Two lanes, like the PDF rasterizer's: `now`, what the operator is waiting
 * on, goes before `later`, the read-ahead. A deck read ahead as its tile
 * scrolled by waited, when the operator chose it, behind every read queued
 * before it (2026-11-15 audit, R10); `hurry` moves it up.
 *
 * A read is timed by its progress, not as a whole: the worker beats once per
 * slide (`{ id, alive: true }`), and `hangMs` without a beat stops it. A deck
 * timed whole failed on a slow PC that was still reading it (2026-11-15 audit,
 * S4, review). Copying its clips beats once per clip and gets its own, longer
 * window (`ask`'s `hangMs`): untimed, a share that went away held the worker.
 */
export function createDeckQueue<Req extends { id: number }, Reply extends { id: number }>(
  spawn: () => DeckWorker,
  hangMs: number,
) {
  type Answer = Reply | null | typeof TOO_SLOW;
  type Job = { file: string; request: Req; hangMs: number; done: (reply: Answer) => void };
  let worker: DeckWorker | null = null;
  const lanes: Record<RasterLane, Job[]> = { now: [], later: [] };
  let running: Job | null = null;
  let hangTimer: ReturnType<typeof setTimeout> | null = null;

  function finish(reply: Answer): void {
    if (hangTimer) clearTimeout(hangTimer);
    hangTimer = null;
    const job = running;
    running = null;
    job?.done(reply);
    pump();
  }

  function pump(): void {
    if (running) return;
    running = lanes.now.shift() ?? lanes.later.shift() ?? null;
    if (!running) return;
    try {
      current().postMessage(running.request);
    } catch (error) {
      // A worker that can't start (or a request that can't be sent): this deck fails, and the next is tried,
      // instead of `running` held forever with no timer and every later ask never settling.
      console.warn(`[slides] the deck reader could not take ${running.file}: ${String(error)}`);
      finish(null);
      return;
    }
    arm();
  }

  /**
   * A file that never finishes (a loop a crafted SmartArt sends on forever,
   * 2026-11-15 audit, S4) held this deck, every deck after it and «Reintentar»
   * until a restart. Timed from when the worker gets the deck, never from when
   * it was queued (behind a long queue a healthy deck waits for minutes), and
   * armed again at every beat.
   */
  function arm(): void {
    if (hangTimer) clearTimeout(hangTimer);
    hangTimer = null;
    if (!running) return;
    const window = running.hangMs;
    hangTimer = setTimeout(() => {
      const stuck = worker;
      worker = null;
      console.warn(`[slides] the deck reader went ${window / 1000} s without progress on ${running?.file}: stopped`);
      finish(TOO_SLOW);
      void stuck?.terminate();
    }, window);
  }

  function current(): DeckWorker {
    if (worker) return worker;
    const started = spawn();
    started.on("message", (reply: Reply) => {
      if (worker !== started || reply.id !== running?.request.id) return;
      if ("alive" in reply) return arm();
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
    /** Stopped after `windowMs` (the queue's `hangMs` unless given) without a beat. */
    ask(file: string, request: Req, lane: RasterLane, windowMs = hangMs): Promise<Answer> {
      return new Promise((done) => {
        lanes[lane].push({ file, request, hangMs: windowMs, done });
        pump();
      });
    },
    /** The read-ahead of `file` still waiting goes to the `now` lane, in the order it was asked. */
    hurry(file: string): void {
      const moving = lanes.later.filter((job) => job.file === file);
      if (moving.length === 0) return;
      lanes.later = lanes.later.filter((job) => job.file !== file);
      lanes.now.push(...moving);
    },
  };
}
