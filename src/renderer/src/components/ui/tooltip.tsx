import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@renderer/lib/utils";

type TooltipProps = {
  /** Which edge the bubble hangs off of horizontally — "end" (default) keeps
   *  it on-screen for a trigger near a panel's right end, "start" for one
   *  near the left end. Every panel here (`Panel`, `shared/panel.tsx`) clips
   *  overflow, so picking the wrong side renders the bubble past the clip
   *  and it never becomes visible. Ignored when `floating` is set. */
  align?: "start" | "end";
  children: ReactNode;
  className?: string;
  content: ReactNode;
  /** How the floating bubble sizes itself. "text" (the default) wraps prose
   *  at a readable measure; "path" keeps a filesystem path or a file name on
   *  ONE line at its natural width, breaking mid-token only when it runs out
   *  of viewport. A sentence under `path` becomes a single line the width of
   *  the screen, which is how this bubble looked everywhere before the two
   *  cases were told apart. Ignored without `floating`. */
  fit?: "text" | "path";
  /** Renders the bubble through a portal to `document.body`, positioned in
   *  viewport coordinates (clamped so it never crosses the screen edge)
   *  instead of the in-flow CSS bubble — see `computeMenuPosition` for
   *  the same pattern. Use it when an ancestor clips overflow (every `Panel`
   *  does, and so does Settings' scrolling section), or when the content needs
   *  to render at its natural width in a narrow column. */
  floating?: boolean;
  /** Which side of the trigger the bubble opens toward — "bottom" (default)
   *  for a trigger near a panel's top, "top" for one near a panel's bottom
   *  (a `PanelFooter` button), for the same clipping reason as `align`.
   *  Ignored when `floating` is set — it flips automatically instead. */
  placement?: "top" | "bottom";
};

/**
 * Pure-CSS hover/focus tooltip — no portal, no library. `content` sits
 * absolutely positioned off the trigger and only becomes visible (and
 * hit-testable) on `:hover`/`:focus-visible`, so it never affects layout or
 * steals clicks while hidden.
 *
 * Uses `focus-visible` rather than `focus-within`: a `<button>` keeps focus
 * after a mouse click (not just after Tab), so `focus-within` left the
 * bubble stuck open post-click until the user focused something else.
 * `focus-visible` only engages for keyboard focus, so Tab navigation still
 * reveals the tooltip while a click dismisses it immediately.
 */
export function Tooltip(props: TooltipProps) {
  if (props.floating) return <FloatingTooltip {...props} />;

  const { align = "end", children, className, content, placement = "bottom" } = props;
  return (
    <span className={cn("group relative inline-flex", className)}>
      {children}
      <span
        className={cn(
          "pointer-events-none absolute z-[var(--z-raised)] w-64 rounded-md border border-border bg-card p-2 text-xs text-foreground opacity-0 shadow-raised transition-opacity group-hover:opacity-100 group-has-[:focus-visible]:opacity-100",
          placement === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
          align === "start" ? "left-0" : "right-0",
        )}
        role="tooltip"
      >
        {content}
      </span>
    </span>
  );
}

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

function FloatingTooltip({ children, className, content, fit = "text" }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<BubblePosition | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);

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

  function close(e: { relatedTarget?: EventTarget | null }) {
    // Not always a Node: when the pointer leaves straight out of the document
    // (into the title bar, onto the projector's screen) React reports the
    // `window`, and `contains(window)` threw — an «unexpected error» toast.
    if (e.relatedTarget instanceof Node && triggerRef.current?.contains(e.relatedTarget)) return;
    setOpen(false);
    setPosition(null);
  }

  return (
    <span
      className={cn("inline-flex", className)}
      onBlur={close}
      onFocus={(e) => {
        if (e.target.matches(":focus-visible")) setOpen(true);
      }}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={close}
      ref={triggerRef}
    >
      {children}
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
