import { useCallback, useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { LoadingState, Monitor } from "@renderer/components/ui";
import { OutputView } from "@renderer/components/shared/output-view";
import { DeckConversionStatus } from "@renderer/components/shared/deck-conversion-status";
import { sofficeBlocks, useDeckStore } from "@renderer/stores/deck.store";
import { usePreviewContent, usePreviewOutput } from "@renderer/lib/hooks/use-preview";
import { usePreviewMediaStatus } from "@renderer/lib/hooks/use-preview-media-status";
import { usePreviewEngineVideo } from "@renderer/lib/hooks/use-preview-engine-video";
import { attachPreviewVideo } from "@renderer/lib/actions/preview-playback";

/** Stage one of the two-stage flow: what the operator has queued up, never on
 *  the projector until GO LIVE — that control now sits above this monitor,
 *  shared with LIVE, instead of in this panel's own footer. Its position
 *  readout (slide 3/12…) lives in the column header — see `SlidesPanel.tsx`.
 *
 *  A previewed video CAN play here (muted, and only via the play button on
 *  `PreviewMediaBar`) — see `mode="preview"` on `OutputView`. `videoElement`
 *  is `useState`, not a plain ref, so `usePreviewMediaStatus` re-attaches its
 *  listeners whenever the element itself mounts/unmounts, not just once. */
export function PreviewMonitor() {
  const t = useT();
  const content = usePreviewContent();
  const output = usePreviewOutput(content);
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);
  usePreviewMediaStatus(videoElement);
  const engineFailedUrl = usePreviewEngineVideo(output);

  const handleVideoRef = useCallback((element: HTMLVideoElement | null) => {
    setVideoElement(element);
    attachPreviewVideo(element);
  }, []);

  const missing =
    (content?.kind === "media" && content.asset.missingSince !== null) ||
    (content?.kind === "deck" && content.missingSince !== null);

  const empty = missing
    ? t("preview.missing")
    : content?.kind === "media"
      ? content.asset.name
      : t("preview.placeholder");

  // A deck still converting (or queued behind other work) has no `output`
  // yet — without this, the stage would just fall back to the generic empty
  // placeholder with no sign anything is happening.
  const convertingAssetId = !missing && !output && content?.kind === "deck" ? content.assetId : null;
  // …unless nothing is: with LibreOffice missing, an unconverted deck is
  // never queued, and this stage said «Getting ready to convert…» forever.
  const environment = useDeckStore((s) => s.environment);
  const convertingEntry = useDeckStore((s) => (convertingAssetId === null ? undefined : s.byAssetId[convertingAssetId]));
  const sofficeMissing =
    convertingAssetId !== null && content?.kind === "deck" && sofficeBlocks(environment, content.ext, convertingEntry);

  return (
    <Monitor empty={empty}>
      {output ? (
        // The preview's own elements ARE the ones being checked here, which is
        // the point — a file the operator queues up is exercised in this window
        // before it ever reaches the projector. A video the engine plays has no
        // element, so the engine's own failure is passed in.
        <OutputView
          errorLabel={t("media.loadError")}
          mode="preview"
          output={output}
          reportedErrorUrls={engineFailedUrl ? [engineFailedUrl] : []}
          videoRef={handleVideoRef}
        />
      ) : sofficeMissing ? (
        <LoadingState
          hint={t("deck.noLibreOffice.stageHint")}
          icon="alert"
          surface="stage"
          title={t("deck.noLibreOffice.title")}
          tone="failed"
        />
      ) : convertingAssetId !== null ? (
        <DeckConversionStatus assetId={convertingAssetId} surface="stage" />
      ) : undefined}
    </Monitor>
  );
}
