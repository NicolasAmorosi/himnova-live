/** 2026-11-22 audit, RM2: background `stat`s never take more than two of libuv's four threads. And one `stat` per file
 *  under way, whoever asked, without the operator's ever waiting behind the background's queue (review, RN-6). */
import fs from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { backgroundStat, operatorStat } from "../../src/main/services/background-files";
import { backfillContentHashes } from "../../src/main/media/content-hash";

const hashed = vi.hoisted(() => ({ pending: [] as { id: number; path: string }[] }));
vi.mock("../../src/main/services/repos", () => ({
  getMediaRepo: () => ({ assetsNeedingContentHash: () => hashed.pending.splice(0), setContentHash: () => undefined }),
}));
vi.mock("../../src/main/services/broadcast", () => ({ broadcast: () => undefined }));

afterEach(() => vi.restoreAllMocks());

/** `fs.promises.stat` held until the test answers it, by file. */
function holdStats() {
  const started: string[] = [];
  const running = new Map<string, () => void>();
  vi.spyOn(fs.promises, "stat").mockImplementation(
    (file) =>
      new Promise((resolve) => {
        started.push(String(file));
        running.set(String(file), () => {
          running.delete(String(file));
          resolve({} as fs.Stats);
        });
      }),
  );
  return { started, running };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a fan-out of background stats runs two at a time, in order, and every one settles", async () => {
  const started: string[] = [];
  const running = new Map<string, () => void>();
  let most = 0;
  vi.spyOn(fs.promises, "stat").mockImplementation(
    (file) =>
      new Promise((resolve, reject) => {
        const name = String(file);
        started.push(name);
        running.set(name, () => {
          running.delete(name);
          if (name.endsWith("gone")) reject(new Error("ENOENT"));
          else resolve({} as fs.Stats);
        });
        most = Math.max(most, running.size);
      }),
  );
  const results = ["a", "b-gone", "c", "d", "e"].map((file) => backgroundStat(file).then(() => "ok", () => "gone"));

  await flush();
  expect(started).toEqual(["a", "b-gone"]);
  running.get("b-gone")!();
  await flush();
  // One arriving now waits behind the queue, not beside the two running.
  const late = backgroundStat("f").then(() => "ok");
  await flush();
  expect(started).toEqual(["a", "b-gone", "c"]);
  while (running.size > 0) {
    [...running.values()][0]!();
    await flush();
  }
  expect(await Promise.all([...results, late])).toEqual(["ok", "gone", "ok", "ok", "ok", "ok"]);
  expect(started).toEqual(["a", "b-gone", "c", "d", "e", "f"]);
  expect(most).toBe(2);
});

test("the operator's stat starts at once past a full queue, and every asker of a file shares the one under way", async () => {
  const { started, running } = holdStats();
  const background = ["a", "b", "c"].map((file) => backgroundStat(file).then(() => file));
  await flush();
  expect(started).toEqual(["a", "b"]);

  // «c» waits for a thread in the background: the operator's does not wait with it, and asked twice is one stat.
  const operator = operatorStat("c");
  const again = operatorStat("c");
  void backgroundStat("b");
  await flush();
  expect(started).toEqual(["a", "b", "c"]);

  // A thread frees: the background's «c» joins the operator's, still under way, instead of a second stat.
  running.get("a")!();
  await flush();
  expect(started).toEqual(["a", "b", "c"]);
  running.get("c")!();
  await Promise.all([operator, again]);
  running.get("b")!();
  expect(await Promise.all(background)).toEqual(["a", "b", "c"]);
  expect(started).toEqual(["a", "b", "c"]);
});

test("the operator never joins a stat the background started, which may answer only when the system gives up", async () => {
  // The sweep stats «x» while the share is down; the share comes back; the operator asks «x»: a stat of its own answers
  // at once, where the sweep's waits out the 21 s Windows takes to give up (2026-11-22 review, RN-6).
  const answers: (() => void)[] = [];
  const stats = vi
    .spyOn(fs.promises, "stat")
    .mockImplementation(() => new Promise((resolve) => answers.push(() => resolve({} as fs.Stats))));
  const sweep = backgroundStat("x");
  await flush();
  const operator = operatorStat("x");
  expect(stats).toHaveBeenCalledTimes(2);
  // The sweep's gives up first, and does not take the operator's place: the next asks of «x» join the operator's.
  answers[0]!();
  await sweep;
  const joined = [operatorStat("x"), backgroundStat("x")];
  expect(stats).toHaveBeenCalledTimes(2);
  answers[1]!();
  await Promise.all([operator, ...joined]);
});

test("the operator's asks of a file that never answers hold two threads at most, never one per click", async () => {
  // «Reintentar» every 3 s on a share that never answers started a stat each time, and four clicks filled libuv's four
  // threads, the ones the projector reads from (2026-11-22 review, RN3-1). The second still starts its own (RN2-1).
  const answers: ((fail?: boolean) => void)[] = [];
  const stats = vi.spyOn(fs.promises, "stat").mockImplementation(
    () =>
      new Promise((resolve, reject) =>
        answers.push((fail) => (fail ? reject(new Error("ETIMEDOUT")) : resolve({} as fs.Stats))),
      ),
  );
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const file = "//nas/hymns/522.pps";
  const asks: Promise<fs.Stats>[] = [];
  for (let click = 0; click < 6; click++) {
    asks.push(operatorStat(file));
    now += 3000;
  }
  expect(stats).toHaveBeenCalledTimes(2);
  expect(asks[1]).not.toBe(asks[0]);
  expect(asks.slice(2).every((ask) => ask === asks[1])).toBe(true);

  // The first gives up: one of theirs is left, so the next click starts its own again.
  answers[0]!(true);
  await asks[0]!.catch(() => null);
  const retry = operatorStat(file);
  expect(stats).toHaveBeenCalledTimes(3);
  expect(retry).not.toBe(asks[1]);
  answers[1]!();
  answers[2]!();
  await Promise.all([...asks.slice(1), retry]);
  // None left under way: the count fell back to nothing, so the next two clicks start one each again.
  const later = operatorStat(file);
  now += 3000;
  const again = operatorStat(file);
  expect(stats).toHaveBeenCalledTimes(5);
  answers[3]!();
  answers[4]!();
  await Promise.all([later, again]);
});

test("the startup content hash stats with the background, never on a third thread beside its two", async () => {
  // A presentation on a share that went away held a thread of its own until the system gave up (review, RN2-8).
  const { started, running } = holdStats();
  const sweep = [backgroundStat("s1"), backgroundStat("s2")];
  hashed.pending = [{ id: 1, path: "hymn.pps" }];
  const backfill = backfillContentHashes();
  await flush();
  expect(started).toEqual(["s1", "s2"]);
  running.get("s1")!();
  await vi.waitFor(() => expect(started).toEqual(["s1", "s2", "hymn.pps"]));
  // Its stat answers and its read fails (no such file): skipped, as before.
  running.get("hymn.pps")!();
  running.get("s2")!();
  await Promise.all([backfill, ...sweep]);
});
