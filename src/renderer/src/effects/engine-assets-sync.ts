import { api } from "@renderer/lib/api";
import { onIpc } from "@renderer/lib/ipc";
import { useEngineAssetsStore } from "@renderer/stores/engine-assets.store";
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
export function startEngineAssetsSync(): () => void {
  const unsubscribe = onIpc("engine-asset-changed", (update) => useEngineAssetsStore.getState().apply(update));
  void (async () => {
    try {
      await api.engine.reportDecoders(decoderSupport());
      useEngineAssetsStore.getState().reset(await api.engine.assets());
    } catch (error) {
      console.warn("[engine] sync failed", error);
    }
  })();
  return unsubscribe;
}
