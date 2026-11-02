import { create } from "zustand";
import { assetUrl, engineAssetUrl } from "@shared/urls";
import type { EngineAssetUpdate } from "@shared/types/media";

/**
 * The library videos and audios the media engine plays — the ones Chromium cannot decode
 * (`main/media/engine-assets.ts`) — mirrored by `effects/engine-assets-sync.ts`. "No entry" is the
 * common case and means Chromium plays it.
 */
type EngineAssetsStoreState = {
  engine: Record<number, true>;
  apply: (update: EngineAssetUpdate) => void;
  /** Main's full list, which supersedes every event that arrived before it. */
  reset: (assetIds: number[]) => void;
};

export const useEngineAssetsStore = create<EngineAssetsStoreState>((set) => ({
  engine: {},
  apply: ({ assetId, engine }) =>
    set((s) => {
      const { [assetId]: _engine, ...others } = s.engine;
      return { engine: engine ? { ...others, [assetId]: true } : others };
    }),
  reset: (assetIds) => set({ engine: Object.fromEntries(assetIds.map((id) => [id, true] as const)) }),
}));

/**
 * The url a `<video>`/`<audio>` should load for a library asset: the file itself, or, for one the
 * media engine plays, its `engineAssetUrl`, which is what tells every view to draw the engine's
 * frames rather than mount a `<video>`.
 *
 * Only for video and audio: an image never goes through the engine.
 */
export function playableAssetUrl(assetId: number): string {
  return useEngineAssetsStore.getState().engine[assetId] ? engineAssetUrl(assetId) : assetUrl(assetId);
}

/** The same url, for a component that must re-render when it changes. */
export function usePlayableAssetUrl(assetId: number): string;
export function usePlayableAssetUrl(assetId: number | null): string | null;
export function usePlayableAssetUrl(assetId: number | null): string | null {
  const engine = useEngineAssetsStore((s) => assetId !== null && s.engine[assetId] === true);
  if (assetId === null) return null;
  return engine ? engineAssetUrl(assetId) : assetUrl(assetId);
}
