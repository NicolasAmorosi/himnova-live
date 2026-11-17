/**
 * Which of a deck's clips the media engine plays (`media/deck-clips.ts`): decided by an ffprobe in the background, the
 * first time the deck's DTO is built each launch. ffprobe, the engine and the repos are replaced by stubs; what is
 * checked is whether a clip whose probe failed is ever looked at again, and which clips go back to Chromium when the
 * engine fails (owner, 2026-11-17).
 */
import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  probe: vi.fn<() => Promise<unknown>>(),
  broadcast: vi.fn(),
  native: false,
  gaveUp: [] as (() => void)[],
}));

vi.mock("../../src/main/media/ffmpeg", () => ({ ffmpegAvailable: () => true, probeMedia: h.probe }));
vi.mock("../../src/main/media/media-engine", () => ({
  engineAvailable: () => true,
  engineGaveUp: () => false,
  onEngineGaveUp: (listener: () => void) => h.gaveUp.push(listener),
}));
vi.mock("../../src/main/media/engine-assets", () => ({ currentDecoderSupport: () => ({ hevc: false, hevcMain10: false }) }));
// A WMV: whatever ffprobe says about it, Chromium does not play it. An MP4 (`h.native`) it plays, and the engine too
// (Windows: every picture).
vi.mock("../../src/main/media/media-compat", () => ({
  ENGINE_PLAYS_EVERY_PICTURE: true,
  parseProbe: (raw: unknown) => raw,
  playsNatively: () => h.native,
  playsOnEngine: () => true,
}));
vi.mock("../../src/main/services/broadcast", () => ({ broadcast: h.broadcast }));

let nextId = 1;
let clipId = 0;
vi.mock("../../src/main/services/repos", () => ({
  getSlidesRepo: () => ({
    getDeckById: () => ({ cacheDir: "/cache/deck" }),
    listVideos: () => [{ id: clipId, videoFile: "1.wmv", ext: "wmv", playable: h.native ? 1 : 0 }],
    listAudio: () => [],
  }),
}));

const { clipEngineFailed, healDeckClips, isEngineClip } = await import("../../src/main/media/deck-clips");

/** The probes run on a promise chain in the background. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
  clipId = nextId++;
  h.probe.mockReset();
  h.broadcast.mockClear();
  h.native = false;
});

test("a clip whose probe failed is probed again the next time its deck is built", async () => {
  h.probe.mockResolvedValueOnce(null).mockResolvedValue({ format: "asf" });
  healDeckClips(1);
  await settle();
  expect(isEngineClip("video", clipId)).toBe(false);

  // Without the retry the slide's WMV stayed black until the app restarted.
  healDeckClips(1);
  await settle();
  expect(isEngineClip("video", clipId)).toBe(true);
});

test("a file ffprobe never reads is not probed on every render: three tries a launch", async () => {
  h.probe.mockResolvedValue(null);
  for (let i = 0; i < 5; i++) {
    healDeckClips(1);
    await settle();
  }
  expect(h.probe).toHaveBeenCalledTimes(3);
  expect(isEngineClip("video", clipId)).toBe(false);
});

test("a clip probed once is not probed again", async () => {
  h.probe.mockResolvedValue({ format: "asf" });
  healDeckClips(1);
  await settle();
  healDeckClips(1);
  await settle();
  expect(h.probe).toHaveBeenCalledOnce();
  expect(isEngineClip("video", clipId)).toBe(true);
});

test("an engine that fails under a clip Chromium plays gives it back to Chromium; a WMV stays the engine's", async () => {
  h.probe.mockResolvedValue({ format: "asf" });
  healDeckClips(1);
  await settle();
  expect(clipEngineFailed("video", clipId)).toBe(false);
  expect(isEngineClip("video", clipId)).toBe(true);

  clipId = nextId++;
  h.native = true;
  healDeckClips(1);
  await settle();
  expect(isEngineClip("video", clipId)).toBe(true);
  h.broadcast.mockClear();
  expect(clipEngineFailed("video", clipId)).toBe(true);
  expect(isEngineClip("video", clipId)).toBe(false);
  expect(h.broadcast).toHaveBeenCalledWith("deck-updated", { deckId: 1 });
  // The deck built again does not take it back: the session remembers.
  healDeckClips(1);
  await settle();
  expect(isEngineClip("video", clipId)).toBe(false);
});

test("an engine that cannot start gives every clip Chromium plays back to Chromium", async () => {
  h.native = true;
  h.probe.mockResolvedValue({ format: "mov" });
  healDeckClips(2);
  await settle();
  const mp4 = clipId;
  expect(isEngineClip("video", mp4)).toBe(true);

  h.broadcast.mockClear();
  for (const listener of h.gaveUp) listener();
  expect(isEngineClip("video", mp4)).toBe(false);
  expect(h.broadcast).toHaveBeenCalledWith("deck-updated", { deckId: 2 });
});
