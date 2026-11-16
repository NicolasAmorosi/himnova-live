/**
 * Which of a deck's clips the media engine plays (`media/deck-clips.ts`): decided by an ffprobe in the background, the
 * first time the deck's DTO is built each launch. ffprobe, the engine and the repos are replaced by stubs; what is
 * checked is whether a clip whose probe failed is ever looked at again.
 */
import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ probe: vi.fn<() => Promise<unknown>>() }));

vi.mock("../../src/main/media/ffmpeg", () => ({ ffmpegAvailable: () => true, probeMedia: h.probe }));
vi.mock("../../src/main/media/media-engine", () => ({ engineAvailable: () => true }));
vi.mock("../../src/main/media/engine-assets", () => ({ currentDecoderSupport: () => ({ hevc: false, hevcMain10: false }) }));
// A WMV: whatever ffprobe says about it, Chromium does not play it.
vi.mock("../../src/main/media/media-compat", () => ({ parseProbe: (raw: unknown) => raw, playsNatively: () => false }));
vi.mock("../../src/main/services/broadcast", () => ({ broadcast: () => undefined }));

let nextId = 1;
let clipId = 0;
vi.mock("../../src/main/services/repos", () => ({
  getSlidesRepo: () => ({
    getDeckById: () => ({ cacheDir: "/cache/deck" }),
    listVideos: () => [{ id: clipId, videoFile: "1.wmv", ext: "wmv", playable: 0 }],
    listAudio: () => [],
  }),
}));

const { healDeckClips, isEngineClip } = await import("../../src/main/media/deck-clips");

/** The probes run on a promise chain in the background. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
  clipId = nextId++;
  h.probe.mockReset();
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
