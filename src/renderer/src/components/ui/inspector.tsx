import type { ReactNode } from "react";
import { cn } from "@renderer/lib/utils";
import { FieldLayoutContext } from "./field-layout";
import { Icon } from "./icon";
import { Title } from "./title";

/**
 * The right-hand column of a full-screen editor: the knobs of what the canvas
 * shows, in collapsible sections, scrolling on its own so the canvas never
 * moves. 352 px — Apple's inspectors sit at 225–300 pt and go up to 400; at 320
 * a 6 rem label column wrapped labels onto three lines and cut the Selects'
 * values (2026-11-04 review), so the column went to 7.5 rem and the inspector
 * grew with it — and every
 * `FieldRow` inside it is `compact` (label column + control beside it), set
 * here once through `FieldLayoutContext`.
 */
export function Inspector({ children, className, label }: { children: ReactNode; className?: string; label: string }) {
  return (
    <aside
      aria-label={label}
      className={cn("flex w-88 shrink-0 flex-col overflow-y-auto border-l border-border bg-surface", className)}
    >
      <FieldLayoutContext.Provider value="compact">{children}</FieldLayoutContext.Provider>
    </aside>
  );
}

/**
 * One titled group of an inspector, folded with the platform's own
 * `<details>`: the open/closed state, the keyboard (Enter/Space on the
 * summary) and what a screen reader announces all come with it. Open by
 * default — a section the operator has not asked to hide shows its knobs.
 */
export function InspectorSection({
  children,
  defaultOpen = true,
  title,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  title: string;
}) {
  return (
    <details className="group border-b border-border last:border-b-0" open={defaultOpen}>
      <summary className="flex h-10 cursor-pointer list-none items-center gap-1.5 px-4 select-none focus-ring-inset hover:bg-hover [&::-webkit-details-marker]:hidden">
        <Icon className="text-subtle transition-transform duration-150 group-open:rotate-90" name="chevronRight" />
        <Title as="h3">{title}</Title>
      </summary>
      <div className="flex flex-col gap-0.5 px-4 pb-4">{children}</div>
    </details>
  );
}
