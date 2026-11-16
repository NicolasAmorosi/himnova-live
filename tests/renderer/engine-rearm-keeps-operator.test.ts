/**
 * An AVI sent live before main decided the engine plays it is re-pointed at the engine's url (`rearmLive`). That is
 * the same video, not something new: the operator's pause and volume stay as they were.
 */
import { expect, test } from "vitest";
import { rearmLive } from "@renderer/effects/engine-assets-sync";
import { useEngineAssetsStore } from "@renderer/stores/engine-assets.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { assetUrl, engineAssetUrl } from "@shared/urls";

test("re-pointing a live video at the engine keeps the operator's pause and volume", () => {
  const projection = useProjectionStore.getState();
  projection.beginScene();
  projection.setBase({ kind: "video", assetId: 7, url: assetUrl(7), epoch: 3, startAtSeconds: 0 });
  projection.setVideoPaused(true);
  projection.setVideoVolume(0.3);

  useEngineAssetsStore.getState().apply({ assetId: 7, engine: true });
  rearmLive(7);

  const after = useProjectionStore.getState();
  expect(after.base).toMatchObject({ url: engineAssetUrl(7) });
  expect(after.videoPaused).toBe(true);
  expect(after.videoVolume).toBe(0.3);
});
