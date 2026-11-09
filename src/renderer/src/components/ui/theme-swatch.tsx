import { cn } from "@renderer/lib/utils";
import type { Theme } from "@shared/types/settings";

/**
 * A theme drawn as itself: the work screen in miniature — its bar, the three columns, a black monitor in
 * each of the two right ones — under `data-theme`, so every token inside resolves to THAT theme's value
 * whatever theme the app is in now (the tokens are defined on `[data-theme]`, not only on `:root`).
 * The welcome's theme cards.
 */
export function ThemeSwatch({ className, theme }: { className?: string; theme: Theme }) {
  return (
    <span
      className={cn("flex h-16 w-full flex-col overflow-hidden rounded-sm border border-border bg-background", className)}
      data-theme={theme}
    >
      <span className="h-2.5 shrink-0 border-b border-border bg-surface" />
      <span className="flex min-h-0 flex-1">
        <span className="flex w-1/4 flex-col gap-1 border-r border-border bg-surface p-1">
          <span className="h-1 w-3/4 rounded-full bg-muted" />
          <span className="h-1 w-1/2 rounded-full bg-muted" />
          <span className="h-1 w-2/3 rounded-full bg-active" />
        </span>
        {[0, 1].map((column) => (
          <span className="flex flex-1 flex-col gap-1 border-r border-border bg-card p-1 last:border-r-0" key={column}>
            <span className="aspect-video w-full rounded-sm bg-black" />
            <span className="h-1 w-2/3 rounded-full bg-muted" />
          </span>
        ))}
      </span>
    </span>
  );
}
