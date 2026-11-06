import type { HTMLAttributes } from "react";
import { cn } from "@renderer/lib/utils";

/** A key, as printed inside a tooltip: the shortcut beside the action it
 *  runs (2026-11-05 review — Enter, L and B existed and nothing said so). */
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn("ml-1.5 rounded-sm border border-border px-1 font-sans text-2xs text-muted-foreground", className)}
      {...props}
    />
  );
}
