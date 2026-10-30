import { expect, test } from "vitest";
import { liveEngineAudio, liveEngineSlideVideo, liveEngineState } from "../../src/main/media/live-engine-state";
import { INSTANT_TRANSITION, type AudioTrackPush, type ProjectionOutput } from "../../src/shared/types/projection";
import { assetUrl, deckVideoUrl, engineAssetUrl, engineClipUrl } from "../../src/shared/urls";

function videoOutput(url: string, overrides: Partial<{ kind: "video" | "black"; paused: boolean }> = {}): ProjectionOutput {
  const underlay = { url, epoch: 3, paused: overrides.paused ?? false, startAtSeconds: 12, volume: 0.5 };
  const base = { videoUnderlay: underlay, slideVideo: null, plates: [], transition: INSTANT_TRANSITION };
  return overrides.kind === "black" ? { kind: "black", ...base } : { kind: "video", url, epoch: 3, ...base };
}

test("only a video the engine plays has a session", () => {
  expect(liveEngineState(videoOutput(assetUrl(7)), true)).toBeNull();
  expect(liveEngineState(null, true)).toBeNull();
  expect(liveEngineState(videoOutput(engineAssetUrl(7)), true)).toEqual({
    url: engineAssetUrl(7),
    epoch: 3,
    startAtSeconds: 12,
    paused: false,
    volume: 0.5,
    loop: false,
  });
});

test("BLACK/LOGO, the operator's pause and a closed projector all pause it, and keep the session", () => {
  expect(liveEngineState(videoOutput(engineAssetUrl(7), { kind: "black" }), true)?.paused).toBe(true);
  expect(liveEngineState(videoOutput(engineAssetUrl(7), { paused: true }), true)?.paused).toBe(true);
  expect(liveEngineState(videoOutput(engineAssetUrl(7)), false)?.paused).toBe(true);
});

function track(trackId: string, url: string, paused = false): AudioTrackPush {
  return { trackId, url, epoch: 2, paused, startAtSeconds: 0, volume: 1, loop: false };
}

test("only the audio tracks the engine plays have a session, and a closed projector pauses them", () => {
  const tracks = [track("a", assetUrl(1)), track("b", engineAssetUrl(2)), track("c", engineAssetUrl(3), true)];
  expect(liveEngineAudio(tracks, true).map((t) => [t.trackId, t.paused])).toEqual([
    ["b", false],
    ["c", true],
  ]);
  expect(liveEngineAudio(tracks, false).map((t) => t.paused)).toEqual([true, true]);
});

function slideOutput(url: string, overrides: Partial<{ kind: "slide" | "logo"; paused: boolean }> = {}): ProjectionOutput {
  const slideVideo = {
    url,
    epoch: 4,
    rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    aspectRatio: 16 / 9,
    loop: true,
    paused: overrides.paused ?? false,
    startAtSeconds: 0,
    volume: 0.8,
  };
  const base = { videoUnderlay: null, slideVideo, plates: [], transition: INSTANT_TRANSITION };
  if (overrides.kind === "logo") return { kind: "logo", url: null, ...base };
  const text = { fallbackFont: null, locale: "es" };
  return { kind: "slide", deckAssetId: 1, url: "", modelUrl: null, index: 1, total: 1, preload: [], enter: null, text, ...base };
}

test("the live slide's clip has a session only when the engine plays it, and loops as the file says", () => {
  expect(liveEngineSlideVideo(slideOutput(deckVideoUrl(5, "1.mp4")), true)).toBeNull();
  expect(liveEngineSlideVideo(slideOutput(engineClipUrl("video", 5)), true)).toEqual({
    url: engineClipUrl("video", 5),
    epoch: 4,
    startAtSeconds: 0,
    paused: false,
    volume: 0.8,
    loop: true,
  });
  // The full-screen video's rule is not this one: a slide clip is no `videoUnderlay`.
  expect(liveEngineState(slideOutput(engineClipUrl("video", 5)), true)).toBeNull();
});

test("BLACK/LOGO, the operator's pause and a closed projector pause the slide's clip", () => {
  expect(liveEngineSlideVideo(slideOutput(engineClipUrl("video", 5), { kind: "logo" }), true)?.paused).toBe(true);
  expect(liveEngineSlideVideo(slideOutput(engineClipUrl("video", 5), { paused: true }), true)?.paused).toBe(true);
  expect(liveEngineSlideVideo(slideOutput(engineClipUrl("video", 5)), false)?.paused).toBe(true);
});

test("a deck's engine clips are engine tracks too", () => {
  expect(liveEngineAudio([track("deck-soundtrack", engineClipUrl("audio", 9))], true)).toHaveLength(1);
});
