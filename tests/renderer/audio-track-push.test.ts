/** What the control window sends the projector for each live audio track (`projection-sync.ts`). */
import { expect, test, vi } from "vitest";
import { startProjectionEffects, toAudioTrackPush } from "@renderer/effects/projection-sync";
import { useAudioStore, type LiveAudioTrack } from "@renderer/stores/audio.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import type { AudioTrackPush } from "@shared/types/projection";

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

test("with nothing playing, LIVE's fader does not send the empty list again on every step (audit R16)", async () => {
  const invoke = vi.fn((_channel: string, _req?: unknown) => Promise.resolve({ ok: true, data: null }));
  (window as unknown as { worship: unknown }).worship = { invoke, on: () => () => {} };
  const pushes = () => invoke.mock.calls.filter(([channel]) => channel === "projection:setAudioTracks").map(([, req]) => req);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const stop = startProjectionEffects();
  try {
    for (const volume of [0.9, 0.8, 0.7]) {
      useProjectionStore.getState().setLiveMasterVolume(volume);
      await settle();
    }
    expect(pushes()).toEqual([[]]);
    // A track, its level with the master, and its end: each still goes.
    useAudioStore.getState().addTrack({ ...track("asset"), volume: 0.5 });
    await settle();
    useProjectionStore.getState().setLiveMasterVolume(0.6);
    await settle();
    useAudioStore.getState().clear();
    await settle();
    expect(pushes().map((list) => (list as AudioTrackPush[]).map((push) => push.volume))).toEqual([[], [0.35], [0.3], []]);
  } finally {
    stop();
  }
});
