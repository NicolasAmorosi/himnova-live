import { Children, type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";
import { cn } from "@renderer/lib/utils";

type ButtonVariant = "primary" | "outline" | "ghost" | "danger" | "live" | "link";
type ButtonSize = "xs" | "sm" | "md" | "lg";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  loading?: boolean;
  loadingLabel?: string | undefined;
  ref?: Ref<HTMLButtonElement>;
  size?: ButtonSize;
  toggled?: boolean;
  variant?: ButtonVariant;
};

const variants: Record<ButtonVariant, string> = {
  // The border is the dark theme's: its primary is 1.31:1 from the background,
  // and without an edge the button is a label floating on nothing. On the
  // light theme `primary-border` IS the fill, so it adds nothing there.
  primary: "border border-primary-border bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-hover/80",
  outline: "border border-border bg-transparent text-foreground hover:border-accent hover:bg-muted active:bg-muted/80",
  ghost: "text-foreground hover:bg-muted active:bg-muted/80",
  danger: "bg-danger text-danger-foreground hover:bg-danger/90 active:bg-danger/75",
  live: "bg-success text-success-foreground hover:bg-success/90 active:bg-success/75",
  // Text that acts, inside a sentence: a toast's "Undo", a callout's
  // "Retry", the deck transport's "Resync". It had been written by
  // hand in three features before it became a variant. No box of its own — it
  // drops the height, padding and background every other variant carries, so
  // it sits on the line of the text around it.
  link: "h-auto rounded-sm bg-transparent p-0 text-accent-ink underline-offset-2 hover:underline active:opacity-80",
};

// `link` has no box, so the size scale can only mean type size. Kept as its
// own Record rather than a special case inside `sizes` because a link and a
// button of the same `size` are not the same height, and pretending otherwise
// is how one of them ends up nudged by hand at a call site.
/** How a disabled button looks. A filled one turns into a quiet grey button
 *  instead of fading: at 60% opacity the light theme's navy read as a
 *  pale-blue button you could press (the editors' «Save» did, 2026-11-04). An
 *  unfilled one only dims — it has no fill to give up. */
const disabledVariants: Record<ButtonVariant, string> = {
  // No fill at all: in the dark theme the navy primary and a grey fill were
  // two dark rectangles 0.1 apart in lightness — enabled and disabled read the
  // same (2026-11-04 review).
  primary: "disabled:border-border disabled:bg-transparent disabled:text-subtle",
  outline: "disabled:opacity-50",
  ghost: "disabled:opacity-50",
  danger: "disabled:bg-muted disabled:text-subtle",
  live: "disabled:bg-muted disabled:text-subtle",
  link: "disabled:opacity-50",
};

const linkSizes: Record<ButtonSize, string> = {
  xs: "text-xs",
  sm: "text-sm",
  md: "text-sm",
  lg: "text-base",
};

const sizes: Record<ButtonSize, string> = {
  xs: "h-7 px-2 text-xs gap-1",
  sm: "h-8 px-3 text-sm gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-12 px-5 text-base gap-2",
};

/** Puts each run of text children in its own `truncate` span. A bare text
 *  node is an anonymous flex item, and those can't ellipsize: a squeezed
 *  button clipped its label mid-letter (and, before `Icon` was `shrink-0`,
 *  shrank the icon beside it). Adjacent strings stay one run, so
 *  `{count} {label}` keeps its space. */
function truncateText(children: ReactNode): ReactNode[] {
  const out: ReactNode[] = [];
  let run = "";
  const flush = () => {
    if (run.trim()) out.push(<span className="truncate" key={`text-${out.length}`}>{run}</span>);
    run = "";
  };
  for (const child of Children.toArray(children)) {
    if (typeof child === "string" || typeof child === "number") run += child;
    else {
      flush();
      out.push(child);
    }
  }
  flush();
  return out;
}

export function Button({
  children,
  className,
  disabled,
  loading = false,
  loadingLabel,
  ref,
  size = "sm",
  toggled = false,
  type = "button",
  variant = "primary",
  ...props
}: ButtonProps) {
  const disabledEffective = disabled || loading;
  return (
    <button
      aria-busy={loading || undefined}
      aria-pressed={toggled || undefined}
      className={cn(
        // 6 px, GitHub's (owner, 2026-11-04): the identity's pills read as
        // «heavily rounded». 32 px by default; `md` (40) is what is pressed
        // during a service.
        "focus-ring relative inline-flex cursor-pointer items-center justify-center overflow-hidden rounded-md font-medium transition-colors disabled:cursor-not-allowed",
        variants[variant],
        disabledVariants[variant],
        variant === "link" ? linkSizes[size] : sizes[size],
        // A pressed toggle is FILLED with the accent, whatever its variant.
        // It used to be a ring in the focus ring's own colour, so "this one is
        // on" and "this one has the keyboard" looked the same.
        toggled && "border-accent bg-accent text-accent-foreground hover:bg-accent active:bg-accent",
        className,
      )}
      disabled={disabledEffective}
      ref={ref}
      type={type}
      {...props}
    >
      <span className={cn("inline-flex min-w-0 items-center justify-center gap-2", loading && "invisible")}>
        {truncateText(children)}
      </span>
      {loading ? (
        <>
          <span
            aria-hidden="true"
            className="absolute top-1/2 left-1/2 h-2 w-24 max-w-[calc(100%-1.5rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-full bg-current/25"
          >
            <span className="wa-button-loading-shimmer block h-full w-1/2 rounded-full bg-current/60" />
          </span>
          {loadingLabel ? <span className="sr-only">{loadingLabel}</span> : null}
        </>
      ) : null}
    </button>
  );
}
