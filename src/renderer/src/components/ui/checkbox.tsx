import type { InputHTMLAttributes } from "react";
import { cn } from "@renderer/lib/utils";

export function Switch({ className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <input
      className={cn(
        "relative h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-md bg-muted transition-colors before:absolute before:top-0.5 before:left-0.5 before:size-4 before:rounded-sm before:bg-white before:shadow-surface before:transition-transform checked:bg-accent checked:before:translate-x-4 focus-ring disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      role="switch"
      type="checkbox"
      {...props}
    />
  );
}
