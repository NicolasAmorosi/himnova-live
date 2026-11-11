import { expect, test } from "vitest";
import { IDLE_FRAME_MS, SETTLE_MS, paintVerdict } from "../../src/main/ndi/ndi-pacing";

const watched = { ready: true, inFlight: false, receivers: 1, msSinceIdleFrame: 0 };

test("with someone watching, every paint goes out while no frame is in flight", () => {
  // Fails if no frame ever reaches the engine (M01): OBS shows nothing while the app says «Enviando».
  expect(paintVerdict(watched)).toEqual({ send: true });
  // Fails if a second texture is held while the engine reads the first: Chromium's small pool stalls.
  expect(paintVerdict({ ...watched, inFlight: true })).toEqual({ send: false, redrawInMs: SETTLE_MS });
  // Fails if paints are handed to an engine that is not ready, or a redraw is armed for it.
  expect(paintVerdict({ ...watched, ready: false })).toEqual({ send: false, redrawInMs: null });
});

test("with nobody watching, a frame at most every IDLE_FRAME_MS, and the last one drawn again", () => {
  // Fails if idle paints are all encoded, or never: a receiver arriving later would get a stale picture.
  expect(paintVerdict({ ...watched, receivers: 0, msSinceIdleFrame: 100 })).toEqual({ send: false, redrawInMs: IDLE_FRAME_MS - 100 });
  expect(paintVerdict({ ...watched, receivers: 0, msSinceIdleFrame: IDLE_FRAME_MS })).toEqual({ send: true });
});
