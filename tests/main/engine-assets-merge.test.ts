/**
 * A relocate that merges two rows deletes the twin at once, then follows the rest of the move (seconds on a big
 * folder) before the renderer hears which ids merged. An engine pass in between dropped the merged-away id, and the
 * renderer, not knowing yet, re-pointed the video on air under it at a `<video>` Chromium cannot open: black
 * (2026-11-15 audit, D4, review follow-up). What the engine plays is decided here; the engine itself, ffmpeg and the
 * windows are outside this suite.
 */
import { expect, test, vi } from "vitest";
import type { ConversionCandidate } from "../../src/main/db/repositories/conversions.repo";
import { notifyMediaChanged, setDecoderSupport } from "../../src/main/media/engine-assets";

const h = vi.hoisted(() => ({
  candidates: [] as unknown[],
  mergedInto: new Map<number, number>(),
  broadcast: vi.fn(),
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
  engineGaveUp: () => false,
  onEngineGaveUp: () => undefined,
}));
vi.mock("../../src/main/services/repos", () => ({
  getConversionsRepo: () => ({ candidates: () => h.candidates }),
  getMediaRepo: () => ({ survivingId: (id: number) => h.mergedInto.get(id) ?? id }),
}));

const TWIN = 5;
const KEPT = 9;
const avi = (id: number): ConversionCandidate => ({
  id,
  kind: "video",
  path: "/media/a.avi",
  ext: "avi",
  sizeBytes: 1,
  mtimeMs: 1,
  probe: null,
});

test("an engine pass right after a merge keeps the merged-away id in the engine's list", async () => {
  h.candidates = [avi(TWIN)];
  setDecoderSupport({ hevc: false, hevcMain10: false });
  await vi.waitFor(() => expect(h.broadcast).toHaveBeenCalledWith("engine-asset-changed", { assetId: TWIN, engine: true }));

  // The merge: the twin's row is gone, its file lives on as KEPT's.
  h.mergedInto.set(TWIN, KEPT);
  h.candidates = [avi(KEPT)];
  notifyMediaChanged();
  await vi.waitFor(() => expect(h.broadcast).toHaveBeenCalledWith("engine-asset-changed", { assetId: KEPT, engine: true }));

  expect(h.broadcast).not.toHaveBeenCalledWith("engine-asset-changed", { assetId: TWIN, engine: false });
});
