import { useReducer, type DragEvent } from "react";
import { Icon, ListRow, RowThumb } from "@renderer/components/ui";
import { ModelSlide } from "@renderer/components/shared/slide-view/ModelSlide";
import { useItemIconAndBadge, useItemLabel } from "@renderer/lib/hooks/use-program-item-display";
import { useMediaAsset } from "@renderer/lib/hooks/use-media-asset";
import { failedThumbUrls, resolveThumbUrl } from "@renderer/lib/asset-thumb";
import { useAudioStore } from "@renderer/stores/audio.store";
import { PlateAirStatus } from "@renderer/components/shared/plate-air-status";
import { SongFirstSlide } from "@renderer/components/shared/song-slide-tile";
import type { DeckStatusSummary } from "@shared/types/deck";
import type { ProgramItemDTO } from "@shared/types/program";

type ScheduleRowProps = {
  /** On the projector right now. */
  active: boolean;
  /** A `ppt` item's deck, from the panel's single `deck:statuses` round-trip
   *  — where its first slide lives. */
  deckStatus?: DeckStatusSummary | undefined;
  dragOver: boolean;
  index: number;
  item: ProgramItemDTO;
  /** Stage one: preview only. */
  onClick: () => void;
  /** Stage two: straight to the projector. */
  onDoubleClick: () => void;
  onDragStart: (e: DragEvent<HTMLLIElement>) => void;
  selected: boolean;
};

export function ScheduleRow({
  active,
  deckStatus,
  dragOver,
  index,
  item,
  onClick,
  onDoubleClick,
  onDragStart,
  selected,
}: ScheduleRowProps) {
  const label = useItemLabel(item);
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
  // Audio never claims the on-air rail (`active`) — that means "this is what
  // the projector shows", and audio never is. Its own indicator here is what
  // tells the operator it's sounding without implying it's on screen.
  const sounding = useAudioStore(
    (s) =>
      item.kind === "media" && s.tracks.some((t) => t.source === "asset" && t.assetId === item.mediaAssetId),
  );

  return (
    <ListRow
      active={active}
      data-index={index}
      draggable
      dropBefore={dragOver}
      grip
      index={index + 1}
      className="py-1"
      leading={
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
      }
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onDragStart={onDragStart}
      selected={selected}
      trailing={
        sounding ? (
          <Icon className="size-3.5 text-badge-audio-ink motion-safe:animate-pulse" name="audio" />
        ) : item.kind === "plate" ? (
          // A plate never claims the on-air rail either — the content row
          // under it keeps that — so being up is said here instead.
          <PlateAirStatus plateId={item.overlayPlateId} />
        ) : undefined
      }
    >
      {label}
    </ListRow>
  );
}
