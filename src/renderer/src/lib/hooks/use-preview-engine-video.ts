import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api";
import { onIpc } from "@renderer/lib/ipc";
import { attachPreviewEngine } from "@renderer/lib/actions/preview-playback";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { engineAssetIdOfUrl } from "@shared/urls";
import type { ProjectionOutput } from "@shared/types/projection";

/**
 * PREVIEW's one engine session (`preview:setVideo`): main plays `url` at
 * PREVIEW's own volume — 0 to start, owner's 2026-11-05 «todo como en vivo pero
 * con el volumen a 0» — drawing its frames in the PREVIEW monitor when it has a
 * `picture`, and its status lands in the same preview store a `<video>`'s does
 * (`usePreviewMediaStatus`).
 *
 * Returns the url the engine could not open, if any, for the caller's own
 * notice: there is no element here to report it.
 */
function usePreviewEngine(url: string | null, paused: boolean, picture: boolean): string | null {
  const volume = usePreviewStore((s) => s.volume);
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
    if (url) void api.preview.setVideo({ url, paused, startAtSeconds: usePreviewStore.getState().positionSeconds, volume, picture });
  }, [url, paused, volume, picture]);

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

/** The PREVIEW monitor's video, when the media engine plays it. */
export function usePreviewEngineVideo(output: ProjectionOutput | null): string | null {
  const video = output?.videoUnderlay;
  const url = video && engineAssetIdOfUrl(video.url) !== null ? video.url : null;
  return usePreviewEngine(url, video?.paused ?? true, true);
}

/** A sound in PREVIEW — an audio file, a deck's music — through the engine
 *  whatever its codec, with no picture. Plays only while `playing`, which only
 *  the PREVIEW row's own button sets; and no engine is started until that
 *  first play — a click through the library must not spin one up per item, the
 *  pattern `PreviewStore.playing` already warns about. Kept after a pause, so
 *  play resumes where it stopped. */
export function usePreviewEngineSound(url: string | null): string | null {
  const playing = usePreviewStore((s) => s.playing);
  const [startedFor, setStartedFor] = useState<string | null>(null);
  const [seenUrl, setSeenUrl] = useState(url);
  // Adjusted while rendering: the first play has to reach main in this commit,
  // and another url — back to one played before included — starts unplayed.
  if (url !== seenUrl) {
    setSeenUrl(url);
    setStartedFor(null);
  } else if (playing && url !== null && startedFor !== url) setStartedFor(url);
  return usePreviewEngine(startedFor === url ? url : null, !playing, false);
}
