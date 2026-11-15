/** The meters' tap on Chromium's own elements (`lib/level-tap.ts`), the part jsdom can reach: when it takes a copy. */
import { afterEach, expect, test, vi } from "vitest";
import { startLevelTap } from "@renderer/lib/level-tap";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

test("no copy is taken before the element has its metadata, one is after, and a file without sound is not asked twice", () => {
  vi.useFakeTimers();
  // Fails if `captureStream()` is called at readyState 0: Chromium then adds live tracks to that abandoned stream at
  // `loadedmetadata`, and nothing ever stops them.
  const empty = { getVideoTracks: () => [], getAudioTracks: () => [], getTracks: () => [] };
  const captureStream = vi.fn(() => empty);
  const element = Object.assign(document.createElement("audio"), { captureStream });
  let readyState = 0;
  Object.defineProperties(element, { readyState: { get: () => readyState }, paused: { get: () => false } });
  document.body.append(element);

  const stop = startLevelTap(() => [element], () => {});
  vi.advanceTimersByTime(400);
  expect(captureStream).not.toHaveBeenCalled();

  readyState = HTMLMediaElement.HAVE_METADATA;
  vi.advanceTimersByTime(400);
  expect(captureStream).toHaveBeenCalledTimes(1);
  stop();
});
