import type { HTMLAttributes } from "react";
import { cn } from "@renderer/lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-md border border-border bg-card text-card-foreground shadow-surface", className)}
      {...props}
    />
  );
}

/** GitHub's «Box»: a framed area inside a canvas — 1 px border, 6 px, the
 *  fields' surface, no shadow (the song editor's lyrics box has this look, as
 *  a field). The programs screen frames its items in one; Settings, the logo. */
export function Box({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-md border border-border bg-surface", className)} {...props} />;
}
