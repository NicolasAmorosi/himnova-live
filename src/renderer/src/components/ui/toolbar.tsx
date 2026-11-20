import type { HTMLAttributes } from "react";
import { cn } from "@renderer/lib/utils";

/** The app's chrome bars: the top toolbar and the bottom status bar. */
export function Toolbar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex h-strip shrink-0 items-center gap-2 border-b border-border bg-surface px-2", className)}
      {...props}
    />
  );
}
