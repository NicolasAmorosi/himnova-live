import { useState, type DragEvent, type Ref } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Badge, Icon, IconButton, ListRow, Tooltip } from "@renderer/components/ui";
import { cn } from "@renderer/lib/utils";
import { hideDragGhost } from "@renderer/lib/dnd";
import type { ProgramSummary } from "@shared/types/program";

type ProgramRowProps = {
  /** Off while the list is filtered — reordering a partial view can't be
   *  mapped back onto the full list, so the grip stays visible but greyed
   *  out and inert instead of disappearing. */
  draggable: boolean;
  /** A drag is hovering this row: the drop indicator goes above it. */
  dragOver: boolean;
  /** This row is the one currently being dragged — faded out in place while
   *  its floating clone (see `ProgramsModal`) does the moving. */
  dragging: boolean;
  isCurrent: boolean;
  /** Double click — the fast path straight to the projector's schedule. */
  onOpen: () => void;
  onDragStart: (e: DragEvent<HTMLLIElement>) => void;
  /** Single click — chooses the program: its items in the canvas, its notes
   *  in the inspector. Never switches schedules on an accidental click. */
  onSelect: () => void;
  onToggleFavorite: () => void;
  program: ProgramSummary;
  ref: Ref<HTMLLIElement>;
  selected: boolean;
};

/** One saved program in the programs screen's list. Duplicate and Delete act
 *  on the chosen one from the bar's «⋯»; the star is the only action here,
 *  because it is saved at once. */
export function ProgramRow({
  draggable,
  dragOver,
  dragging,
  isCurrent,
  onDragStart,
  onOpen,
  onSelect,
  onToggleFavorite,
  program,
  ref,
  selected,
}: ProgramRowProps) {
  const t = useT();
  // Native HTML5 drag has no built-in "handle" concept: the row itself must
  // be `draggable`, so it's armed only while the grip is pressed and disarmed
  // right after — everywhere else on the row stays a plain click/double-click.
  const [dragReady, setDragReady] = useState(false);

  return (
    <ListRow
      className={cn(dragging && "opacity-40")}
      data-id={program.id}
      draggable={draggable && dragReady}
      dropBefore={dragOver}
      grip
      gripDisabled={!draggable}
      onGripMouseDown={draggable ? () => setDragReady(true) : undefined}
      onGripMouseUp={draggable ? () => setDragReady(false) : undefined}
      leading={
        <Tooltip content={program.favorite ? t("programs.favoriteRemove") : t("programs.favoriteAdd")} floating>
          <IconButton
            aria-label={program.favorite ? t("programs.favoriteRemove") : t("programs.favoriteAdd")}
            aria-pressed={program.favorite}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite();
            }}
            size="xs"
            variant="ghost"
          >
            <Icon className={cn(program.favorite ? "fill-current text-accent-ink" : "text-subtle")} name="favorite" />
          </IconButton>
        </Tooltip>
      }
      onClick={onSelect}
      onDoubleClick={onOpen}
      onDragEnd={() => setDragReady(false)}
      onDragStart={(e) => {
        hideDragGhost(e);
        onDragStart(e);
      }}
      ref={ref}
      selected={selected}
      trailing={isCurrent ? <Badge variant="blue">{t("programs.inUse")}</Badge> : null}
    >
      {program.name}
    </ListRow>
  );
}
