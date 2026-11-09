import { Children, isValidElement, useContext, useId, type MouseEvent, type ReactNode } from "react";
import { cn } from "@renderer/lib/utils";
import { Box } from "./card";
import { Switch } from "./checkbox";
import { FieldLabelContext, FieldLayoutContext, type FieldLayout } from "./field-layout";
import { Icon } from "./icon";
import { Title } from "./title";
import { Tooltip } from "./tooltip";


/** In a compact row every control takes the whole cell, so the fields of an
 *  inspector share one right edge whatever width the call site gave them for
 *  a Settings page (`w-52`, `w-64`, a slider's `w-40`). A switch keeps its own
 *  size, and a slider's readout its `ch` width (an inline style, which beats
 *  the class); the track takes what the readout leaves. A plain button beside
 *  a field keeps its own width too: stretched like the field, the two split the
 *  cell and «+ Agregar…» read «+ A» (owner, 2026-11-05). Only BESIDE something:
 *  a button alone in the cell is a field (`ColorField`'s trigger) and takes it
 *  whole. A `Select`'s trigger is a button too, but it carries `role="combobox"`. */
const COMPACT_CONTROL =
  "flex min-w-0 items-center gap-2 *:max-w-full [&>*:not([role=switch])]:w-full [&>button:not([role]):not(:only-child)]:w-auto [&>button:not([role]):not(:only-child)]:shrink-0 [&>input[type=range]]:min-w-0 [&>input[type=range]]:flex-1";

/** A titled group of related fields on a Settings page: its title above, its
 *  rows in one box between thin lines — Windows 11's and macOS's settings
 *  (owner, 2026-11-05: borderless rows on the canvas had «no separation from
 *  the background»). Anything that is not a `FieldRow` inside carries the
 *  row's `px-4` itself. Add a field to an existing group, or start a new
 *  group; never a flat list of rows. */
export function FieldGroup({
  children,
  className,
  description,
  title,
}: {
  children: ReactNode;
  className?: string;
  /** One line about the whole group, under its title — never a box of prose
   *  after the rows. */
  description?: string | undefined;
  title: string;
}) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-col gap-0.5">
        <Title as="h3">{title}</Title>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <Box className="divide-y divide-border">{children}</Box>
    </section>
  );
}

/** The rows that only apply while a switch above them is on: always shown,
 *  dimmed and inert while it is off (owner, 2026-11-05 — hidden in some
 *  editors and dimmed in others before). A native disabled `<fieldset>` turns
 *  off every control inside, and each `FieldRow` dims its own label beside a
 *  disabled control; `contents` keeps the rows in the section's own column. */
export function DependentFields({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  // On a Settings page the rows sit between lines (`FieldGroup`'s `divide-y`), which reach only the box's
  // own children: through `contents` the rows in here would lose theirs.
  const spread = useContext(FieldLayoutContext) === "spread";
  return (
    <fieldset className={cn("contents", spread && "divide-y divide-border")} disabled={!enabled}>
      {children}
    </fieldset>
  );
}

/** The «?» after a label: the hint in a tooltip, on hover or focus. Inside a
 *  switch row's `<label>` a click on it would flip the switch, hence the
 *  `preventDefault`. */
function HelpIcon({ content }: { content: ReactNode }) {
  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- only stops the enclosing <label> from treating a click on the «?» as one on its switch; the keyboard never reaches it
    <span onClick={(e) => e.preventDefault()}>
      <Tooltip className="ml-1 align-[-0.125rem]" content={content} floating>
        <Icon className="size-3.5 text-subtle" name="help" />
      </Tooltip>
    </span>
  );
}

/** One width for every field of a Settings row (2026-11-05 review: eight
 *  widths made eight right-hand columns); a button keeps its own. A `Select`'s
 *  trigger is the `combobox`, an `Input` is the bare `<input>`. */
const SPREAD_FIELD = "[&>[role=combobox]]:w-64 [&>input:not([type=checkbox]):not([type=range])]:w-64";

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
 *  The row is a `group` named by its label and described by its description,
 *  and it hands the label's id down (`FieldLabelContext`) so a `Select` inside
 *  is named by it too — a combobox named by nothing read out only «Centered». */
export function FieldRow({
  children,
  description,
  dropBefore = false,
  grip = false,
  gripDisabled = false,
  help,
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
  /** A Settings row's longer explanation, behind a «?» after its label: the
   *  description under it stays one short line (2026-11-05 review: from 11 to
   *  246 characters, the rows were all different heights). An inspector row
   *  puts its `description` there already. */
  help?: ReactNode;
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
  const helpId = useId();
  const contextLayout = useContext(FieldLayoutContext);
  const effective = layout ?? contextLayout;

  if (effective !== "spread") {
    // No grip or `leading` here: those belong to a LIST of things in Settings,
    // which never sits in an inspector.
    const stacked = effective === "stacked";
    const hint = description ?? help;
    const helpIcon = hint ? <HelpIcon content={hint} /> : null;
    // The «?» travels with the label's last word, so a label that wraps never
    // leaves it alone on a line of its own (2026-11-04 review).
    const text = typeof label === "string" ? label : null;
    // A row that holds only a switch is one wide `<label>`: the words across
    // the row, the switch at its end, and a click anywhere flips it
    // (2026-11-05 review: «Intensidad de la sombra» wrapped in a 7.5 rem
    // column with the switch stranded under it).
    const only = Children.toArray(children);
    if (!stacked && only.length === 1 && isValidElement(only[0]) && only[0].type === Switch) {
      // Still the row's named `group`, like every other row; the `<label>`
      // inside is only the click target.
      return (
        <div aria-describedby={hint ? descriptionId : undefined} aria-labelledby={labelId} role="group">
          {/* The label's OWN switch dims it: `in-has-[:disabled]` would match
              any ancestor — the whole inspector holds disabled controls. */}
          <label className="flex min-h-10 cursor-pointer items-center justify-between gap-3 py-1 has-[:disabled]:cursor-not-allowed has-[:disabled]:[&>span:first-child]:opacity-50">
            <span className="min-w-0 text-dense text-muted-foreground">
              <span id={labelId}>{label}</span>
              {helpIcon}
            </span>
            <FieldLabelContext value={labelId}>{children}</FieldLabelContext>
          </label>
          {hint ? (
            <span className="sr-only" id={descriptionId}>
              {hint}
            </span>
          ) : null}
        </div>
      );
    }
    const cut = text !== null && helpIcon ? text.lastIndexOf(" ") : -1;
    return (
      <div
        aria-describedby={hint ? descriptionId : undefined}
        aria-labelledby={labelId}
        className={cn(
          // One height for every row of an inspector — select, slider, switch
          // (2026-11-05 review: 30, 34 and 42 px in one column) — and a label
          // that dims with a control that is off.
          "grid min-h-10 items-center gap-x-3 gap-y-1 py-1 has-[:disabled]:[&>span:first-child]:opacity-50",
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
                {helpIcon}
              </span>
            </span>
          ) : (
            <>
              <span id={labelId}>{label}</span>
              {helpIcon}
            </>
          )}
        </span>
        <div className={COMPACT_CONTROL}>
          <FieldLabelContext value={labelId}>{children}</FieldLabelContext>
        </div>
        {hint ? (
          <span className="sr-only" id={descriptionId}>
            {hint}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div
      aria-describedby={[description ? descriptionId : null, help ? helpId : null].filter(Boolean).join(" ") || undefined}
      aria-labelledby={labelId}
      className={cn(
        // One height for a row with or without a description (2026-11-05 review).
        "relative flex min-h-16 flex-nowrap items-center justify-between gap-6 px-4 py-3",
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
        {/* Regular weight under a semibold group title: the two read as two
            levels, not one (2026-11-05 review — Windows 11's settings). */}
        <span className="text-sm text-foreground">
          <span id={labelId}>{label}</span>
          {help ? <HelpIcon content={help} /> : null}
        </span>
        {/* The «?» is hover-only; its text is the row's description too. */}
        {help ? (
          <span className="sr-only" id={helpId}>
            {help}
          </span>
        ) : null}
        {description ? (
          // A `div`: a description may be a block (Settings ▸ About's download).
          <div className="text-xs text-muted-foreground" id={descriptionId}>
            {description}
          </div>
        ) : null}
      </div>
      <div className={cn("flex shrink-0 flex-nowrap items-center gap-2", SPREAD_FIELD)}>
        <FieldLabelContext value={labelId}>{children}</FieldLabelContext>
      </div>
    </div>
  );
}
