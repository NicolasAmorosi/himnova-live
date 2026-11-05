import type { ButtonHTMLAttributes, Ref } from "react";
import { cn } from "@renderer/lib/utils";

/** Two looks only (2026-11-04 redesign, F4b): an icon button is a tool, never
 *  the main action of a surface — that is a `Button` with its word. */
type IconButtonVariant = "outline" | "ghost";
type IconButtonSize = "xs" | "sm" | "md";

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Required: an icon is all a sighted user gets, and nothing at all for a
   *  screen reader. A `Tooltip` around the button does not name it. Settings'
   *  own button shipped without a name for exactly that reason. */
  "aria-label": string;
  ref?: Ref<HTMLButtonElement>;
  size?: IconButtonSize;
  toggled?: boolean;
  variant?: IconButtonVariant;
};

const variants: Record<IconButtonVariant, string> = {
  outline: "border border-border bg-transparent text-foreground hover:border-accent hover:bg-muted",
  ghost: "text-foreground hover:bg-muted",
};

const sizes: Record<IconButtonSize, string> = {
  xs: "size-6",
  sm: "size-8",
  md: "size-10",
};

export function IconButton({
  className,
  ref,
  size = "sm",
  toggled = false,
  type = "button",
  variant = "outline",
  ...props
}: IconButtonProps) {
  return (
    <button
      aria-pressed={toggled || undefined}
      className={cn(
        "focus-ring inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        variants[variant],
        sizes[size],
        toggled && "border-accent bg-accent text-accent-foreground hover:bg-accent",
        className,
      )}
      ref={ref}
      type={type}
      {...props}
    />
  );
}
