import type { KeyboardEvent, ReactNode } from "react";
import { isPointerFocused } from "@renderer/lib/focus-modality";
import { cn } from "@renderer/lib/utils";
import { Icon, type IconName } from "./icon";

export type TabItem<T extends string> = { icon?: IconName; label: string; value: T };

export type TabsVariant = "underline" | "segment" | "sidebar";

type TabsProps<T extends string> = {
  className?: string;
  /** Shared with the `TabPanel`s this list controls, so tab and panel can
   *  point at each other (`aria-controls` / `aria-labelledby`). Omit it when
   *  the content isn't rendered as a `tabpanel` at all. */
  idBase?: string;
  onChange: (value: T) => void;
  tabs: readonly TabItem<T>[];
  /** "underline" is the resource panel's first level (GitHub's UnderlineNav;
   *  it was EasyWorship-style folder tabs until the 2026-11-04 redesign, P6).
   *  "segment" is the row that sits UNDER it, for the second level of the
   *  same panel. "sidebar" is a vertical category list, e.g. Settings' left
   *  column. */
  variant?: TabsVariant;
  value: T;
};

/** The two halves of one tab's identity. Kept as functions so the tab and its
 *  panel can never disagree about the string. */
function tabDomId(idBase: string, value: string): string {
  return `${idBase}-tab-${value}`;
}

function panelDomId(idBase: string, value: string): string {
  return `${idBase}-panel-${value}`;
}

const isVertical: Record<TabsVariant, boolean> = {
  underline: false,
  segment: false,
  sidebar: true,
};

const listVariants: Record<TabsVariant, string> = {
  // Both a strip tall, like every bar of the main window (`h-strip`), on the
  // 6 px edge of every strip with boxes, and with the same gap: the four
  // resource tabs sit right over the four segments under them.
  underline: "flex h-strip items-stretch gap-1 border-b border-border px-1.5",
  segment: "flex h-strip items-center gap-1 border-b border-border px-1.5",
  sidebar: "flex w-56 shrink-0 flex-col items-stretch gap-1 overflow-y-auto border-r border-border p-2",
};

const tabVariants: Record<TabsVariant, string> = {
  // `-mb-px`: the active tab's line sits ON the list's own bottom border.
  // `flex-1`: every tab takes the same share of the row and together they fill
  // it, whatever the length of each label (owner, 2026-11-04).
  // Stretched to the list's height, so the line lands on its border whatever
  // that height is.
  underline: "-mb-px min-w-0 flex-1 justify-center gap-1.5 border-b-2 px-1 text-sm",
  // No tab-shaped border, on purpose: a second row of tabs under the first
  // reads as two competing levels of the same thing. This one is a segmented
  // control — a filled segment inside the panel the first row opened.
  segment: "h-7 min-w-0 flex-1 justify-center gap-1 rounded-md px-2 text-xs",
  // GitHub's NavList: a 32 px row, and the chosen one marked by a 4 px bar of
  // the accent on its left over a quiet fill — not a filled pill.
  sidebar:
    "relative h-8 w-full shrink-0 justify-start gap-2 rounded-md px-3 text-sm before:absolute before:inset-y-1.5 before:-left-2 before:w-1 before:rounded-full",
};

const activeVariants: Record<TabsVariant, string> = {
  underline: "border-accent text-foreground",
  segment: "bg-active text-foreground ring-1 ring-accent/40 ring-inset",
  sidebar: "bg-muted font-semibold text-foreground before:bg-accent",
};

const inactiveVariants: Record<TabsVariant, string> = {
  underline: "border-transparent text-subtle hover:text-foreground",
  segment: "text-subtle hover:bg-hover hover:text-foreground",
  sidebar: "border-transparent text-muted-foreground hover:bg-hover hover:text-foreground",
};

export function Tabs<T extends string>({
  className,
  idBase,
  onChange,
  tabs,
  value,
  variant = "underline",
}: TabsProps<T>) {
  const vertical = isVertical[variant];

  // Roving arrow-key navigation, the standard `tablist` keyboard contract:
  // Left/Right for a horizontal list, Up/Down for a vertical one.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const nextKey = vertical ? "ArrowDown" : "ArrowRight";
    const prevKey = vertical ? "ArrowUp" : "ArrowLeft";
    if (event.key !== nextKey && event.key !== prevKey) return;
    // Clicked, the arrows are the operator's shortcuts (→ moves the slide on
    // the projector), as on any clicked control; reached with Tab, they walk
    // the tabs. See `use-global-shortcuts.ts`.
    if (isPointerFocused(event.target)) return;
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.value === value);
    const delta = event.key === nextKey ? 1 : -1;
    const nextIndex = (index + delta + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    if (!next) return;
    onChange(next.value);
    // Roving tabindex is only half the contract: selection moves the `0` to
    // the new tab, and focus has to follow it, or the next arrow key is read
    // by a button that is now `tabIndex={-1}` and the operator is stranded
    // one tab behind what is actually selected.
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons[nextIndex]?.focus();
  }

  return (
    /* eslint-disable-next-line jsx-a11y/interactive-supports-focus -- The
       tablist is the delegate, not the tab stop: roving tabindex puts the
       single `0` on the selected tab button, and the arrows are caught here
       only because they bubble from it. Making the container focusable would
       add a stop that lands on nothing. */
    <div
      aria-orientation={vertical ? "vertical" : "horizontal"}
      className={cn(listVariants[variant], className)}
      onKeyDown={onKeyDown}
      role="tablist"
    >
      {tabs.map((tab) => {
        const active = tab.value === value;
        return (
          <button
            aria-controls={idBase ? panelDomId(idBase, tab.value) : undefined}
            aria-selected={active}
            className={cn(
              "focus-ring-inset inline-flex cursor-pointer items-center font-medium transition-colors",
              tabVariants[variant],
              active ? activeVariants[variant] : inactiveVariants[variant],
            )}
            id={idBase ? tabDomId(idBase, tab.value) : undefined}
            key={tab.value}
            onClick={() => onChange(tab.value)}
            // The full name, only on a label that is actually cut. Measured on
            // hover and not at render: whether it fits depends on the window.
            onPointerEnter={(event) => {
              const label = event.currentTarget.lastElementChild;
              event.currentTarget.title = label && label.scrollWidth > label.clientWidth ? tab.label : "";
            }}
            role="tab"
            tabIndex={active ? 0 : -1}
            type="button"
          >
            {/* The words are what fit (2026-11-04 locale tour: «Presentaciones» was
                cut at 1440, «Canciones» and «Funciones» at the 1000 px minimum):
                a segment shows no icon, and the resource tabs drop theirs in a
                narrow window. */}
            {tab.icon && variant !== "segment" ? (
              <Icon className={cn("size-3.5", variant === "underline" && "max-[1100px]:hidden")} name={tab.icon} />
            ) : null}
            {/* A bare text node is an anonymous flex item and can't ellipsize. */}
            <span className="truncate">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The box every `TabPanel` is stacked inside. Positioned, because the panels
 * overlap: a tab that has been visited stays mounted (see `TabPanel`) and the
 * inactive ones sit underneath the active one rather than beside it.
 */
export function TabPanels({ children }: { children: ReactNode }) {
  return <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>;
}

/**
 * One tab's content, inside a `TabPanels`.
 *
 * An inactive panel is hidden with `visibility`, never unmounted and never
 * `display: none`. Both of those destroy the layout box, and with it the
 * scroll offset of everything inside — which for a virtualized grid means
 * coming back to the top of a folder of 600 files, re-measuring, re-reading
 * `deck:statuses` and re-warming from scratch. `visibility: hidden` keeps the
 * box (so scroll position and measured widths survive) while taking the
 * subtree out of the tab order and off the screen.
 */
export function TabPanel({
  active,
  children,
  idBase,
  value,
}: {
  active: boolean;
  children: ReactNode;
  /** Must match the `idBase` given to the controlling `Tabs`. */
  idBase: string;
  value: string;
}) {
  return (
    <div
      aria-hidden={!active || undefined}
      aria-labelledby={tabDomId(idBase, value)}
      className={cn(
        "absolute inset-0 flex min-h-0 flex-col overflow-hidden",
        !active && "invisible pointer-events-none",
      )}
      id={panelDomId(idBase, value)}
      role="tabpanel"
    >
      {children}
    </div>
  );
}
