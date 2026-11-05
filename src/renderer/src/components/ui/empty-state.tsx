import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@renderer/lib/utils";
import { Icon, type IconName } from "./icon";

type EmptyStateProps = HTMLAttributes<HTMLDivElement> & {
  action?: ReactNode;
  description?: string;
  icon?: IconName;
  title: string;
  /** "danger" keeps the same dashed-box shape but marks it as an error
   *  state (e.g. a selected item whose file is gone) instead of a neutral
   *  "nothing here yet" placeholder. */
  tone?: "neutral" | "danger";
};

/** Fills its container and centers the box both ways. Positioned absolutely
 *  against the nearest positioned ancestor — always a `PanelBody`, which is
 *  `relative` for exactly this reason — instead of relying on flex-grow,
 *  which doesn't reach through a CSS Grid row (`SlidesPanel`'s layout) the
 *  way it does through a flex column. */
export function EmptyState({ action, className, description, icon, title, tone = "neutral", ...props }: EmptyStateProps) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div
        className={cn(
          // No box: a dashed outline is what a drop zone looks like, and most
          // of these are not one. The icon's disc carries the shape instead.
          "flex max-w-md flex-col items-center justify-center gap-2 p-6 text-center",
          className,
        )}
        {...props}
      >
        {/* The bare icon, no disc behind it (2026-11-04 redesign, P9): most of
            these are the normal state of an empty list, not an event. */}
        {icon ? (
          <Icon className={cn("size-5", tone === "danger" ? "text-danger-ink" : "text-subtle")} name={icon} />
        ) : null}
        <p className={cn("text-sm font-semibold", tone === "danger" ? "text-danger-ink" : "text-foreground")}>{title}</p>
        {description ? <p className="text-xs text-subtle">{description}</p> : null}
        {action}
      </div>
    </div>
  );
}
