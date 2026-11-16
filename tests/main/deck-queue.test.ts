import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createDeckQueue, type DeckWorker } from "../../src/main/slides/deck-queue";

type Request = { id: number; file: string };
type Reply = { id: number; read: string } | { id: number; alive: true };

/** Workers that read nothing on their own: a test answers, kills or hangs them. */
function fakeWorkers() {
  const started: (DeckWorker & { posted: Request[]; stopped: number })[] = [];
  const spawn = (): DeckWorker => {
    const worker = Object.assign(new EventEmitter(), {
      posted: [] as Request[],
      stopped: 0,
      postMessage(request: unknown) {
        worker.posted.push(request as Request);
      },
      terminate() {
        worker.stopped++;
        worker.emit("exit", 1);
      },
    });
    started.push(worker);
    return worker;
  };
  return { started, spawn };
}

/** Whatever each promise has settled to so far: `"pending"` until then. */
function track(promises: Promise<Reply | null>[]) {
  const outcome: (Reply | null | "pending")[] = promises.map(() => "pending");
  promises.forEach((promise, at) => void promise.then((reply) => (outcome[at] = reply)));
  return outcome;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("deck queue", () => {
  it("a worker that dies fails only the deck it was reading; the decks waiting go to a new one", async () => {
    const { started, spawn } = fakeWorkers();
    const queue = createDeckQueue<Request, Reply>(spawn, 60_000);
    const asks = ["a.pptx", "b.pptx", "c.pptx"].map((file, at) => queue.ask(file, { id: at + 1, file }, "now"));
    const outcome = track(asks);

    // A crash: Node emits `error`, then `exit`.
    started[0]!.emit("error", new Error("ERR_WORKER_OUT_OF_MEMORY"));
    started[0]!.emit("exit", 1);
    await flush();
    expect(outcome).toEqual([null, "pending", "pending"]);
    expect(started).toHaveLength(2);

    for (let answered = 0; answered < started[1]!.posted.length; answered++) {
      const request = started[1]!.posted[answered]!;
      started[1]!.emit("message", { id: request.id, read: request.file });
      await flush();
    }
    expect(outcome).toEqual([null, { id: 2, read: "b.pptx" }, { id: 3, read: "c.pptx" }]);
  });

  it("a worker silent for the whole limit on one deck is stopped; the deck fails and the next one goes on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { started, spawn } = fakeWorkers();
      const queue = createDeckQueue<Request, Reply>(spawn, 60_000);
      const outcome = track(["a.pptx", "b.pptx", "c.pptx"].map((file, at) => queue.ask(file, { id: at + 1, file }, "now")));

      // `a` is slow but answers: the limit is per deck, from when it is handed over, never from the queue.
      vi.advanceTimersByTime(50_000);
      started[0]!.emit("message", { id: 1, read: "a.pptx" });
      await flush();
      vi.advanceTimersByTime(59_000);
      await flush();
      expect(outcome).toEqual([{ id: 1, read: "a.pptx" }, "pending", "pending"]);
      expect(started[0]!.stopped).toBe(0);

      // `b` hangs it (a loop that never ends): stopped at the limit.
      vi.advanceTimersByTime(1_000);
      await flush();
      expect(started[0]!.stopped).toBe(1);
      expect(outcome).toEqual([{ id: 1, read: "a.pptx" }, null, "pending"]);
      expect(started[1]!.posted).toEqual([{ id: 3, file: "c.pptx" }]);
      started[1]!.emit("message", { id: 3, read: "c.pptx" });
      await flush();
      expect(outcome[2]).toEqual({ id: 3, read: "c.pptx" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a read that beats once per slide is never cut, however long; silent for the limit after a beat, it is", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { started, spawn } = fakeWorkers();
      const queue = createDeckQueue<Request, Reply>(spawn, 60_000);
      const outcome = track([queue.ask("long.pptx", { id: 1, file: "long.pptx" }, "now")]);

      // A slow PC: 50 s a slide, five slides, 250 s in all.
      for (let slide = 0; slide < 5; slide++) {
        vi.advanceTimersByTime(50_000);
        started[0]!.emit("message", { id: 1, alive: true });
      }
      await flush();
      expect(started[0]!.stopped).toBe(0);
      expect(outcome).toEqual(["pending"]);

      // Then one slide that never ends.
      vi.advanceTimersByTime(60_000);
      await flush();
      expect(started[0]!.stopped).toBe(1);
      expect(outcome).toEqual([null]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("copying a deck's clips is not timed: minutes of video off a slow drive are copied to the end", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { started, spawn } = fakeWorkers();
      const queue = createDeckQueue<Request, Reply>(spawn, 60_000);
      const outcome = track([queue.ask("clips.pptx", { id: 1, file: "clips.pptx" }, "now", false)]);
      vi.advanceTimersByTime(10 * 60_000);
      await flush();
      expect(started[0]!.stopped).toBe(0);
      started[0]!.emit("message", { id: 1, read: "clips.pptx" });
      await flush();
      expect(outcome).toEqual([{ id: 1, read: "clips.pptx" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("what the operator asks for goes before the read-ahead, and a read-ahead deck the operator opens moves up", async () => {
    const { started, spawn } = fakeWorkers();
    const queue = createDeckQueue<Request, Reply>(spawn, 60_000);
    const later = ["t1.pptx", "t2.pptx", "t3.pptx", "t4.pptx"].map((file, at) => queue.ask(file, { id: at + 1, file }, "later"));
    const outcome = track([...later, queue.ask("chosen.pptx", { id: 9, file: "chosen.pptx" }, "now")]);
    // The tile the operator clicks was already read ahead: it joins that read, which moves up.
    queue.hurry("t4.pptx");

    const worker = started[0]!;
    for (let answered = 0; answered < worker.posted.length; answered++) {
      const request = worker.posted[answered]!;
      worker.emit("message", { id: request.id, read: request.file });
      await flush();
    }
    expect(worker.posted.map((request) => request.file)).toEqual(["t1.pptx", "chosen.pptx", "t4.pptx", "t2.pptx", "t3.pptx"]);
    expect(outcome.every((reply) => reply !== "pending")).toBe(true);
  });

  it("ignores a reply that is not for the request in flight", async () => {
    const { started, spawn } = fakeWorkers();
    const queue = createDeckQueue<Request, Reply>(spawn, 60_000);
    const outcome = track([queue.ask("a.pptx", { id: 1, file: "a.pptx" }, "now"), queue.ask("b.pptx", { id: 2, file: "b.pptx" }, "now")]);
    started[0]!.emit("message", { id: 7, read: "stray" });
    await flush();
    expect(outcome).toEqual(["pending", "pending"]);
  });
});
