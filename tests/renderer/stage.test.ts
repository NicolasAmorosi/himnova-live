/**
 * The stage screen's rules (`shared/stage.ts`): the countdown's colour and text, and how its thresholds scale.
 */
import { expect, test } from "vitest";
import { countdownTone, formatCountdown, resolveStageLayout, stageThresholds } from "@shared/stage";
import type { CountdownClock, StageCountdown } from "@shared/types/stage";

const NOW = 1_000_000;
const left = (ms: number): StageCountdown => ({
  clock: { mode: "countdown", state: "running", endsAtMs: NOW + ms },
  warnMs: 5 * 60_000,
  alertMs: 60_000,
});

test("green, amber from 5:00, red from 1:00, and past zero", () => {
  expect(countdownTone(left(10 * 60_000), NOW)).toBe("normal");
  expect(countdownTone(left(5 * 60_000 + 1), NOW)).toBe("normal"); // reads 5:01
  expect(countdownTone(left(5 * 60_000), NOW)).toBe("warn");
  expect(countdownTone(left(60_000 + 1), NOW)).toBe("warn");
  expect(countdownTone(left(60_000), NOW)).toBe("alert");
  // 0.4 s left reads 0:01, still red; zero itself is over.
  expect(countdownTone(left(400), NOW)).toBe("alert");
  expect(countdownTone(left(0), NOW)).toBe("over");
  expect(countdownTone(left(-90_000), NOW)).toBe("over");
});

test("it reads MM:SS, H:MM:SS from an hour, and +M:SS past zero, without stopping", () => {
  const clock = (ms: number): CountdownClock => ({ mode: "countdown", state: "running", endsAtMs: NOW + ms });
  expect(formatCountdown(clock(28 * 60_000 + 41_000), NOW)).toBe("28:41");
  expect(formatCountdown(clock(65 * 60_000), NOW)).toBe("1:05:00");
  expect(formatCountdown(clock(400), NOW)).toBe("00:01");
  expect(formatCountdown(clock(0), NOW)).toBe("00:00");
  expect(formatCountdown(clock(-133_000), NOW)).toBe("+02:13");
  expect(formatCountdown({ mode: "countdown", state: "held", remainingMs: 30 * 60_000 }, NOW)).toBe("30:00");
});

test("a Functions stopwatch counts up uncoloured: never amber, red nor «over» at its start", () => {
  const stopwatch: StageCountdown = { clock: { mode: "stopwatch", state: "running", startedAtMs: NOW }, warnMs: 5 * 60_000, alertMs: 60_000 };
  expect(countdownTone(stopwatch, NOW)).toBe("normal");
  expect(countdownTone(stopwatch, NOW + 90_000)).toBe("normal");
  expect(formatCountdown(stopwatch.clock, NOW + 90_000)).toBe("01:30");
});

test("short counts scale the thresholds down: amber at a fifth, red at a twentieth", () => {
  expect(stageThresholds(30 * 60_000, 5 * 60_000, 60_000)).toEqual({ warnMs: 5 * 60_000, alertMs: 60_000 });
  expect(stageThresholds(10 * 60_000, 5 * 60_000, 60_000)).toEqual({ warnMs: 2 * 60_000, alertMs: 30_000 });
});

test("«Auto» is the preacher's unless the live content has a next the musicians follow; a hand-picked one stays", () => {
  expect(resolveStageLayout("auto", false)).toBe("preacher");
  expect(resolveStageLayout("auto", true)).toBe("musicians");
  expect(resolveStageLayout("preacher", true)).toBe("preacher");
  expect(resolveStageLayout("musicians", false)).toBe("musicians");
});
