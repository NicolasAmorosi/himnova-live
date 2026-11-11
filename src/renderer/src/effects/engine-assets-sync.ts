import { api } from "@renderer/lib/api";
import { onIpc } from "@renderer/lib/ipc";
import { playableAssetUrl, useEngineAssetsStore } from "@renderer/stores/engine-assets.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useAudioStore } from "@renderer/stores/audio.store";
import type { DecoderSupport } from "@shared/types/media";

/**
 * What only this renderer's Chromium can say: whether the GPU decodes HEVC.
 * `isTypeSupported` answers for the platform decoder, which is the only HEVC
 * decoder Chromium has — no software fallback — so on a PC without one an
 * iPhone video would play as silence over black. The media engine plays those.
 */
function decoderSupport(): DecoderSupport {
  const supports = (codecs: string) => {
    try {
      return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(`video/mp4; codecs="${codecs}"`);
    } catch {
      return false;
    }
  };
  return { hevc: supports("hvc1.1.6.L93.B0"), hevcMain10: supports("hvc1.2.4.L153.B0") };
}

/**
 * Mirrors what main sends to the media engine into `engine-assets.store`, and is
 * what starts it: main decides nothing until it hears what this machine decodes.
 *
 * Subscribed before the list is fetched. Events and invoke replies travel the
 * same ordered pipe, so an event that arrives before the reply describes an
 * older state the reply supersedes, and every one after it is newer.
 */
/**
 * A decision that lands while its file is already live. An AVI sent live within ~0.5 s of its import
 * or of the app's launch — before main's first decision — went out as a `<video>` Chromium cannot
 * open, and stayed black and silent: nothing re-armed it (2026-11-10 review, agent2v-01). Re-pointed
 * in place, from where it is: the same scene, no fade, and main starts the engine for the new url.
 */
export function rearmLive(assetId: number): void {
  const url = playableAssetUrl(assetId);
  const projection = useProjectionStore.getState();
  const { base } = projection;
  if (base?.kind === "video" && base.assetId === assetId && base.url !== url) {
    const status = projection.mediaStatus.video;
    const at = status?.epoch === base.epoch ? status.currentTimeSeconds : base.startAtSeconds;
    projection.setBase({ ...base, url, startAtSeconds: at });
  }
  const audio = useAudioStore.getState();
  for (const track of audio.tracks) {
    if (track.source === "asset" && track.assetId === assetId && track.url !== url) audio.setUrl(track.trackId, url);
  }
}

export function startEngineAssetsSync(): () => void {
  const unsubscribe = onIpc("engine-asset-changed", (update) => {
    useEngineAssetsStore.getState().apply(update);
    rearmLive(update.assetId);
  });
  void (async () => {
    try {
      await api.engine.reportDecoders(decoderSupport());
      const assets = await api.engine.assets();
      useEngineAssetsStore.getState().reset(assets);
      for (const assetId of assets) rearmLive(assetId);
    } catch (error) {
      console.warn("[engine] sync failed", error);
    }
  })();
  return unsubscribe;
}
