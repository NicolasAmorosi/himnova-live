/**
 * A video played to its end in PREVIEW goes out from 0:00, as PREVIEW's own play button restarts it: from its end it
 * ended on air at once, and «Al terminar» put the LOGO or the next row up (2026-11-22 review, RN2-5). The engine's end
 * counts as the end even when mpv's last frame stands short of the duration.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, test } from "vitest";
import { goLive } from "@renderer/lib/actions/playback";
import { previewAsset } from "@renderer/lib/actions/preview";
import { usePreviewEngineVideo } from "@renderer/lib/hooks/use-preview-engine-video";
import { useDisplayStore } from "@renderer/stores/display.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import type { MediaAsset } from "@shared/types/media";
import type { ProjectionOutput } from "@shared/types/projection";
import { engineAssetUrl } from "@shared/urls";

const video: MediaAsset = {
  id: 5, kind: "video", name: "video 5", ext: "mp4", path: "/media/5", sizeBytes: 1, mtimeMs: 1, durationMs: 8000,
  linkedAudioPath: null, inLibrary: true, missingSince: null, createdAt: 0, updatedAt: 0,
};
const initialProjection = useProjectionStore.getState();
let emit: (event: string, payload: unknown) => void = () => {};

beforeEach(() => {
  const listeners = new Map<string, (payload: unknown) => void>();
  emit = (event, payload) => listeners.get(event)?.(payload);
  (window as unknown as { worship: unknown }).worship = {
    invoke: (channel: string) => Promise.resolve({ ok: true, data: channel === "library:get" ? video : null }),
    on: (event: string, callback: (payload: unknown) => void) => {
      listeners.set(event, callback);
      return () => listeners.delete(event);
    },
  };
  useProjectionStore.setState(initialProjection, true);
  usePreviewStore.getState().clear();
  useDisplayStore.setState({ openIfNeeded: async () => {} });
});

/** PREVIEW shows the video, played up to `at` of its 8 s. */
function previewedAt(at: number): void {
  previewAsset(5, "video");
  usePreviewStore.getState().setDurationSeconds(8);
  usePreviewStore.getState().setPositionSeconds(at);
}

test("a video played to its end in PREVIEW goes live from 0:00", async () => {
  previewedAt(8);
  await goLive();
  expect(useProjectionStore.getState().base).toMatchObject({ kind: "video", assetId: 5, startAtSeconds: 0 });
});

test("a video stopped before its end in PREVIEW goes live from where it stopped", async () => {
  previewedAt(7.9);
  await goLive();
  expect(useProjectionStore.getState().base).toMatchObject({ kind: "video", assetId: 5, startAtSeconds: 7.9 });
});

test("PREVIEW's engine at its end stands at the duration, whatever frame mpv kept", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const url = engineAssetUrl(5);
  const output = { videoUnderlay: { url, paused: false } } as unknown as ProjectionOutput;
  function Monitor() {
    usePreviewEngineVideo(output);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Monitor)));
  try {
    emit("preview-video-status", { url, currentTimeSeconds: 7.967, durationSeconds: 8, paused: true, ended: true });
    expect(usePreviewStore.getState().positionSeconds).toBe(8);
    emit("preview-video-status", { url, currentTimeSeconds: 3, durationSeconds: 8, paused: false, ended: false });
    expect(usePreviewStore.getState().positionSeconds).toBe(3);
  } finally {
    act(() => root.unmount());
  }
});
