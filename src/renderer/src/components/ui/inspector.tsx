import { createContext, useContext, useState, type ReactNode } from "react";
import { cn } from "@renderer/lib/utils";
import { FieldLayoutContext } from "./field-layout";
import { Icon } from "./icon";
import { Title } from "./title";

/** Which inspector a section belongs to, so it remembers its own open/closed
 *  state apart from the same title in another editor. */
const InspectorScope = createContext<string | null>(null);

/** Per viewer, per machine: a convenience, so a closed or unreadable storage
 *  just means sections open as they start. */
function readOpen(key: string): boolean | null {
  try {
    const value = localStorage.getItem(key);
    return value === null ? null : value === "1";
  } catch {
    return null;
  }
}

function writeOpen(key: string, open: boolean): void {
  try {
    localStorage.setItem(key, open ? "1" : "0");
  } catch {
    // Nothing to do: the section simply forgets.
  }
}

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
      <InspectorScope value={label}>
        <FieldLayoutContext.Provider value="compact">{children}</FieldLayoutContext.Provider>
      </InspectorScope>
    </aside>
  );
}

/**
 * One titled group of an inspector, folded with the platform's own
 * `<details>`: the open/closed state, the keyboard (Enter/Space on the
 * summary) and what a screen reader announces all come with it. Open by
 * default — a section the operator has not asked to hide shows its knobs —
 * except the rarely used ones (`defaultOpen={false}`), and once the operator
 * folds or opens one, that is how it opens next time (owner, 2026-11-05:
 * the themes inspector ran to ~45 rows, the scenes one to ~55).
 */
export function InspectorSection({
  children,
  defaultOpen = true,
  onFocus,
  title,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  /** A control inside took focus: the editor can turn its canvas to what this
   *  section dresses — the last slide for the footer, the end of a countdown
   *  (2026-11-05 review: a knob whose effect the canvas does not show). */
  onFocus?: (() => void) | undefined;
  title: string;
}) {
  const scope = useContext(InspectorScope);
  const key = scope ? `inspector.open:${scope}:${title}` : null;
  // Read once: `open` must stay the same prop afterwards, or a re-render would
  // fold back what the operator just opened.
  const [initiallyOpen] = useState(() => (key ? readOpen(key) : null) ?? defaultOpen);
  return (
    <details
      className="group border-b border-border last:border-b-0"
      onFocus={onFocus}
      // `<details open>` fires `toggle` as it mounts: saved only once the
      // state differs from the default (or something was saved already), so a
      // later change to a section's default still reaches everyone else.
      onToggle={(e) => {
        const open = e.currentTarget.open;
        if (key && (readOpen(key) !== null || open !== defaultOpen)) writeOpen(key, open);
      }}
      open={initiallyOpen}
    >
      <summary className="flex h-10 cursor-pointer list-none items-center gap-1.5 px-4 select-none focus-ring-inset hover:bg-hover [&::-webkit-details-marker]:hidden">
        <Icon className="text-subtle transition-transform duration-150 group-open:rotate-90" name="chevronRight" />
        <Title as="h3">{title}</Title>
      </summary>
      <div className="flex flex-col gap-0.5 px-4 pb-4">{children}</div>
    </details>
  );
}
