import type { HTMLAttributes } from "react";
import { cn } from "@renderer/lib/utils";

type IconTileProps = HTMLAttributes<HTMLSpanElement> & {
  /** `step` a numbered dot, `badge` an icon's square beside a text, `picture` a card's whole picture area. */
  size?: "step" | "badge" | "picture";
  /** `accent` for what the text beside it is about (the tour's ideas), `muted` otherwise. */
  tone?: "muted" | "accent";
};

const tones: Record<NonNullable<IconTileProps["tone"]>, string> = {
  muted: "bg-muted text-muted-foreground",
  accent: "bg-active text-accent-ink",
};

const sizes: Record<NonNullable<IconTileProps["size"]>, string> = {
  step: "size-5 rounded-full text-xs font-semibold text-foreground",
  badge: "size-9 rounded-md [&>svg]:size-5",
  picture: "h-14 w-full rounded-sm [&>svg]:size-6",
};

/** An icon (or a step's number) on a tinted tile: the picture of a `ChoiceGroup` card that has no stage to
 *  show, the mark beside each of the welcome's ideas, a numbered step. */
export function IconTile({ className, size = "badge", tone = "muted", ...props }: IconTileProps) {
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center", tones[tone], sizes[size], className)}
      {...props}
    />
  );
}
