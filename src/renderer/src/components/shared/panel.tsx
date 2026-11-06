import type { ComponentProps, ReactNode } from "react";
import { cn } from "@renderer/lib/utils";
import { Title } from "@renderer/components/ui";

type PanelProps = ComponentProps<"div"> & { children: ReactNode };

/** The one shared shape behind every panel of the workspace. */
export function Panel({ children, className, ...props }: PanelProps) {
  return (
    <section className={cn("flex h-full min-h-0 flex-col overflow-hidden bg-surface", className)} {...props}>
      {children}
    </section>
  );
}

export function PanelHeader({
  actions,
  meta,
  title,
}: {
  actions?: ReactNode;
  /** The column's data — what is in it, whether it is saved — as quiet text
   *  beside the title, not a pill (2026-11-04 redesign, P4): a capsule on every
   *  header is badges everywhere. Each piece in its own element; they truncate
   *  before the actions do. Something that asks the operator to act still
   *  goes in `actions`, as a badge. */
  meta?: readonly ReactNode[];
  /** Usually a plain string; the monitors column needs a blinking on-air dot
   *  next to its label, hence ReactNode instead of forcing a second header
   *  primitive that would only differ in that one respect. */
  title: ReactNode;
}) {
  const shownMeta = meta?.filter((piece) => piece !== null && piece !== undefined && piece !== "") ?? [];
  return (
    // A fixed height: the three columns' headers line up whatever each one holds.
    <div className="flex h-strip shrink-0 items-center gap-3 border-b border-border px-3">
      <Title as="h2" className="shrink-0">
        {title}
      </Title>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
        {shownMeta.map((piece, index) => (
          <span className="min-w-0 truncate text-xs text-muted-foreground" key={index}>
            {piece}
          </span>
        ))}
        {actions}
      </div>
    </div>
  );
}

export function PanelBody({ children, className, ...props }: PanelProps) {
  return (
    <div
      className={cn(
        // `scrollbar-gutter: stable` reserves the scrollbar's width whether or
        // not one is showing. This is the scrolling ancestor `VirtualGrid`
        // measures itself against, and its own height is what decides whether
        // a scrollbar appears — so without the gutter, content that lands
        // right on the boundary can add a scrollbar, lose the width that
        // justified it, and oscillate. Inert where scrollbars are overlays
        // (macOS's default), which is exactly where the problem doesn't exist.
        "relative flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** Bottom action strip of a panel (move/remove, add, counters…). A strip tall
 *  (`min-`: in a window too narrow for one line it wraps rather than clips),
 *  with the 6 px edges of the search row above it, so the two mirror. */
export function PanelFooter({ children, className, ...props }: PanelProps) {
  return (
    <div
      className={cn("flex min-h-strip shrink-0 flex-wrap items-center gap-1.5 border-t border-border px-1.5 py-0.5", className)}
      {...props}
    >
      {children}
    </div>
  );
}
