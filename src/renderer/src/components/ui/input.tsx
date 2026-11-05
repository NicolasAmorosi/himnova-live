import type { InputHTMLAttributes, Ref } from "react";
import { cn } from "@renderer/lib/utils";
import { Icon, type IconName } from "./icon";

type InputSize = "xs" | "sm";

// `size` is re-typed away from the native numeric attribute (character width),
// which this design system never uses, to the same scale as `Select`.
type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  icon?: IconName;
  ref?: Ref<HTMLInputElement>;
  size?: InputSize;
};

// Same scale as `Select`, so an input and a dropdown sitting in the same
// toolbar line up without either one being nudged by hand.
const sizes: Record<InputSize, string> = {
  xs: "h-7 px-2 text-xs",
  sm: "h-8 px-3 text-sm",
};

const iconOffsets: Record<InputSize, { icon: string; padding: string }> = {
  xs: { icon: "left-2", padding: "pl-7" },
  sm: { icon: "left-2.5", padding: "pl-8" },
};

export function Input({ className, icon, ref, size = "sm", ...props }: InputProps) {
  const field = (
    <input
      className={cn(
        "w-full rounded-md border border-border bg-surface text-foreground placeholder:text-subtle focus-ring hover:border-border-light disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger/80 aria-invalid:focus-visible:outline-danger",
        sizes[size],
        icon && iconOffsets[size].padding,
        className,
      )}
      ref={ref}
      {...props}
    />
  );

  // The wrapper exists only to position the icon. Without one, an `<input>`
  // wrapped anyway was never the element a caller's `className` width could
  // control: the `<div>` is what takes up the room in a flex row, and it
  // ignored the class.
  if (!icon) return field;

  return (
    <div className="relative">
      <Icon
        className={cn("pointer-events-none absolute top-1/2 -translate-y-1/2 text-subtle", iconOffsets[size].icon)}
        name={icon}
      />
      {field}
    </div>
  );
}
