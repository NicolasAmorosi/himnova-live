/** 2026-11-22 audit, RM2: background `stat`s never take more than two of libuv's four threads. */
import fs from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { backgroundStat } from "../../src/main/services/background-files";

afterEach(() => vi.restoreAllMocks());

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
  const flush = () => new Promise((resolve) => setImmediate(resolve));
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
