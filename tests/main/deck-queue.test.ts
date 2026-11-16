import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createDeckQueue, type DeckWorker } from "../../src/main/slides/deck-queue";

type Request = { id: number; file: string };
type Reply = { id: number; read: string };

/** Workers that read nothing on their own: a test answers, kills or hangs them. */
function fakeWorkers() {
  const started: (DeckWorker & { posted: Request[] })[] = [];
  const spawn = (): DeckWorker => {
    const worker = Object.assign(new EventEmitter(), {
      posted: [] as Request[],
      postMessage(request: unknown) {
        worker.posted.push(request as Request);
      },
      terminate: vi.fn(() => {
        worker.emit("exit", 1);
      }),
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
    const queue = createDeckQueue<Request, Reply>(spawn);
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

  it("ignores a reply that is not for the request in flight", async () => {
    const { started, spawn } = fakeWorkers();
    const queue = createDeckQueue<Request, Reply>(spawn);
    const outcome = track([queue.ask("a.pptx", { id: 1, file: "a.pptx" }), queue.ask("b.pptx", { id: 2, file: "b.pptx" })]);
    started[0]!.emit("message", { id: 7, read: "stray" });
    await flush();
    expect(outcome).toEqual(["pending", "pending"]);
  });
});
