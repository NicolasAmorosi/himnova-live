import { useReducer } from "react";
import { RowThumb } from "@renderer/components/ui";
import { ModelSlide } from "@renderer/components/shared/slide-view/ModelSlide";
import { SongFirstSlide } from "@renderer/components/shared/song-slide-tile";
import { useItemIconAndBadge } from "@renderer/lib/hooks/use-program-item-display";
import { useMediaAsset } from "@renderer/lib/hooks/use-media-asset";
import { failedThumbUrls, resolveThumbUrl } from "@renderer/lib/asset-thumb";
import type { DeckStatusSummary } from "@shared/types/deck";
import type { ProgramItemDTO } from "@shared/types/program";

/** The picture that leads a program item's row — the order of service and the
 *  programs screen draw the same one, so an item looks the same in both
 *  (2026-11-04 review: the programs screen had its own coloured capsules). */
export function ProgramItemThumb({
  deckStatus,
  item,
}: {
  /** A `ppt` item's deck — where its first slide lives. Without it a deck
   *  shows its icon. */
  deckStatus?: DeckStatusSummary | undefined;
  item: ProgramItemDTO;
}) {
  const { icon, badge } = useItemIconAndBadge(item);
  // The same picture the library tile shows: an image's or a video's cached
  // thumbnail, a deck's first slide. A missing file shows its icon instead.
  const asset = useMediaAsset(item.kind === "media" || item.kind === "ppt" ? item.mediaAssetId : null);
  const shown = asset !== null && asset.missingSince === null ? asset : null;
  const [, markFailed] = useReducer((count: number) => count + 1, 0);
  const thumbUrl = shown
    ? resolveThumbUrl({
        asset: shown,
        deckThumbUrl: deckStatus?.thumbUrl ?? null,
        failed: failedThumbUrls,
        kind: shown.kind,
      })
    : null;
  // A deck drawn from its model has no thumbnail image: its first slide is drawn.
  const modelUrl = shown ? (deckStatus?.modelUrl ?? null) : null;

  return (
    <RowThumb
      icon={icon}
      media={
        item.kind === "song" ? (
          <SongFirstSlide songId={item.songId} />
        ) : modelUrl ? (
          <ModelSlide url={modelUrl} />
        ) : undefined
      }
      onImageError={() => {
        if (thumbUrl === null) return;
        failedThumbUrls.add(thumbUrl);
        markFailed();
      }}
      src={thumbUrl}
      tone={badge}
    />
  );
}
