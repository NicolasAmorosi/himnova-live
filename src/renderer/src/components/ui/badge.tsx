import type { HTMLAttributes } from "react";
import { cn } from "@renderer/lib/utils";

export type BadgeVariant = "blue" | "neutral" | "danger" | "success" | "ppt" | "video" | "image" | "audio" | "bible";

/**
 * Tint carries the meaning, `text-foreground` carries the text.
 *
 * Every colored variant used to be `bg-<color>/20 text-<color>` — tint and
 * label in the same hue, which is the classic way to fail contrast. Measured
 * against the real tokens in the dark theme (the default, and the one used in
 * a darkened booth) the nine variants landed between **2,18:1 and 3,19:1**,
 * against the 4,5:1 WCAG AA asks of text this size. Keeping the identical tint
 * and only swapping the label to the foreground token takes the same badges to
 * **~12,5–13,8:1**, and the color still says what kind of content it is —
 * which is the entire job the `--wa-badge-*` tokens have.
 *
 * The three semantic tints match the content ones at /20 so no variant reads
 * as a weaker version of the others now that none of them is carrying the hue
 * in its text. `neutral` is left alone: it was never color-on-its-own-tint,
 * and being quieter than the rest is the point of it.
 */
const variants: Record<BadgeVariant, string> = {
  blue: "bg-accent/20 text-foreground",
  neutral: "bg-muted text-muted-foreground",
  danger: "bg-danger/20 text-foreground",
  success: "bg-success/20 text-foreground",
  ppt: "bg-badge-ppt/20 text-foreground",
  video: "bg-badge-video/20 text-foreground",
  image: "bg-badge-image/20 text-foreground",
  audio: "bg-badge-audio/20 text-foreground",
  bible: "bg-badge-bible/20 text-foreground",
};

type BadgeProps = HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant };

export function Badge({ className, variant = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}

/**
 * A section of a song as a chip that is not a button — the order of a song,
 * where each chip is dragged and has its own ✕. The same box as the section
 * buttons beside it (`Button` outline `xs`: 28 px, 6 px, 1 px border), so a
 * song's sections have ONE look everywhere (2026-11-04 review: they had three).
 * `danger` marks a chip whose section no longer exists.
 */
export function Token({ className, danger = false, ...props }: HTMLAttributes<HTMLSpanElement> & { danger?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium text-foreground",
        danger ? "border-danger-ink" : "border-border",
        className,
      )}
      {...props}
    />
  );
}
