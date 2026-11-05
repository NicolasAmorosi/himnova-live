import type { ReactNode } from "react";
import { cn } from "@renderer/lib/utils";

type MediaPanelProps = {
  children: ReactNode;
  className?: string;
};

/**
 * The one container every media-transport row lives in — the live
 * panel, the preview bar, the deck transport. A single shared shell is what
 * keeps all three visually identical instead of drifting apart one Tailwind
 * tweak at a time.
 *
 * `min-w-0` is load-bearing: this shell sits directly in a CSS grid row, and
 * without it a track name with no break points (an unspaced filename) sets
 * this box's automatic min-width to its own content size instead of 0,
 * ballooning the whole row past the column and pushing every row's trailing
 * button out of the clipped, unreachable overflow — the truncating label
 * inside never gets a chance to shrink.
 */
export function MediaPanel({ children, className }: MediaPanelProps) {
  return (
    <div
      // No border of its own (2026-11-04 redesign, P8): the card's fill already
      // sets it apart from the column, and a line around every row was one
      // more box inside a box.
      className={cn("flex min-w-0 flex-col divide-y divide-border rounded-md bg-card", className)}
    >
      {children}
    </div>
  );
}
