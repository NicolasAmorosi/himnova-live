/**
 * The engine failing under a video Chromium plays (owner, 2026-11-17): the file goes back to Chromium for the session
 * and the renderer moves what is live onto it; one that only the engine plays stays the operator's to decide. And an
 * engine that could not start at all sends every picture Chromium plays to Chromium until the app restarts. Windows'
 * rule (the engine plays every picture) is forced on here; the engine itself, ffmpeg and the windows are outside.
 */
import { expect, test, vi } from "vitest";
import type { ConversionCandidate } from "../../src/main/db/repositories/conversions.repo";
import { MEDIA_PROBE_VERSION, type MediaProbe } from "../../src/main/media/media-compat";

const h = vi.hoisted(() => ({
  candidates: [] as unknown[],
  broadcast: vi.fn(),
  gaveUp: false,
  listeners: [] as (() => void)[],
}));

vi.mock("../../src/main/paths", () => ({ convertedMediaDir: "/nowhere" }));
vi.mock("../../src/main/services/broadcast", () => ({ broadcast: h.broadcast }));
vi.mock("../../src/main/media/ffmpeg", () => ({
  ffmpegAvailable: () => false,
  killAllFfmpeg: () => undefined,
  probeMedia: () => Promise.resolve(null),
}));
vi.mock("../../src/main/media/media-engine", () => ({
  engineAvailable: () => true,
  engineGaveUp: () => h.gaveUp,
  onEngineGaveUp: (listener: () => void) => h.listeners.push(listener),
}));
vi.mock("../../src/main/media/media-compat", async (original) => ({
  ...(await original<typeof import("../../src/main/media/media-compat")>()),
  ENGINE_PLAYS_EVERY_PICTURE: true,
}));
vi.mock("../../src/main/services/repos", () => ({
  getConversionsRepo: () => ({
    candidates: (id?: number) => (h.candidates as ConversionCandidate[]).filter((c) => id === undefined || c.id === id),
  }),
  getMediaRepo: () => ({ survivingId: (id: number) => id }),
}));

const { engineFailedOn, initEngineAssets, setDecoderSupport } = await import("../../src/main/media/engine-assets");

const probed = (id: number, ext: string, probe: MediaProbe): ConversionCandidate => ({
  id,
  kind: "video",
  path: `/media/${id}.${ext}`,
  ext,
  sizeBytes: 1,
  mtimeMs: 1,
  probe: { sourceSize: 1, sourceMtimeMs: 1, probeVersion: MEDIA_PROBE_VERSION, probeJson: JSON.stringify(probe) },
});
const video = (codec: string) => ({ index: 0, codec, pixFmt: "yuv420p", width: 1920, height: 1080, colorTransfer: null, interlaced: false });
const MP4 = 1;
const XVID = 2;
const LATER = 3;

test("an engine that fails under a file Chromium plays sends it back to Chromium; an AVI stays the engine's", async () => {
  h.candidates = [
    probed(MP4, "mp4", { container: "mov,mp4,m4a,3gp,3g2,mj2", durationSec: 30, video: video("h264"), audio: null }),
    probed(XVID, "avi", { container: "avi", durationSec: 30, video: video("mpeg4"), audio: null }),
  ];
  initEngineAssets();
  setDecoderSupport({ hevc: false, hevcMain10: false });
  // Windows: every picture on the engine, the MP4 too.
  await vi.waitFor(() => expect(h.broadcast).toHaveBeenCalledWith("engine-asset-changed", { assetId: MP4, engine: true }));
  await vi.waitFor(() => expect(h.broadcast).toHaveBeenCalledWith("engine-asset-changed", { assetId: XVID, engine: true }));

  expect(engineFailedOn(MP4)).toBe(true);
  expect(h.broadcast).toHaveBeenCalledWith("engine-asset-changed", { assetId: MP4, engine: false });
  expect(engineFailedOn(XVID)).toBe(false);
  expect(h.broadcast).not.toHaveBeenCalledWith("engine-asset-changed", { assetId: XVID, engine: false });

  // The next pass (an import, say) keeps the MP4 on Chromium: the session remembers.
  h.broadcast.mockClear();
  setDecoderSupport({ hevc: true, hevcMain10: false });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(h.broadcast).not.toHaveBeenCalledWith("engine-asset-changed", { assetId: MP4, engine: true });
});

test("an engine that cannot start sends every picture Chromium plays to Chromium, and says so once", async () => {
  h.candidates = [...h.candidates, probed(LATER, "mp4", { container: "mov,mp4,m4a,3gp,3g2,mj2", durationSec: 9, video: video("h264"), audio: null })];
  setDecoderSupport({ hevc: false, hevcMain10: false });
  await vi.waitFor(() => expect(h.broadcast).toHaveBeenCalledWith("engine-asset-changed", { assetId: LATER, engine: true }));

  h.broadcast.mockClear();
  h.gaveUp = true;
  for (const listener of h.listeners) listener();
  expect(h.broadcast).toHaveBeenCalledWith("engine-fallback", undefined);
  await vi.waitFor(() => expect(h.broadcast).toHaveBeenCalledWith("engine-asset-changed", { assetId: LATER, engine: false }));
  // What only the engine plays keeps trying it.
  expect(h.broadcast).not.toHaveBeenCalledWith("engine-asset-changed", { assetId: XVID, engine: false });
});
