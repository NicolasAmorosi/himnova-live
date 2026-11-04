import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api";
import { onIpc } from "@renderer/lib/ipc";
import { attachPreviewEngine } from "@renderer/lib/actions/preview-playback";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { engineAssetIdOfUrl } from "@shared/urls";
import type { ProjectionOutput } from "@shared/types/projection";

/**
 * The PREVIEW monitor's video when the media engine plays it: main loads it
 * into an engine of its own, muted (`preview:setVideo`), and its status lands
 * in the same preview store a `<video>`'s does (`usePreviewMediaStatus`).
 *
 * Returns the url the engine could not open, if any, for the monitor's own
 * notice: there is no element here to report it.
 */
export function usePreviewEngineVideo(output: ProjectionOutput | null): string | null {
  const video = output?.videoUnderlay;
  const url = video && engineAssetIdOfUrl(video.url) !== null ? video.url : null;
  const paused = video?.paused ?? true;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!url) return;
    attachPreviewEngine(url);
    return () => {
      attachPreviewEngine(null);
      void api.preview.setVideo(null);
    };
  }, [url]);

  // After the effect above, so a new url reaches main after the old one's `null`.
  useEffect(() => {
    if (url) void api.preview.setVideo({ url, paused, startAtSeconds: usePreviewStore.getState().positionSeconds });
  }, [url, paused]);

  useEffect(() => {
    if (!url) return;
    const { setDurationSeconds, setPlaying, setPositionSeconds } = usePreviewStore.getState();
    const offStatus = onIpc("preview-video-status", (status) => {
      if (status.url !== url) return;
      setPositionSeconds(status.currentTimeSeconds);
      if (status.durationSeconds > 0) setDurationSeconds(status.durationSeconds);
      if (status.ended) setPlaying(false);
    });
    const offError = onIpc("preview-video-error", (error) => {
      if (error.url === url) setFailedUrl(url);
    });
    return () => {
      offStatus();
      offError();
    };
  }, [url]);

  return failedUrl !== null && failedUrl === url ? failedUrl : null;
}
