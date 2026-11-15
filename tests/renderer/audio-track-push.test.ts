/** What the control window sends the projector for each live audio track (`projection-sync.ts`). */
import { expect, test } from "vitest";
import { toAudioTrackPush } from "@renderer/effects/projection-sync";
import type { LiveAudioTrack } from "@renderer/stores/audio.store";

const track = (source: LiveAudioTrack["source"], paused = false): LiveAudioTrack => ({
  trackId: source,
  source,
  assetId: null,
  label: source,
  url: `worship://${source}`,
  epoch: 1,
  paused,
  startAtSeconds: 0,
  volume: 1,
  loop: false,
});

test("BLACK/LOGO pause the deck's music, never a standalone audio", () => {
  // Fails if the deck's soundtrack plays on over BLACK.
  expect(toAudioTrackPush(track("deck"), true, false, 1).paused).toBe(true);
  // Fails if covering the screen stops a standalone track (the prelude music goes on under BLACK).
  expect(toAudioTrackPush(track("asset"), true, false, 1).paused).toBe(false);
  // Fails if the operator's own pause is lost.
  expect(toAudioTrackPush(track("asset", true), false, false, 1).paused).toBe(true);
});

test("«loop» at the end of an audio loops a standalone track, not the deck's", () => {
  // Fails if `projection.audioEnd` «loop» is not folded in, or reaches the deck's soundtrack.
  expect([toAudioTrackPush(track("asset"), false, true, 1).loop, toAudioTrackPush(track("deck"), false, true, 1).loop]).toEqual([true, false]);
});

test("a live track sounds at its own level times the LIVE master", () => {
  // Fails if the LIVE strip's fader does not reach the tracks the projector and the engine play.
  expect(toAudioTrackPush({ ...track("asset"), volume: 0.8 }, false, false, 0.5).volume).toBeCloseTo(0.4, 6);
  expect(toAudioTrackPush({ ...track("deck"), volume: 0.8 }, false, false, 1).volume).toBeCloseTo(0.8, 6);
});
