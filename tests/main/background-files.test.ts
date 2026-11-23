/** 2026-11-22 audit, RM2: background `stat`s never take more than two of libuv's four threads. And one `stat` per file
 *  under way, whoever asked, without the operator's ever waiting behind the background's queue (review, RN-6). */
import fs from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { backgroundStat, operatorStat } from "../../src/main/services/background-files";

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
