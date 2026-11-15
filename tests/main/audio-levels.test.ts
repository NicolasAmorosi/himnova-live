/** The audio strips' meters, main's half (`media/audio-levels.ts`): each bus is the loudest of its sources after their
 *  gain, and the control windows hear it only while something sounds. */
import { afterEach, expect, test, vi } from "vitest";

const sent = vi.hoisted(() => [] as unknown[]);
vi.mock("../../src/main/services/broadcast", () => ({ broadcast: (_channel: string, payload: unknown) => sent.push(payload) }));

const { heardAt, mixBuses, reportLevel } = await import("../../src/main/media/audio-levels");

afterEach(() => {
  vi.useRealTimers();
  sent.length = 0;
});

test("a source is heard through its linear gain, and at 0 not at all", () => {
  // Fails if the gain is left out (the meter would show the file, not the room) or taken as mpv's cubic volume.
  const [left] = heardAt([-12, -12], 0.5);
  expect(left).toBeCloseTo(-18.02, 2);
  expect(heardAt([-12, -12], 0)).toEqual([-Infinity, -Infinity]);
  expect(heardAt([-12, -12], Number.NaN)).toEqual([-Infinity, -Infinity]);
});

test("each bus is the loudest of its own sources per side; a stale or inaudible one counts as silence", () => {
  vi.useFakeTimers({ now: 10_000 });
  reportLevel("engine", "live", [-20, -6]);
  reportLevel("projector", "live", [-12, -30]);
  reportLevel("preview", "preview", [-95, -40]);
  expect(mixBuses(10_000)).toEqual({ live: [-12, -6], preview: [-Infinity, -40] });
  // An engine that quit without a word stops counting.
  vi.setSystemTime(10_150);
  reportLevel("projector", "live", [-12, -30]);
  expect(mixBuses(10_300)).toEqual({ live: [-12, -30], preview: [-Infinity, -Infinity] });
  vi.advanceTimersByTime(1000);
});

test("the control windows hear the buses every 40 ms while something sounds, then once silent, then nothing", () => {
  vi.useFakeTimers({ now: 0 });
  // Fails if it keeps sending while nothing plays, or never says it stopped (a meter stuck lit).
  for (let t = 0; t < 200; t += 40) {
    reportLevel("engine", "live", [-12, -12]);
    vi.advanceTimersByTime(40);
  }
  expect(sent).toHaveLength(5);
  expect(sent.at(-1)).toEqual({ live: [-12, -12], preview: [-Infinity, -Infinity] });
  reportLevel("engine", "live", [-120, -120]);
  vi.advanceTimersByTime(1000);
  expect(sent).toHaveLength(6);
  expect(sent.at(-1)).toEqual({ live: [-Infinity, -Infinity], preview: [-Infinity, -Infinity] });
  // Muted LIVE: the engine still reports, nothing crosses.
  for (let t = 0; t < 200; t += 40) {
    reportLevel("engine", "live", heardAt([-12, -12], 0));
    vi.advanceTimersByTime(40);
  }
  expect(sent).toHaveLength(6);
});
