import type { ReactNode } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@renderer/lib/utils";

type TooltipProps = {
  /** Unused: the bubble is placed against the viewport and flips by itself.
   *  Kept so the call sites written for the retired in-flow bubble still
   *  compile. */
  align?: "start" | "end";
  children: ReactNode;
  className?: string;
  content: ReactNode;
  /** Waits this long under a resting pointer before opening (keyboard focus still opens at once): in a list where
   *  every row has a bubble, the pointer crossing the rows flashed one per row. */
  delayMs?: number;
  /** How the bubble sizes itself. "text" (the default) wraps prose at a
   *  readable measure; "path" keeps a filesystem path or a file name on ONE
   *  line at its natural width, breaking mid-token only when it runs out of
   *  viewport. A sentence under `path` becomes a single line the width of the
   *  screen, which is how this bubble looked everywhere before the two cases
   *  were told apart. */
  fit?: "text" | "path";
  /** Unused, see `align`: every tooltip floats now. */
  floating?: boolean;
  /** Unused, see `align`. */
  placement?: "top" | "bottom";
};

// Kept clear of the viewport edge, and of the trigger itself.
const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 6;

type BubblePosition = { left: number; top: number };

const fits: Record<"text" | "path", string> = {
  // A readable measure, and words kept whole — `break-all` on a sentence
  // hyphenates nothing and splits mid-word wherever the line happens to end.
  text: "max-w-80 break-words",
  path: "max-w-[calc(100vw-1rem)] break-all",
};

/** What a tooltip describes: the control inside it, else whatever it wraps (a status dot, a badge). */
const DESCRIBED = "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

/**
 * A hover/focus bubble, rendered through a portal to `document.body` and
 * positioned in viewport coordinates (clamped so it never crosses the screen
 * edge; see `computeMenuPosition` for the same pattern): every `Panel` clips
 * its overflow, and so does Settings' scrolling section and Welcome's folder
 * list. The in-flow CSS bubble this replaced lived in the DOM even while
 * hidden, so a screen reader read it, it counted for scroll and it was clipped
 * (2026-11-15 audit, X16).
 *
 * Opens on hover and on KEYBOARD focus only (`:focus-visible`): a `<button>`
 * keeps focus after a mouse click, and a bubble on any focus stayed stuck
 * open after the click. A trigger whose menu or list is open
 * (`aria-expanded="true"`) shows no bubble: it sat over the menu it had just
 * opened (owner, 2026-11-05). Esc closes it.
 *
 * The text is also the control's description (`aria-describedby`, onto a
 * `hidden` copy that is always there): the shortcuts Enter, B and L were only
 * ever said in the bubble.
 */
export function Tooltip({ children, className, content, delayMs = 0, fit = "text" }: TooltipProps) {
  const descriptionId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<BubblePosition | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  /** Pressed: no bubble until the pointer leaves and comes back. A press
   *  opens a menu, a dialog or a native file picker — and the bubble stayed
   *  over the menu, or stuck on screen once the picker took the pointer away
   *  without a `pointerleave` (owner, 2026-11-05). */
  const pressedRef = useRef(false);
  const delayRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(delayRef.current), []);

  // Two-pass: the bubble mounts invisible first so its natural (unclamped)
  // size can be measured, then gets placed against the viewport.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !bubbleRef.current) return;
    const reposition = () => {
      const trigger = triggerRef.current;
      const bubble = bubbleRef.current;
      if (!trigger || !bubble) return;
      const triggerRect = trigger.getBoundingClientRect();
      const bubbleRect = bubble.getBoundingClientRect();
      const left = Math.min(
        Math.max(triggerRect.left, VIEWPORT_MARGIN),
        window.innerWidth - bubbleRect.width - VIEWPORT_MARGIN,
      );
      const spaceBelow = window.innerHeight - triggerRect.bottom - VIEWPORT_MARGIN;
      const openUp = spaceBelow < bubbleRect.height && triggerRect.top - VIEWPORT_MARGIN > spaceBelow;
      const top = openUp ? triggerRect.top - bubbleRect.height - TRIGGER_GAP : triggerRect.bottom + TRIGGER_GAP;
      setPosition({ left, top });
    };
    reposition();
    window.addEventListener("resize", reposition);
    // capture: true — a scroll inside a nested panel never bubbles to
    // window, only the capture phase sees it.
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  // The window losing focus (a native dialog, another app) takes the pointer
  // with it, and no `pointerleave` ever comes.
  useLayoutEffect(() => {
    if (!open) return;
    const hide = () => {
      setOpen(false);
      setPosition(null);
    };
    // Esc dismisses the bubble, and is NOT used up by it: the bubble shows
    // whenever the pointer rests on a control, as it does after clicking one,
    // so taking the key would make leaving an editor or Settings take two
    // presses. A menu or a palette is what takes an Esc of its own (U2, U3).
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("blur", hide);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("blur", hide);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  // Set on the DOM rather than passed as a prop: the control is whatever the
  // call site wrapped, and `Menu` keeps its trigger to itself.
  useEffect(() => {
    const trigger = triggerRef.current;
    const target = trigger?.querySelector(DESCRIBED) ?? trigger?.firstElementChild;
    if (!target) return;
    const ids = target.getAttribute("aria-describedby")?.split(" ") ?? [];
    if (!ids.includes(descriptionId)) target.setAttribute("aria-describedby", [...ids, descriptionId].join(" "));
  });

  /** Not over an open menu: the trigger's own list says what it is. */
  const show = () => {
    if (pressedRef.current || triggerRef.current?.querySelector("[aria-expanded='true']")) return;
    setOpen(true);
  };

  /** From the pointer, after `delayMs`. */
  const showSoon = () => {
    window.clearTimeout(delayRef.current);
    if (delayMs <= 0) return show();
    delayRef.current = window.setTimeout(show, delayMs);
  };

  function close(e: { relatedTarget?: EventTarget | null }) {
    // Not always a Node: when the pointer leaves straight out of the document
    // (into the title bar, onto the projector's screen) React reports the
    // `window`, and `contains(window)` threw — an «unexpected error» toast.
    if (e.relatedTarget instanceof Node && triggerRef.current?.contains(e.relatedTarget)) return;
    window.clearTimeout(delayRef.current);
    setOpen(false);
    setPosition(null);
  }

  return (
    <span
      className={cn("inline-flex", className)}
      onBlur={close}
      onFocus={(e) => {
        if (e.target.matches(":focus-visible")) show();
      }}
      onPointerDown={() => {
        pressedRef.current = true;
        window.clearTimeout(delayRef.current);
        setOpen(false);
        setPosition(null);
      }}
      onPointerEnter={showSoon}
      onPointerLeave={(e) => {
        pressedRef.current = false;
        close(e);
      }}
      ref={triggerRef}
    >
      {children}
      {/* In `body`, not here: inside the trigger it would join the text of every row and token that holds one. */}
      {createPortal(
        <span hidden id={descriptionId}>
          {content}
        </span>,
        document.body,
      )}
      {open
        ? createPortal(
            <span
              className={cn(
                "pointer-events-none fixed z-[var(--z-popover)] w-max rounded-md border border-border bg-card p-2 text-xs text-foreground shadow-raised",
                fits[fit],
                !position && "invisible",
              )}
              ref={bubbleRef}
              role="tooltip"
              style={position ? { left: position.left, top: position.top } : { left: 0, top: 0 }}
            >
              {content}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
