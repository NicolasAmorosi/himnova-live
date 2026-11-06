import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isPointerFocused } from "@renderer/lib/focus-modality";
import { cn } from "@renderer/lib/utils";
import { computeMenuPosition, useFollowTrigger, type MenuPosition } from "./floating-menu";
import { Icon, type IconName } from "./icon";
import { IconButton } from "./icon-button";

export type MenuOption<T extends string> = {
  /** Shown greyed and skipped by the arrows — kept in the list so it never
   *  reflows under the pointer (an editor's «Delete» on a draft). */
  disabled?: boolean;
  label: string;
  /** `danger` writes a destructive command in the danger ink: the word says
   *  what it does, the colour only confirms it. */
  tone?: "danger";
  value: T;
};

type MenuSize = "xs" | "sm";

type MenuProps<T extends string> = {
  align?: "start" | "end";
  className?: string;
  disabled?: boolean;
  icon: IconName;
  /** Accessible name of the list, and of the trigger when it has no `text`. */
  label: string;
  onSelect: (value: T) => void;
  options: readonly MenuOption<T>[];
  size?: MenuSize;
  /** The option in effect, rendered checked (`menuitemradio`). Left out, the
   *  menu is a list of COMMANDS (`menuitem`, nothing checked): an editor's
   *  «⋯» with Duplicate and Delete. */
  value?: T | undefined;
};

/** Sized by its longest label rather than by its trigger: an icon button is
 *  28px and a list is not. Wide enough for the longest sort order in Spanish
 *  without wrapping, narrow enough to sit inside the resource column. */
const MENU_WIDTH_PX = 224;

/** `Input`'s scale, not `IconButton`'s. A menu trigger always sits next to a
 *  field in a toolbar row, and `IconButton`'s own xs (24px) next to an xs
 *  input (28px) reads as a button that slipped. `cn` resolves the later class,
 *  so this is the height that wins. */
const triggerSizes: Record<MenuSize, string> = { xs: "size-7", sm: "size-8" };

/**
 * An icon button that opens a short list of choices, one of which is in
 * effect.
 *
 * The list is a portal positioned against the viewport (`computeMenuPosition`,
 * shared with `Select`), because every panel here clips its overflow.
 *
 * Unlike `Select`, focus MOVES into the list: each option is a real `<button
 * role="menuitemradio">` and the arrows walk between them. That is the ARIA
 * menu pattern, and it is also what keeps the global shortcuts off this
 * widget — `use-global-shortcuts` suppresses Enter/Space/arrows for a focused
 * `<button>`, so picking an order with the keyboard can never also send the
 * preview to the projector.
 */
export function Menu<T extends string>({
  align = "start",
  className,
  disabled,
  icon,
  label,
  onSelect,
  options,
  size = "xs",
  value,
}: MenuProps<T>) {
  const id = useId();
  const menuId = `${id}-menu`;
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  /** Which option holds focus while the menu is open. Opening lands on the one
   *  in effect, so the first arrow key moves from where the operator is. */
  const [focusIndex, setFocusIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // The items hold focus while the menu is open, so closing it hands focus back.
  useFollowTrigger(
    open,
    triggerRef,
    (trigger) => setPosition(computeMenuPosition(trigger, MENU_WIDTH_PX, align)),
    () => close(true),
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Focus follows the index while the menu is open — including on the frame it
  // opens, which is what makes the keyboard path work at all.
  useEffect(() => {
    if (open) itemRefs.current[focusIndex]?.focus();
  }, [focusIndex, open]);

  function openMenu() {
    if (options.length === 0 || !triggerRef.current) return;
    setPosition(computeMenuPosition(triggerRef.current, MENU_WIDTH_PX, align));
    const current = options.findIndex((option) => option.value === value && !option.disabled);
    setFocusIndex(current >= 0 ? current : Math.max(0, options.findIndex((option) => !option.disabled)));
    setOpen(true);
  }

  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  }

  function handleTriggerKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    // Clicked, the trigger's arrows are the operator's shortcuts, as on any
    // clicked control (see `use-global-shortcuts.ts`).
    if (open || (e.key !== "ArrowDown" && e.key !== "ArrowUp") || isPointerFocused(e.currentTarget)) return;
    e.preventDefault();
    openMenu();
  }

  /** The next enabled option from `index` in `step`'s direction, wrapping. */
  function step(index: number, by: 1 | -1): number {
    for (let i = 1; i <= options.length; i++) {
      const next = (index + by * i + options.length) % options.length;
      if (!options[next]?.disabled) return next;
    }
    return index;
  }

  function handleItemKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setFocusIndex(step(index, 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setFocusIndex(step(index, -1));
        break;
      case "Home":
        e.preventDefault();
        setFocusIndex(step(-1, 1));
        break;
      case "End":
        e.preventDefault();
        setFocusIndex(step(options.length, -1));
        break;
      case "Escape":
        e.preventDefault();
        close(true);
        break;
      case "Tab":
        // Not prevented: Tab out of an open menu closes it and lets focus go
        // where the operator sent it.
        close(false);
        break;
    }
  }

  // Not `toggled`: that prop means `aria-pressed`, and a button that is
  // already saying `aria-expanded` is not also a toggle — the two together are
  // read out as two different states of the same control. The open look is
  // the same one hover gives, held.
  const triggerProps = {
    "aria-controls": open ? menuId : undefined,
    "aria-expanded": open,
    "aria-haspopup": "menu" as const,
    disabled,
    onClick: () => (open ? close(false) : openMenu()),
    onKeyDown: handleTriggerKeyDown,
    ref: triggerRef,
  };
  const trigger = (
    <IconButton
      {...triggerProps}
      aria-label={label}
      className={cn(triggerSizes[size], open && "border-accent bg-muted", className)}
      size="xs"
      variant="ghost"
    >
      <Icon name={icon} />
    </IconButton>
  );

  const menu =
    open && position
      ? createPortal(
          <ul
            aria-label={label}
            className="fixed z-[var(--z-popover)] overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-overlay"
            id={menuId}
            ref={menuRef}
            role="menu"
            style={{
              left: position.left,
              maxHeight: position.maxHeight,
              width: position.width,
              ...(position.top !== undefined ? { top: position.top } : { bottom: position.bottom }),
            }}
          >
            {options.map((option, index) => (
              <li key={option.value} role="none">
                <button
                  aria-checked={value === undefined ? undefined : option.value === value}
                  className={cn(
                    "flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-hover focus-visible:bg-hover focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
                    option.tone === "danger" && "text-danger-ink",
                  )}
                  disabled={option.disabled}
                  onClick={(e) => {
                    onSelect(option.value);
                    // Back to the trigger only after a keyboard pick (`detail`
                    // 0): put there by code after a MOUSE pick, it would read
                    // as the keyboard's and keep the arrows (see `Select`).
                    close(e.detail === 0);
                  }}
                  onKeyDown={(e) => handleItemKeyDown(e, index)}
                  ref={(el) => {
                    itemRefs.current[index] = el;
                  }}
                  role={value === undefined ? "menuitem" : "menuitemradio"}
                  tabIndex={-1}
                  type="button"
                >
                  <span className="truncate">{option.label}</span>
                  {option.value === value ? <Icon className="text-accent-ink" name="check" /> : null}
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )
      : null;

  return (
    <>
      {trigger}
      {menu}
    </>
  );
}
