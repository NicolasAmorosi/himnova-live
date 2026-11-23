import type { LiHTMLAttributes, MouseEvent, ReactNode, Ref } from "react";
import { cn } from "@renderer/lib/utils";
import { Icon } from "./icon";

type ListRowProps = Omit<LiHTMLAttributes<HTMLLIElement>, "children"> & {
  /** On the projector right now — the on-air rail plus a heavier label. */
  active?: boolean;
  children: ReactNode;
  /** A second, smaller line under the label: a file's path. Cut at its START, so the folder and the file it ends in
   *  stay in view; the whole of it on hover. */
  detail?: string | null | undefined;
  /** Drop indicator while a drag hovers just above this row. */
  dropBefore?: boolean;
  /** Shows the grip icon. By default it's purely visual — the row itself
   *  stays draggable everywhere, this only hints that it can be. Pair with
   *  `onGripMouseDown`/`onGripMouseUp` to make the grip the only place a drag
   *  can start from. */
  grip?: boolean;
  /** Shows the grip but greys it out and drops its handlers — the affordance
   *  stays in place instead of the row jumping around when reordering isn't
   *  available right now (e.g. a filtered list). */
  gripDisabled?: boolean;
  /** Position number in the gutter, the way EasyWorship numbers a schedule. */
  index?: number;
  leading?: ReactNode;
  /** Handle-only drag: the caller arms `draggable` on mousedown here and
   *  disarms it on mouseup/dragend, so a drag can only start from the grip. */
  onGripMouseDown?: ((e: MouseEvent<HTMLSpanElement>) => void) | undefined;
  onGripMouseUp?: ((e: MouseEvent<HTMLSpanElement>) => void) | undefined;
  /** Paint the on-air rail for an `active` row. Off for a list that already
   *  says so in the row itself — the time scenes show the running clock as
   *  their trailing content, and `bg-on-air` is the app's reserved «this is on
   *  the projector NOW» mark: a second one beside a ticking countdown is
   *  decoration, not information. The row stays `active` either way, so the
   *  heavier label and anything else keyed off it are unaffected. */
  rail?: boolean;
  ref?: Ref<HTMLLIElement>;
  selected?: boolean;
  trailing?: ReactNode;
};

/** Selectable row shared by the schedule and the resource lists. */
export function ListRow({
  active = false,
  children,
  className,
  detail,
  dropBefore = false,
  grip = false,
  gripDisabled = false,
  index,
  leading,
  onDoubleClick,
  onGripMouseDown,
  onGripMouseUp,
  rail = true,
  ref,
  selected = false,
  trailing,
  ...props
}: ListRowProps) {
  return (
    <li
      aria-current={selected || undefined}
      className={cn(
        "relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
        selected ? "bg-active text-foreground ring-1 ring-accent/40 ring-inset" : "hover:bg-hover",
        active && "font-medium",
        dropBefore && "before:absolute before:inset-x-0 before:-top-px before:h-0.5 before:rounded-full before:bg-accent",
        className,
      )}
      ref={ref}
      {...props}
      onDoubleClick={
        onDoubleClick &&
        ((e) => {
          // A double click on a control in the row (a star, a ✕) is that control's: bubbling up, it opened the
          // program or sent the row live (2026-11-15 audit, U1).
          const control = e.target instanceof Element ? e.target.closest("button, input") : null;
          if (control && e.currentTarget.contains(control)) return;
          onDoubleClick(e);
        })
      }
    >
      {active && rail ? <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-on-air" /> : null}
      {grip ? (
        <span
          className={cn(
            "flex shrink-0 items-center",
            gripDisabled ? "cursor-not-allowed text-subtle opacity-40" : "cursor-grab text-subtle",
          )}
          onMouseDown={gripDisabled ? undefined : onGripMouseDown}
          onMouseUp={gripDisabled ? undefined : onGripMouseUp}
        >
          <Icon name="grip" />
        </span>
      ) : null}
      {index !== undefined ? (
        <span className="w-4 shrink-0 text-right text-xs tabular-nums text-subtle">{index}</span>
      ) : null}
      {leading ? <span className="flex shrink-0 items-center">{leading}</span> : null}
      {detail ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{children}</span>
          {/* Right-to-left only to put the «…» at the start; the path itself stays a left-to-right run. */}
          <span className="truncate text-left text-xs text-subtle" dir="rtl" title={detail}>
            <bdi dir="ltr">{detail}</bdi>
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">{children}</span>
      )}
      {trailing ? <span className="flex shrink-0 items-center gap-1">{trailing}</span> : null}
    </li>
  );
}
