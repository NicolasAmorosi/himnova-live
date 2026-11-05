import { useContext, useId, type MouseEvent, type ReactNode } from "react";
import { cn } from "@renderer/lib/utils";
import { FieldLayoutContext, type FieldLayout } from "./field-layout";
import { Icon } from "./icon";
import { Title } from "./title";
import { Tooltip } from "./tooltip";


/** In a compact row every control takes the whole cell, so the fields of an
 *  inspector share one right edge whatever width the call site gave them for
 *  a Settings page (`w-52`, `w-64`, a slider's `w-40`). A switch keeps its own
 *  size, and a slider's readout its `ch` width (an inline style, which beats
 *  the class); the track takes what the readout leaves. */
const COMPACT_CONTROL =
  "flex min-w-0 items-center gap-2 *:max-w-full [&>*:not([role=switch])]:w-full [&>input[type=range]]:min-w-0 [&>input[type=range]]:flex-1";

/** A titled group of related fields on a Settings page: a subtitle and its
 *  rows between thin lines, with no box around them — GitHub's settings
 *  (2026-11-04 redesign): groups are told apart by space and their subtitle.
 *  Add a field to an existing group, or start a new group; never a flat list
 *  of rows. */
export function FieldGroup({ children, className, title }: { children: ReactNode; className?: string; title: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Title as="h3">{title}</Title>
      <div className="divide-y divide-border border-t border-border">{children}</div>
    </div>
  );
}

/** One field per row inside a `FieldGroup`: label (+ optional helper
 *  description) on the left, its control(s) on the right, never wrapping.
 *
 *  `label` and `description` are nodes rather than strings because this row is
 *  also what a LIST of things looks like in Settings — the installed bibles —
 *  and one of those rows swaps its name for an `<Input>` while it is being
 *  renamed. Keeping that inside the same primitive is what makes a list row
 *  and a settings row exactly the same height, which is the whole reason the
 *  list is built from this and not from the denser `ListRow` the resource
 *  panels use.
 *
 *  The grip and drop-indicator props are spelled exactly like `ListRow`'s, and
 *  mean exactly the same thing: a reorderable list in Settings and one in a
 *  resource panel are the same interaction at two densities, and two spellings
 *  of it is how the two start behaving differently.
 *
 *  The row is a `group` named by its label and described by its description.
 *  The control inside comes from the caller, so this cannot name it directly,
 *  but a screen reader announces the group on the way in — which is what an
 *  unnamed `Select` that read out only «Centered» was missing. */
export function FieldRow({
  children,
  description,
  dropBefore = false,
  grip = false,
  gripDisabled = false,
  label,
  layout,
  leading,
  onGripMouseDown,
  onGripMouseUp,
}: {
  children: ReactNode;
  description?: ReactNode;
  /** Drop indicator while a drag hovers just above this row. */
  dropBefore?: boolean;
  /** Shows the grip icon. Handle-only drag: pair it with
   *  `onGripMouseDown`/`onGripMouseUp`, which is what arms `draggable` on the
   *  element that owns this row — native HTML5 drag has no handle concept. */
  grip?: boolean;
  /** Shows the grip but greys it out and drops its handlers, so the row does
   *  not change width when reordering is momentarily unavailable. */
  gripDisabled?: boolean;
  label: ReactNode;
  /** Overrides the surrounding `FieldLayoutContext` — see `FieldLayout`. */
  layout?: FieldLayout | undefined;
  /** Sits before the label — an icon badge for a row that names a THING (a
   *  bible, a file) rather than a preference. */
  leading?: ReactNode;
  onGripMouseDown?: ((e: MouseEvent<HTMLSpanElement>) => void) | undefined;
  onGripMouseUp?: ((e: MouseEvent<HTMLSpanElement>) => void) | undefined;
}) {
  const labelId = useId();
  const descriptionId = useId();
  const contextLayout = useContext(FieldLayoutContext);
  const effective = layout ?? contextLayout;

  if (effective !== "spread") {
    // No grip or `leading` here: those belong to a LIST of things in Settings,
    // which never sits in an inspector.
    const stacked = effective === "stacked";
    const help = description ? (
      <Tooltip className="ml-1 align-[-0.125rem]" content={description} floating>
        <Icon className="size-3.5 text-subtle" name="help" />
      </Tooltip>
    ) : null;
    // The «?» travels with the label's last word, so a label that wraps never
    // leaves it alone on a line of its own (2026-11-04 review).
    const text = typeof label === "string" ? label : null;
    const cut = text !== null && help ? text.lastIndexOf(" ") : -1;
    return (
      <div
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={labelId}
        className={cn(
          "grid items-center gap-x-3 gap-y-1 py-1",
          stacked ? "grid-cols-1" : "grid-cols-[7.5rem_minmax(0,1fr)]",
        )}
        role="group"
      >
        <span className="min-w-0 text-dense text-muted-foreground">
          {/* The hint behind a «?» rather than under the row: written out, the
              hints made an inspector of 30 knobs twice as long. It stays the
              row's description for a screen reader. */}
          {text !== null && cut > 0 ? (
            <span id={labelId}>
              {text.slice(0, cut + 1)}
              <span className="whitespace-nowrap">
                {text.slice(cut + 1)}
                {help}
              </span>
            </span>
          ) : (
            <>
              <span id={labelId}>{label}</span>
              {help}
            </>
          )}
        </span>
        <div className={COMPACT_CONTROL}>{children}</div>
        {description ? (
          <span className="sr-only" id={descriptionId}>
            {description}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div
      aria-describedby={description ? descriptionId : undefined}
      aria-labelledby={labelId}
      className={cn(
        // Flush with the group's subtitle: a Settings row has no box to sit in.
        "relative flex flex-nowrap items-center justify-between gap-6 py-3",
        dropBefore &&
          "before:absolute before:inset-x-0 before:-top-px before:h-0.5 before:rounded-full before:bg-accent",
      )}
      role="group"
    >
      {/* Grip and `leading` share one box on a `gap-2` of their own: the row's
          own `gap-6` is the distance between the NAME and its controls, and
          applied between a handle and the star beside it it reads as two
          unrelated columns. */}
      {grip || leading ? (
        <span className="flex shrink-0 items-center gap-2">
          {grip ? (
            <span
              className={cn(
                "flex items-center",
                gripDisabled ? "cursor-not-allowed text-subtle opacity-40" : "cursor-grab text-subtle",
              )}
              onMouseDown={gripDisabled ? undefined : onGripMouseDown}
              onMouseUp={gripDisabled ? undefined : onGripMouseUp}
            >
              <Icon name="grip" />
            </span>
          ) : null}
          {leading}
        </span>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground" id={labelId}>
          {label}
        </span>
        {description ? (
          <span className="text-xs text-muted-foreground" id={descriptionId}>
            {description}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-nowrap items-center gap-2">{children}</div>
    </div>
  );
}
