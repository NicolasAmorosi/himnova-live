import type { ReactNode } from "react";
import { cn } from "@renderer/lib/utils";

type MonitorProps = {
  /** The stage content — an OutputView, normally. */
  children?: ReactNode;
  className?: string;
  /** Shown on the black stage when there is nothing to render. Kept here (and
   *  not as a caller-side EmptyState) because the stage is always black in
   *  both themes, so its text has to be light in both. */
  empty?: string;
  /** The LIVE monitor while content IS on the projector (not BLACK, LOGO or
   *  no screen): a red edge, broadcast tally's «on air» (owner, 2026-11-05). */
  onAir?: boolean;
};

/**
 * The EasyWorship-style monitor: a bare 16:9 stage with one neutral border —
 * the same on both panes; the only status colour is `onAir`'s red — the
 * ONE primitive for both the live and the preview pane, which is exactly what
 * keeps the two panes visually identical by construction. Which one is which
 * (label, on-air state) lives in each column's own header, not here.
 */
export function Monitor({ children, className, empty, onAir = false }: MonitorProps) {
  return (
    // `shrink-0`: both columns are flex columns, and `overflow-hidden` drops a
    // flex item's automatic minimum height to 0 — a column with more rows
    // under its monitor would otherwise squeeze that stage first.
    <div className={cn("flex shrink-0 justify-center overflow-hidden p-3 pb-0", className)}>
      {/* The 16:9 stage's height always follows its width, never the leftover
          space in whatever grid row it lands in — a sibling (deck transport,
          a media track row) taking more or less height below it must never
          change how big this box renders. That decoupling is what keeps the
          LIVE and PREVIEW monitors pixel-identical, and keeps a PPT deck's
          transport controls from squeezing the live rectangle smaller than a
          plain video's.

          The border is what keeps a stage whose content is the app's own
          colour from melting into the panel. It sits on the outer box and the
          ratio on the inner one, so the picture inside stays exactly 16:9 —
          a border on the `aspect-video` box itself would eat 2px out of a
          ratio the projector doesn't share. */}
      {/* On air, a 2 px red ring drawn OVER the picture (an `::after` above it)
          plus the border itself: an outline under the picture showed only its
          border pixel, 1 px of red (2026-11-05 review), and a thicker border
          would shrink the 16:9 box. The ring has no radius of its own: the
          box's `overflow-hidden` rounds it to the inner edge (6 − 1 px). With
          `rounded-md` its 6 px corner sat inside that 5 px clip and left a
          sliver of the black stage at each corner (owner, 2026-11-05); and the
          black stops at the border (`bg-clip-padding`), so the curved border's
          soft pixels blend with the panel and not with black. */}
      <div
        className={cn(
          "relative w-full overflow-hidden rounded-md border border-border bg-black bg-clip-padding",
          onAir &&
            "border-on-air after:pointer-events-none after:absolute after:inset-0 after:z-10 after:ring-2 after:ring-on-air after:ring-inset",
        )}
      >
        <div className="flex aspect-video w-full items-center justify-center">
          {children ?? (
            <span className="px-4 text-center text-xs text-white/60">{empty}</span>
          )}
        </div>
      </div>
    </div>
  );
}
