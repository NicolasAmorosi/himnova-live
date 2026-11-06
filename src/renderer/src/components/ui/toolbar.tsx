import type { HTMLAttributes } from "react";
import { cn } from "@renderer/lib/utils";

type ToolbarProps = HTMLAttributes<HTMLDivElement> & { border?: "top" | "bottom" | "none" };

const borders: Record<NonNullable<ToolbarProps["border"]>, string> = {
  top: "border-t border-border",
  bottom: "border-b border-border",
  none: "",
};

/** The app's chrome bars: the top toolbar and the bottom status bar. */
export function Toolbar({ border = "bottom", className, ...props }: ToolbarProps) {
  return (
    <div
      className={cn("flex h-strip shrink-0 items-center gap-2 bg-surface px-2", borders[border], className)}
      {...props}
    />
  );
}

/** A visually grouped cluster of controls inside a Toolbar. */
export function ToolbarGroup({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center gap-1.5", className)} {...props} />;
}
