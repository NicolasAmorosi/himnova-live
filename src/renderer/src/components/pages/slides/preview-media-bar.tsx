import { useT } from "@renderer/lib/i18n/i18n-provider";
import { MediaPanel } from "@renderer/components/ui";
import { MediaTrackRow } from "@renderer/components/shared/media-track-row";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useMediaDuration } from "@renderer/lib/hooks/use-media-duration";
import { clearPreview } from "@renderer/lib/actions/preview";
import { seekPreview, togglePreviewPlayback } from "@renderer/lib/actions/preview-playback";
import { usePlayableAssetUrl } from "@renderer/stores/engine-assets.store";
import type { MediaAsset } from "@shared/types/media";

type PreviewMediaBarProps = { asset: MediaAsset };

/**
 * What a selected video/audio shows in the centre column instead of the old
 * icon-on-black tile. For a **video**, the operator can actually play it here
 * (muted, in the preview monitor above — see `mode="preview"` on
 * `OutputView`) to confirm it's the right clip and find an entry point by
 * watching it, not just guessing from the scrubber; its duration comes from
 * the real preview element instead of the detached probe. For **audio**,
 * nothing plays — sound in the control window before GO LIVE would interrupt
 * the service with no visual payoff, so it keeps the original silent,
 * informational row: duration from `useMediaDuration` and a scrubber that only
 * picks where GO LIVE should start it.
 *
 * Same shell and row as the live media panel (`MediaPanel` + `MediaTrackRow`)
 * so the two columns' media controls never drift apart.
 */
export function PreviewMediaBar({ asset }: PreviewMediaBarProps) {
  const t = useT();
  const positionSeconds = usePreviewStore((s) => s.positionSeconds);
  const previewDuration = usePreviewStore((s) => s.durationSeconds);
  const playing = usePreviewStore((s) => s.playing);
  const isVideo = asset.kind === "video";
  // Audio still has no live element in the control window, so its duration
  // keeps coming from the silent, detached probe (or main's, for the engine).
  const url = usePlayableAssetUrl(asset.id);
  const probedDuration = useMediaDuration(isVideo ? null : url, "audio");
  const duration = isVideo ? previewDuration : (probedDuration ?? 0);

  return (
    <MediaPanel className="w-full">
      <MediaTrackRow
        currentSeconds={positionSeconds}
        durationSeconds={duration}
        hint={isVideo ? t("media.previewMuted") : t("media.previewHint")}
        kind={isVideo ? "video" : "audio"}
        label={asset.name}
        onDelete={clearPreview}
        // Same button as the live panel's, doing the same thing one stage
        // earlier: for a video it rewinds the preview element without
        // starting or stopping it, for audio (which never sounds here) it
        // drops the chosen start point back to the beginning. Hidden while
        // the duration is unknown, exactly like the scrubber beside it —
        // there is no timeline to be at the start of yet.
        onRestart={duration ? () => seekPreview(0) : undefined}
        onSeek={duration ? seekPreview : undefined}
        onTogglePause={isVideo ? togglePreviewPlayback : undefined}
        paused={isVideo && !playing}
      />
    </MediaPanel>
  );
}
