import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api";
import { survivingAssetId } from "@renderer/stores/program.store";
import { assetThumbUrl, assetThumbVersion } from "@shared/urls";

/**
 * The thumbnail of a video asset, for a monitor that must show the live video
 * without decoding it. Fetched rather than derived because its cache-buster
 * needs the file's size and mtime, which `base` does not carry. `null` until
 * it arrives, and whenever `assetId` is `null`.
 */
export function useLiveVideoPoster(assetId: number | null): string | null {
  const [poster, setPoster] = useState<{ assetId: number; url: string } | null>(null);
  useEffect(() => {
    if (assetId === null) return;
    let alive = true;
    // A video on air keeps the id it went out with; a relocate may have merged its row into a twin since
    // (2026-11-15 audit, D4).
    void api.library
      .get(survivingAssetId(assetId))
      .then((asset) => {
        if (alive && asset) setPoster({ assetId, url: assetThumbUrl(asset.id, assetThumbVersion(asset)) });
      })
      .catch(() => {
        // No poster is a black stage — still the truth.
      });
    return () => {
      alive = false;
    };
  }, [assetId]);
  return poster && poster.assetId === assetId ? poster.url : null;
}
