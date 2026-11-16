import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createDeckQueue, type DeckWorker } from "../../src/main/slides/deck-queue";

type Request = { id: number; file: string };
type Reply = { id: number; read: string };

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
    const asks = ["a.pptx", "b.pptx", "c.pptx"].map((file, at) => queue.ask(file, { id: at + 1, file }));
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
      const outcome = track(["a.pptx", "b.pptx", "c.pptx"].map((file, at) => queue.ask(file, { id: at + 1, file })));

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

  it("ignores a reply that is not for the request in flight", async () => {
    const { started, spawn } = fakeWorkers();
    const queue = createDeckQueue<Request, Reply>(spawn, 60_000);
    const outcome = track([queue.ask("a.pptx", { id: 1, file: "a.pptx" }), queue.ask("b.pptx", { id: 2, file: "b.pptx" })]);
    started[0]!.emit("message", { id: 7, read: "stray" });
    await flush();
    expect(outcome).toEqual(["pending", "pending"]);
  });
});
