import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api";
import { engineAssetIdOfUrl } from "@shared/urls";

/**
 * Reads a video/audio file's duration without playing it — a detached element
 * (never mounted, never appended to the DOM) loaded with `preload="metadata"`
 * only. Used by the preview media bar before anything plays: an audio file's
 * PREVIEW engine starts only on its first play, and its length is shown
 * before that.
 *
 * Returns `null` while unknown (no url, or metadata not loaded yet). A file the
 * media engine plays cannot be opened here at all, so main answers from its probe.
 */
export function useMediaDuration(url: string | null, kind: "video" | "audio"): number | null {
  const [duration, setDuration] = useState<number | null>(null);

  useEffect(() => {
    setDuration(null);
    if (!url) return;

    const engineAssetId = engineAssetIdOfUrl(url);
    if (engineAssetId !== null) {
      let live = true;
      api.engine
        .duration(engineAssetId)
        .then((seconds) => {
          if (live) setDuration(seconds);
        })
        .catch(() => undefined);
      return () => {
        live = false;
      };
    }

    const element = document.createElement(kind);
    element.preload = "metadata";
    element.src = url;

    const onLoadedMetadata = () => {
      if (Number.isFinite(element.duration)) setDuration(element.duration);
    };
    element.addEventListener("loadedmetadata", onLoadedMetadata);

    return () => {
      element.removeEventListener("loadedmetadata", onLoadedMetadata);
      // Stop the request in flight; an unmounted element with no listeners
      // would otherwise keep downloading in the background.
      element.src = "";
    };
  }, [url, kind]);

  return duration;
}
