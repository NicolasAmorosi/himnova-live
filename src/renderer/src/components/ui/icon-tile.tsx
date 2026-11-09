import type { HTMLAttributes } from "react";
import { cn } from "@renderer/lib/utils";

type IconTileProps = HTMLAttributes<HTMLSpanElement> & {
  /** `step` a numbered dot, `badge` an icon's square beside a text, `picture` a card's whole picture area. */
  size?: "step" | "badge" | "picture";
};

const sizes: Record<NonNullable<IconTileProps["size"]>, string> = {
  step: "size-5 rounded-full text-xs font-semibold text-foreground",
  badge: "size-9 rounded-md [&>svg]:size-5",
  picture: "h-14 w-full rounded-sm [&>svg]:size-6",
};

/** An icon (or a step's number) on a tinted tile: the picture of a `ChoiceGroup` card that has no stage to
 *  show, the mark beside each of the welcome's ideas, a numbered step. Neutral on purpose: teal is
 *  «selected / on», never decoration. */
export function IconTile({ className, size = "badge", ...props }: IconTileProps) {
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center bg-muted text-muted-foreground", sizes[size], className)}
      {...props}
    />
  );
}
