import { useEffect, useRef, type DragEvent } from "react";
import { Icon, ListRow } from "@renderer/components/ui";
import { useItemLabel, useItemPath } from "@renderer/lib/hooks/use-program-item-display";
import { useAudioStore } from "@renderer/stores/audio.store";
import { survivingAssetId } from "@renderer/stores/program.store";
import { PlateAirStatus } from "@renderer/components/shared/plate-air-status";
import { ProgramItemThumb } from "@renderer/components/shared/program-item-thumb";
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
  // Where the file is (owner, 2026-11-21): two «558» from two hymnals, or a copy on another drive, told apart.
  const path = useItemPath(item);
  const ref = useRef<HTMLLIElement>(null);
  // PREVIEW moves to the next row on its own after GO LIVE (`dropSentPreview`): that row is brought into view. Only on
  // a change: a save gives every row a new id and remounts them, and the list jumped back to the selected one.
  const wasSelected = useRef(selected);
  useEffect(() => {
    if (selected && !wasSelected.current) ref.current?.scrollIntoView({ block: "nearest" });
    wasSelected.current = selected;
  }, [selected]);
  // Audio never claims the on-air rail (`active`) — that means "this is what
  // the projector shows", and audio never is. Its own indicator here is what
  // tells the operator it's sounding without implying it's on screen. A sound on air keeps the id it went out with,
  // its row may have moved to a twin since (2026-11-15 audit, D4).
  const sounding = useAudioStore(
    (s) =>
      item.kind === "media" &&
      s.tracks.some(
        (t) => t.source === "asset" && t.assetId !== null && survivingAssetId(t.assetId) === item.mediaAssetId,
      ),
  );

  return (
    <ListRow
      active={active}
      data-index={index}
      detail={path}
      draggable
      dropBefore={dragOver}
      grip
      index={index + 1}
      className="py-1"
      leading={<ProgramItemThumb deckStatus={deckStatus} item={item} />}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onDragStart={onDragStart}
      ref={ref}
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
