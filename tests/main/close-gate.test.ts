import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CloseGate, GRACE_MS } from "../../src/main/windows/close-gate";

let done: string[];
let gate: CloseGate;
beforeEach(() => {
  vi.useFakeTimers();
  done = [];
  gate = new CloseGate({
    ask: () => void done.push("ask"),
    close: () => void done.push("close"),
    quit: () => void done.push("quit"),
    alive: () => true,
  });
});
afterEach(() => vi.useRealTimers());

test("a close nobody answers goes through after the grace: a hung renderer never makes the app unclosable", () => {
  // Fails if the first close is not vetoed to ask, or a repeat asks again.
  expect([gate.onClose(false), gate.onClose(false)]).toEqual([false, false]);
  expect(done).toEqual(["ask"]);
  // Fails if there is no grace timer, or it is longer than GRACE_MS.
  vi.advanceTimersByTime(GRACE_MS - 1);
  expect(done).toEqual(["ask"]);
  vi.advanceTimersByTime(1);
  expect(done).toEqual(["ask", "close"]);
  // Fails if the close it triggers is vetoed again.
  expect(gate.onClose(false)).toBe(true);
});

test("a question on screen stops the grace, and its «close» resumes the quit it came from", () => {
  gate.onClose(true);
  gate.resolve("hold");
  // Fails if «hold» leaves the timer running: the window would close under the operator's question.
  vi.advanceTimersByTime(GRACE_MS * 3);
  expect(done).toEqual(["ask"]);
  gate.resolve("close");
  // Fails if the quit is forgotten: the app would live on with no window and skip `will-quit`.
  expect(done).toEqual(["ask", "quit"]);
});

test("«cancel» forgets the close, so the next one asks again", () => {
  gate.onClose(false);
  gate.resolve("cancel");
  vi.advanceTimersByTime(GRACE_MS * 3);
  // Fails if the cancelled close still goes through, or a stale pending close silences the next one.
  expect(gate.onClose(false)).toBe(false);
  expect(done).toEqual(["ask", "ask"]);
});
