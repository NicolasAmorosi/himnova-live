import type { Ref, TextareaHTMLAttributes } from "react";
import { cn } from "@renderer/lib/utils";

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  ref?: Ref<HTMLTextAreaElement>;
};

/**
 * The multi-line counterpart to `Input`, and deliberately its exact border,
 * background, radius, type and focus ring — the two sit in the same forms, and
 * eight classes copied from `Input` into a feature (which is where this came
 * from) drift apart the first time the ring or the radius is touched.
 *
 * `resize-none` is the default rather than a call-site decision: every
 * textarea in this app lives inside a panel with a fixed width and its own
 * scroll, and a user-dragged corner there does not grow the panel — it just
 * overlaps what is under it.
 */
export function Textarea({ className, ref, ...props }: TextareaProps) {
  return (
    <textarea
      className={cn(
        "w-full resize-none rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-subtle focus-ring hover:border-border-light disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger/80 aria-invalid:focus-visible:outline-danger",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
}
