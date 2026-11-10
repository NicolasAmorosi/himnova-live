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
  const pacer = new FramePacer();
  const arrivals = Array.from({ length: Math.floor(seconds * fps) }, (_, i) => 3 + (i * 1000) / fps + noise()).sort((a, b) => a - b);
  const queue: number[] = [];
  const shown: number[] = [];
  let next = 0;
  let dropped = 0;
  for (let tick = 0; tick < seconds * hz; tick += 1) {
    const now = (tick * 1000) / hz;
    while (next < arrivals.length && arrivals[next]! <= now) {
      pacer.arrived(arrivals[next]!);
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
  return { held: held.slice(10), dropped, frames: shown.length / 2 };
}

test("30 fps on a 60 Hz projector: every frame up two refreshes, with ±6 ms of jitter", () => {
  const { held, dropped } = play(30, 60, 6);
  expect(dropped).toBe(0);
  expect(held.filter((n) => n !== 2).length).toBeLessThanOrEqual(2);
});

test("60 fps on 60 Hz: one refresh each, none lost", () => {
  const { held, dropped } = play(60, 60, 5);
  expect(dropped).toBe(0);
  expect(held.every((n) => n === 1)).toBe(true);
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
