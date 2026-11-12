/**
 * The media engine's frames on the page's clock (`FramePacer`): each frame up for its share of refreshes,
 * whatever the jitter of its arrival — measured on the real projector, drawn-on-arrival lost up to 45 %.
 */
import { expect, test } from "vitest";
import { FramePacer } from "@renderer/lib/frame-pacer";

/** Plays `seconds` of a `fps` video into a `hz` display with ±`jitterMs` arrival jitter; returns, per
 *  frame, how many refreshes it stayed up, and how many frames never went up. */
function play(fps: number, hz: number, jitterMs: number, seconds = 10, seed = 7) {
  let random = seed;
  const noise = () => ((random = (random * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * jitterMs;
  const arrivals = Array.from({ length: Math.floor(seconds * fps) }, (_, i) => 3 + (i * 1000) / fps + noise()).sort((a, b) => a - b);
  return present(arrivals, hz, seconds);
}

/** `arrivals` (ms) through the pacer and `EngineVideo`'s queue of 3 into a `hz` display. */
function present(arrivals: number[], hz: number, seconds: number) {
  const pacer = new FramePacer();
  const queue: number[] = [];
  const shown: number[] = [];
  let next = 0;
  let dropped = 0;
  for (let tick = 0; tick < seconds * hz; tick += 1) {
    const now = (tick * 1000) / hz;
    while (next < arrivals.length && arrivals[next]! <= now) {
      if (!pacer.arrived(arrivals[next]!)) {
        next += 1;
        continue;
      }
      if (queue.length === 3) {
        queue.shift();
        dropped += 1;
      }
      queue.push(next++);
    }
    if (pacer.tick(now, queue.length)) shown.push(queue.shift()!, tick);
  }
  const ticks = shown.filter((_, i) => i % 2 === 1);
  const held = ticks.slice(1).map((t, i) => t - ticks[i]!);
  return { held: held.slice(10), dropped, frames: shown.length / 2, order: shown.filter((_, i) => i % 2 === 0) };
}

/** Engine starts of a 30 fps clip as measured on the Mac (2026-11-12): the first intervals between frames, a
 *  burst of 2–6 ms among them, then the clip's own ~33 ms. Seeded by that burst, the pacer took the clip for a
 *  source over 40 fps and showed every other frame for ~0.6 s — the 0, 1, 5, 6, 8, 10, 10, 12… the 2 h soak's
 *  NDI receiver saw on every engine start. */
const ENGINE_STARTS = [
  [5.0, 2.3, 34.8, 6.6, 35.4, 43.0],
  [3.7, 5.2, 39.4, 5.9, 34.7, 29.4],
  [4.4, 3.7, 26.3, 3.7, 8.3, 42.5],
  [6.0, 2.2, 39.2, 4.5, 35.5, 33.9],
  [9.4, 34.0, 39.0, 26.4, 31.0, 39.8],
];

function engineStart(gaps: number[]): number[] {
  const arrivals = [10];
  for (const gap of gaps) arrivals.push(arrivals.at(-1)! + gap);
  while (arrivals.length < 90) arrivals.push(arrivals.at(-1)! + 1000 / 30);
  return arrivals;
}

/** How many of the first 20 frames never went up. */
const lostOfFirst20 = (order: number[]) => 20 - new Set(order.filter((n) => n < 20)).size;

// Seeded by the burst, 5–7 of the first 20 never went up. Up to 2 still may: six frames landing within 46 ms
// overflow the 30 Hz window's queue of 3, and a deeper queue would keep a frame of lag behind the sound for good.
test.each(ENGINE_STARTS)("an engine start's burst does not halve a 30 fps video (%s ms…)", (...gaps) => {
  expect(lostOfFirst20(present(engineStart(gaps), 30, 3).order), "30 Hz NDI window").toBeLessThanOrEqual(2);
  expect(lostOfFirst20(present(engineStart(gaps), 60, 3).order), "60 Hz projector").toBeLessThanOrEqual(2);
});

test("30 fps on a 60 Hz projector: every frame up two refreshes, with ±6 ms of jitter", () => {
  const { held, dropped } = play(30, 60, 6);
  expect(dropped).toBe(0);
  expect(held.filter((n) => n !== 2).length).toBeLessThanOrEqual(2);
});

test("60 fps on 60 Hz: every other frame, two refreshes each — a steady 30, never 60 with random losses", () => {
  const { held, dropped, frames } = play(60, 60, 5);
  expect(dropped).toBe(0);
  expect(held.filter((n) => n !== 2).length).toBeLessThanOrEqual(2);
  expect(frames).toBeGreaterThan(295);
  expect(frames).toBeLessThan(305);
});

test("50 fps on 60 Hz: halved to 25, the 3–2 rhythm", () => {
  const { held, dropped } = play(50, 60, 4);
  expect(dropped).toBe(0);
  expect(held.every((n) => n === 2 || n === 3)).toBe(true);
});

test("25 fps on 60 Hz: the 3–2 rhythm, none lost", () => {
  const { held, dropped } = play(25, 60, 4);
  expect(dropped).toBe(0);
  expect(held.every((n) => n === 2 || n === 3)).toBe(true);
  const average = held.reduce((a, b) => a + b, 0) / held.length;
  expect(average).toBeCloseTo(2.4, 1);
});

test("30 fps into the 30 Hz NDI window: every frame, once", () => {
  const { held, dropped } = play(30, 30, 6);
  expect(dropped).toBe(0);
  expect(held.every((n) => n === 1)).toBe(true);
});

test("60 fps into the 30 Hz NDI window: every other frame, evenly", () => {
  const { held, frames } = play(60, 30, 3);
  expect(held.every((n) => n === 1)).toBe(true);
  expect(frames).toBeGreaterThan(290);
});
