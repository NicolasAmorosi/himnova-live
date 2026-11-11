import { expect, test } from "vitest";
import { jsonLineReader, mpvVolume } from "../../src/main/media/engine-protocol";

test("the panel's volume reaches mpv on its cube-root scale", () => {
  // Fails if every engine file goes silent (M03), or if 30 % is sent linearly and plays at 2.7 %.
  expect([0, 0.3, 1].map(mpvVolume)).toEqual([0, 67, 100]);
  // Fails if a value out of 0..1 reaches mpv, which amplifies up to 130.
  expect([-1, 2].map(mpvVolume)).toEqual([0, 100]);
});

test("an event split across stdout chunks arrives once, whole; a line that is not JSON is skipped", () => {
  const events: unknown[] = [];
  const read = jsonLineReader((event) => events.push(event));
  read('{"ev":"status","time":8,"duration":8,"pau');
  read('sed":true,"ended":true}\nlibmpv: a warning\n{"ev":"fr');
  read('ame","slot":2}\n');
  // Fails if a partial line is parsed or dropped: an engine's `ended` (or a frame) would be lost.
  expect(events).toEqual([
    { ev: "status", time: 8, duration: 8, paused: true, ended: true },
    { ev: "frame", slot: 2 },
  ]);
});
