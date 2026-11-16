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

test("at 96 kHz a peak 30 ms before the read still reaches the meter (2026-11-15 audit, A46)", () => {
  vi.useFakeTimers();
  // Each analyser holds its last `fftSize` samples, oldest first: silence but for one peak at 0.5, 30 ms before the
  // read. A fixed window of 2048 is 21 ms at 96 kHz: read every 40 ms, that peak was never seen.
  const RATE = 96_000;
  class FakeAnalyser {
    fftSize: number;
    constructor(_context: unknown, options: { fftSize: number }) {
      this.fftSize = options.fftSize;
    }
    getFloatTimeDomainData(array: Float32Array): void {
      const n = Math.min(array.length, this.fftSize);
      for (let i = 0; i < n; i += 1) {
        const ageMs = ((this.fftSize - 1 - i) / RATE) * 1000;
        array[i] = Math.abs(ageMs - 30) < 0.01 ? 0.5 : 0.001;
      }
    }
    disconnect(): void {}
  }
  const node = () => ({ connect: (next: unknown) => next, disconnect: () => undefined });
  vi.stubGlobal("AnalyserNode", FakeAnalyser);
  vi.stubGlobal("GainNode", class { connect = (next: unknown) => next; disconnect = () => undefined; });
  vi.stubGlobal("MediaStream", class { getTracks = () => []; });
  vi.stubGlobal(
    "AudioContext",
    class {
      sampleRate = RATE;
      state = "running";
      createMediaStreamSource = node;
      createChannelSplitter = () => ({ connect: () => undefined, disconnect: () => undefined });
      suspend = () => Promise.resolve();
      close = () => Promise.resolve();
    },
  );
  const track = { stop: () => undefined };
  const captureStream = () => ({ getVideoTracks: () => [], getAudioTracks: () => [track], getTracks: () => [track] });
  const element = Object.assign(document.createElement("audio"), { captureStream });
  Object.defineProperties(element, { readyState: { get: () => HTMLMediaElement.HAVE_METADATA }, paused: { get: () => false } });
  document.body.append(element);

  const levels: number[][] = [];
  const stop = startLevelTap(() => [element], (level) => levels.push(level));
  vi.advanceTimersByTime(40);
  stop();
  vi.unstubAllGlobals();
  expect(levels.at(-1)?.[0]).toBeCloseTo(20 * Math.log10(0.5), 1);
});
