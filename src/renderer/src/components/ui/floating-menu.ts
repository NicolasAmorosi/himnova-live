import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Where a portalled list goes, for the two primitives that open one: `Select`
 * (a list as wide as its own trigger) and `Menu` (a list at its own width,
 * hung off one edge of a small icon button).
 *
 * Shared because the hard part is the same for both and was never about the
 * list: every panel in this app clips its overflow, so a menu that is laid out
 * in flow is a menu the operator cannot see. It is positioned in viewport
 * coordinates instead, flipped above the trigger when there is no room below,
 * clamped inside the screen on both axes, and capped to whichever side it
 * opens toward.
 */

// Kept clear of the viewport edge, and of the trigger itself.
const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 4;
const MIN_MENU_HEIGHT = 120;
const MAX_MENU_HEIGHT = 320;

export type MenuPosition = { bottom?: number; left: number; maxHeight: number; top?: number; width: number };

/** `"trigger"` makes the list exactly as wide as the control it belongs to —
 *  what a dropdown replacing a `<select>` has to do. A number is for a trigger
 *  too small to size a list by (an icon button), where the width is the
 *  primitive's own decision. */
export type MenuWidth = "trigger" | number;

export function computeMenuPosition(
  trigger: HTMLElement,
  width: MenuWidth = "trigger",
  /** Which edge of the trigger the list lines up with. Only meaningful with a
   *  fixed width: an icon button in a narrow left-hand panel needs "start",
   *  one at the right end of a toolbar needs "end". */
  align: "start" | "end" = "start",
): MenuPosition {
  const rect = trigger.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
  const spaceAbove = rect.top - VIEWPORT_MARGIN;
  const openUp = spaceBelow < MIN_MENU_HEIGHT && spaceAbove > spaceBelow;
  const maxHeight = Math.min(MAX_MENU_HEIGHT, Math.max(80, openUp ? spaceAbove : spaceBelow));
  const menuWidth = width === "trigger" ? rect.width : width;
  const anchor = align === "end" ? rect.right - menuWidth : rect.left;
  const left = Math.min(Math.max(anchor, VIEWPORT_MARGIN), window.innerWidth - menuWidth - VIEWPORT_MARGIN);
  return openUp
    ? { bottom: window.innerHeight - rect.top + TRIGGER_GAP, left, maxHeight, width: menuWidth }
    : { left, maxHeight, top: rect.bottom + TRIGGER_GAP, width: menuWidth };
}

/**
 * Keeps an open portalled list attached to its trigger: re-placed on every
 * resize and every scroll, and CLOSED once the trigger has scrolled out of
 * sight. Re-placing alone is what left a list floating over a dialog's header
 * after its trigger had gone under it — `computeMenuPosition` clamps to the
 * screen, not to the panel that clips the trigger. A little scroll keeps the
 * list open and following; only a trigger that is fully hidden closes it.
 *
 * `IntersectionObserver` with no root is the right test because it clips by
 * every scrolling ancestor, not only by the viewport. The callbacks are read
 * through a ref so a caller can pass inline functions without re-subscribing
 * on every render.
 */
export function useFollowTrigger(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  place: (trigger: HTMLElement) => void,
  onHidden: () => void,
): void {
  const latest = useRef({ onHidden, place });
  useLayoutEffect(() => {
    latest.current = { onHidden, place };
  });

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    if (!open || !trigger) return;
    const reposition = () => latest.current.place(trigger);
    // Only a scroll of something that holds the trigger moves it: the menu's own list scrolling placed (and
    // re-rendered) the menu at every step (2026-11-15 audit, R31).
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && !event.target.contains(trigger)) return;
      reposition();
    };
    reposition();
    window.addEventListener("resize", reposition);
    // capture: true — a scroll inside a nested panel or modal (the common
    // case here) never bubbles to window, only the capture phase sees it.
    window.addEventListener("scroll", onScroll, true);
    const observer = new IntersectionObserver(([entry]) => {
      if (entry && !entry.isIntersecting) latest.current.onHidden();
    });
    observer.observe(trigger);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", onScroll, true);
      observer.disconnect();
    };
  }, [open, triggerRef]);
}

/** Closes an open popup when the pointer goes down outside both its trigger and the popup itself. */
export function useCloseOnPointerOutside(
  open: boolean,
  setOpen: (open: boolean) => void,
  triggerRef: RefObject<HTMLElement | null>,
  popupRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, setOpen, triggerRef, popupRef]);
}
