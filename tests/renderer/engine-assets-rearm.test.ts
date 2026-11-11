/**
 * The media engine's decision for a file that is already live (2026-11-10 review, agent2v-01): an AVI sent
 * live within ~0.5 s of its import went out as a `<video>` Chromium cannot open — black and silent — and
 * nothing re-armed it when main's decision arrived.
 */
import { beforeEach, expect, test } from "vitest";
import { rearmLive } from "@renderer/effects/engine-assets-sync";
import { useAudioStore } from "@renderer/stores/audio.store";
import { useEngineAssetsStore } from "@renderer/stores/engine-assets.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { assetUrl, engineAssetUrl } from "@shared/urls";

const initialProjection = useProjectionStore.getState();

beforeEach(() => {
  useProjectionStore.setState(initialProjection, true);
  useAudioStore.getState().clear();
  useEngineAssetsStore.getState().reset([]);
});

test("a live video the engine takes is re-pointed in place: same scene, the engine's url", () => {
  const projection = useProjectionStore.getState();
  projection.beginScene();
  projection.setBase({ kind: "video", assetId: 7, url: assetUrl(7), epoch: 3, startAtSeconds: 0 });
  const epoch = useProjectionStore.getState().sceneEpoch;

  useEngineAssetsStore.getState().apply({ assetId: 7, engine: true });
  rearmLive(7);

  expect(useProjectionStore.getState().base).toMatchObject({ kind: "video", assetId: 7, url: engineAssetUrl(7), epoch: 3 });
  expect(useProjectionStore.getState().sceneEpoch).toBe(epoch);
});

test("a live audio track of that file follows it; anything else is left alone", () => {
  const audio = useAudioStore.getState();
  audio.addTrack({ trackId: "a:7", source: "asset", assetId: 7, label: "", url: assetUrl(7), epoch: 1000, paused: false, startAtSeconds: 0, volume: 1, loop: false });
  audio.addTrack({ trackId: "a:8", source: "asset", assetId: 8, label: "", url: assetUrl(8), epoch: 2, paused: false, startAtSeconds: 0, volume: 1, loop: false });

  useEngineAssetsStore.getState().apply({ assetId: 7, engine: true });
  rearmLive(7);

  const [seven, eight] = useAudioStore.getState().tracks;
  expect(seven).toMatchObject({ url: engineAssetUrl(7) });
  expect(seven?.epoch).not.toBe(1000);
  expect(eight).toMatchObject({ url: assetUrl(8), epoch: 2 });
});
