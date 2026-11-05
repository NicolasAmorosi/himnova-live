import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@renderer/lib/utils";
import { Dialog } from "@renderer/components/ui";
import { getTopModalId, popModal, pushModal, subscribeModalStack } from "./modal-stack";
import { ModalTitleIdContext } from "./modal-title-id";

/** `screen` is a full-screen editor (`components/shared/editor-screen/`): the
 *  whole control window, no backdrop, no frame. It stays a `Modal` on purpose —
 *  the stack, the focus trap, the `inert` work screen behind it, Escape and the
 *  shortcuts switched off (`useAnyModalOpen`) are exactly what an editor that
 *  covers everything needs, and a confirm opened from it still stacks on top. */
type ModalSize = "sm" | "md" | "lg" | "xl" | "2xl" | "screen";
const modalSizes: Record<ModalSize, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
  "2xl": "max-w-5xl",
  screen: "",
};

/** How long a full-screen editor takes to fade out — `.wa-screen-exit`. */
const SCREEN_EXIT_MS = 150;

type ModalHeight = "auto" | "tall";
/** "tall" gives a modal a large, fixed height instead of growing to its
 *  content — for a multi-section screen (e.g. Settings) where switching
 *  section must not resize the dialog. Still capped by the viewport. */
const modalHeights: Record<ModalHeight, string> = {
  auto: "",
  tall: "h-[min(44rem,calc(100dvh-2rem))]",
};

/** Everything the platform considers tabbable, minus what is explicitly opted
 *  out. Disabled controls are excluded by the selector; hidden ones by the
 *  rect check below, which is what catches a section of the Settings dialog
 *  that is mounted but not displayed. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(",");

function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) => el.getClientRects().length > 0,
  );
}

type ModalProps = {
  children: ReactNode;
  className?: string;
  closeOnOverlay?: boolean;
  height?: ModalHeight;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  size?: ModalSize;
};

/**
 * Only the top modal in the stack paints a backdrop, so stacking a confirm
 * dialog over a form modal doesn't double-darken the screen. Uses
 * useSyncExternalStore purely as a hydration-safe way to read the module-level
 * stack — there's no server render here, but the pattern (and modal-stack.ts)
 * is copied verbatim from libretto-villaaurora for consistency.
 *
 * Focus is managed here rather than left to the browser, because a portal
 * gives none of it for free: the dialog is a sibling of `#root`, so without
 * the three pieces below the focus ring simply stayed on the button that
 * opened the modal, behind the backdrop, and Tab kept walking the app under
 * it. The three are (1) initial focus, (2) a pair of sentinels that wrap the
 * tab order back into the dialog, (3) focus returned to the opener on close.
 * `inert` on the background is the fourth and lives in `modal-stack.ts`,
 * where push/pop give it a single choke point.
 */
export function Modal({
  children,
  className,
  closeOnOverlay = true,
  height = "auto",
  onOpenChange,
  open,
  size = "md",
}: ModalProps) {
  const id = useId();
  const titleId = useId();
  const topId = useSyncExternalStore(subscribeModalStack, getTopModalId);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const screen = size === "screen";

  // A full-screen editor fades OUT as it faded in (owner, 2026-11-04). It is
  // closed the instant `open` turns false — off the stack, the work screen no
  // longer inert, focus back on the opener, no Escape — and what stays for
  // `SCREEN_EXIT_MS` is only its picture: `inert`, hidden from the
  // accessibility tree and from the pointer. The picture is the children of
  // the closing render, kept as they were, because the editors clear their
  // draft once closed and a fade of an emptied screen is a blink.
  const [wasOpen, setWasOpen] = useState(open);
  const [leaving, setLeaving] = useState<ReactNode>(null);
  if (open !== wasOpen) {
    setWasOpen(open);
    setLeaving(!open && screen ? children : null);
  }
  useEffect(() => {
    if (leaving === null) return;
    const timer = setTimeout(() => setLeaving(null), SCREEN_EXIT_MS);
    return () => clearTimeout(timer);
  }, [leaving]);

  useEffect(() => {
    if (!open) return;
    pushModal(id);
    return () => popModal(id);
  }, [open, id]);

  useEffect(() => {
    if (!open) return;
    // An Escape a widget inside already used (closing an open `Select` or
    // `Menu`, which `preventDefault` it) is not the modal's: it closed the
    // whole dialog — or, with unsaved edits, opened the discard prompt —
    // when the operator only meant to close a dropdown.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && getTopModalId() === id) onOpenChange(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, id, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    // The dialog itself is the fallback (it carries tabIndex={-1}): a modal
    // with nothing focusable still has to take the focus off whatever is now
    // behind the backdrop.
    (dialog ? (focusablesIn(dialog)[0] ?? dialog) : null)?.focus();

    return () => {
      const opener = openerRef.current;
      openerRef.current = null;
      // Runs AFTER the `popModal` cleanup above — effects clean up in
      // declaration order — so the background is no longer `inert` by the
      // time this tries to focus into it. Without the restore, focus lands on
      // <body> and the next Tab starts over from the top of the document.
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  if (!open && leaving === null) return null;
  const isTop = open && topId === id;

  /** Wrapping Tab/Shift+Tab back into the dialog. A sentinel receiving focus
   *  means the tab order just ran off that end. */
  function focusEdge(edge: "first" | "last") {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const targets = focusablesIn(dialog);
    (edge === "first" ? targets[0] : targets[targets.length - 1])?.focus();
  }

  return createPortal(
    <ModalTitleIdContext.Provider value={titleId}>
      <div
        aria-hidden={open ? undefined : true}
        className={cn(
          "fixed inset-0 z-[var(--z-modal)] flex items-center justify-center",
          !screen && "p-4",
          !open && "pointer-events-none",
        )}
        inert={!open}
      >
        {isTop && !screen ? (
          <button
            aria-hidden="true"
            className="wa-backdrop-enter absolute inset-0 cursor-default bg-scrim backdrop-blur-sm"
            onClick={() => closeOnOverlay && onOpenChange(false)}
            tabIndex={-1}
            type="button"
          />
        ) : null}
        {/* Only the top modal traps: a covered one is unreachable anyway,
            since the top modal's own backdrop paints over it. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a
            focus sentinel is the one case where a tab stop on a
            non-interactive node is the point: it exists to be landed on for a
            single frame and bounced back. `aria-hidden` keeps it out of the
            accessibility tree, so nothing ever announces it. */}
        <span aria-hidden="true" onFocus={() => focusEdge("last")} tabIndex={isTop ? 0 : -1} />
        <Dialog
          aria-labelledby={titleId}
          aria-modal="true"
          className={cn(
            screen
              ? cn(
                  open ? "wa-screen-enter" : "wa-screen-exit",
                  "relative size-full rounded-none border-0 bg-background shadow-none",
                )
              : "wa-modal-enter relative max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)]",
            modalSizes[size],
            !screen && modalHeights[height],
            className,
          )}
          ref={dialogRef}
          tabIndex={-1}
        >
          {open ? children : leaving}
        </Dialog>
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- see above */}
        <span aria-hidden="true" onFocus={() => focusEdge("first")} tabIndex={isTop ? 0 : -1} />
      </div>
    </ModalTitleIdContext.Provider>,
    document.body,
  );
}
