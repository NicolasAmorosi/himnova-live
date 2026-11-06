import type { HTMLAttributes, LabelHTMLAttributes, ReactNode } from "react";
import { cn } from "@renderer/lib/utils";

type TitleProps = HTMLAttributes<HTMLHeadingElement> & { as?: "h1" | "h2" | "h3" };

// h1 and h2 are set in Noto Sans ExtraCondensed, the identity's display cut;
// h3 names a dialog or a group in running UI and stays in the text cut. A
// condensed face reads smaller than its size, hence the step up from the text
// scale (h2: 15px where a text label would be 14).
const sizes: Record<NonNullable<TitleProps["as"]>, string> = {
  h1: "font-stretch-extra-condensed text-2xl font-extrabold tracking-tight",
  h2: "font-stretch-extra-condensed text-[0.9375rem] font-bold uppercase tracking-wider text-muted-foreground",
  h3: "text-sm font-semibold",
};

export function Title({ as = "h2", className, ...props }: TitleProps) {
  const Component = as;
  return <Component className={cn(sizes[as], className)} {...props} />;
}

/** The heading of a page in a full-screen screen with sections (Settings):
 *  a 20 px title; its groups below are boxes, so no line under it (2026-11-05). */
export function PageHeader({ children }: { children: ReactNode }) {
  return <h2 className="text-xl font-semibold text-foreground">{children}</h2>;
}

/** `Label`'s typography without the `<label>` semantics — for text that names
 *  something that is not a form control (a `progressbar`, a group), pointed at
 *  with `aria-labelledby`. */
export function Caption({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("text-xs font-medium text-muted-foreground", className)} {...props} />;
}

/** A form field's caption. The association is the call site's job — pass
 *  `htmlFor`, or wrap the control — because a primitive cannot know which
 *  control it names. Anything that is NOT naming a form control wants plain
 *  text, not this. */
export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    /* eslint-disable-next-line jsx-a11y/label-has-associated-control -- the
       rule reads one file at a time and cannot see the `htmlFor` a caller
       spreads in. */
    <label className={cn("text-xs font-medium text-muted-foreground", className)} {...props} />
  );
}
