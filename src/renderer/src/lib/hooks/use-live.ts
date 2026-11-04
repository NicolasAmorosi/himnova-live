import { useProjectionStore } from "@renderer/stores/projection.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { useMediaAsset } from "@renderer/lib/hooks/use-media-asset";
import type { BaseContent } from "@shared/types/projection";

function liveAssetId(base: BaseContent | null): number | null {
  if (!base) return null;
  if (base.kind === "deck" || base.kind === "video" || base.kind === "image") return base.assetId;
  return null;
}

/**
 * The title shown next to "LIVE" in the third column's header — the same
 * kind of heading the centre column shows for the preview, but resolved
 * against `base` (what's actually on the projector) instead of the preview
 * cursor. Schedule items already carry their own title/name; content sent
 * live straight from the library resolves it from the asset instead.
 */
export function useLiveHeading(): string | null {
  const base = useProjectionStore((s) => s.base);
  const activeIndex = useProgramStore((s) => s.activeIndex);
  const items = useProgramStore((s) => s.items);
  const activeItem = activeIndex !== null ? items[activeIndex] : undefined;
  const asset = useMediaAsset(liveAssetId(base));

  if (!base) return null;

  switch (base.kind) {
    case "deck":
      return (activeItem?.kind === "ppt" ? activeItem.title : null) ?? asset?.name ?? null;
    case "video":
    case "image":
      return asset?.name ?? null;
    case "bible":
      return base.reference;
    case "utility":
      // The scene's own name, never its title/message: the header labels
      // WHICH thing is live, and two scenes can perfectly well share the
      // words painted on the screen.
      return base.scene.name;
    case "song":
      return base.song.title;
  }
}
