import { useT } from "@renderer/lib/i18n/i18n-provider";
import { MediaPanel } from "@renderer/components/ui";
import { MediaTrackRow } from "@renderer/components/shared/media-track-row";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useMediaDuration } from "@renderer/lib/hooks/use-media-duration";
import { clearPreview } from "@renderer/lib/actions/preview";
import { seekPreview, togglePreviewPlayback } from "@renderer/lib/actions/preview-playback";
import { usePlayableAssetUrl } from "@renderer/stores/engine-assets.store";
import { usePreviewEngineSound } from "@renderer/lib/hooks/use-preview-engine-video";
import { engineAssetUrl } from "@shared/urls";
import type { MediaAsset } from "@shared/types/media";

type PreviewMediaBarProps = { asset: MediaAsset };

/**
 * What a selected video/audio shows in the centre column: the same row as EN
 * VIVO's (`MediaPanel` + `MediaTrackRow`, so the two columns' media controls
 * never drift apart) — play, seek, restart and volume. PREVIEW sounds since
 * 2026-11-05 (owner: «todo como en vivo pero con el volumen a 0; si le suben el
 * volumen se escucha y problema de ellos»): a video in the monitor above, an
 * audio file through PREVIEW's engine, both at PREVIEW's own volume, back to 0
 * with every new item and silenced the moment it goes live
 * (`stopPreviewPlayback`). Nothing ever autoplays.
 */
export function PreviewMediaBar({ asset }: PreviewMediaBarProps) {
  const t = useT();
  const positionSeconds = usePreviewStore((s) => s.positionSeconds);
  const previewDuration = usePreviewStore((s) => s.durationSeconds);
  const playing = usePreviewStore((s) => s.playing);
  const volume = usePreviewStore((s) => s.volume);
  const setVolume = usePreviewStore((s) => s.setVolume);
  const isVideo = asset.kind === "video";
  const url = usePlayableAssetUrl(asset.id);
  // An audio file plays through PREVIEW's engine whatever its codec; a video
  // through the monitor's own element or engine (`PreviewMonitor`).
  const soundFailed = usePreviewEngineSound(isVideo ? null : engineAssetUrl(asset.id)) !== null;
  const probedDuration = useMediaDuration(isVideo ? null : url, "audio");
  const duration = previewDuration > 0 ? previewDuration : (probedDuration ?? 0);

  return (
    <MediaPanel className="w-full">
      <MediaTrackRow
        currentSeconds={positionSeconds}
        durationSeconds={duration}
        error={soundFailed ? t("media.loadError") : undefined}
        kind={isVideo ? "video" : "audio"}
        label={asset.name}
        onDelete={clearPreview}
        onRestart={duration ? () => seekPreview(0) : undefined}
        onSeek={duration ? seekPreview : undefined}
        onTogglePause={togglePreviewPlayback}
        // Like EN VIVO's row, at PREVIEW's own level: 0 with every new item,
        // heard only once raised (owner, 2026-11-05).
        onVolumeChange={setVolume}
        paused={!playing}
        volume={volume}
      />
    </MediaPanel>
  );
}
