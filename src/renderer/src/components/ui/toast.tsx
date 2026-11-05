import { useRef } from "react";
import { createPortal } from "react-dom";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { cn } from "@renderer/lib/utils";
import { useToastStore, type ToastItem, type ToastTone } from "@renderer/stores/toast.store";
import { Button } from "./button";
import { Icon } from "./icon";
import { IconButton } from "./icon-button";

const toneClassName: Record<ToastTone, string> = {
  info: "border-border-light bg-card text-foreground",
  success: "border-success/40 bg-card text-foreground",
  warning: "border-warning/40 bg-card text-foreground",
  danger: "border-danger/40 bg-card text-foreground",
};
const toneIcon: Record<ToastTone, "check" | "alert" | "info"> = {
  // A neutral message is not a warning: «!» on «Se quitó del programa» read as one.
  info: "info",
  success: "check",
  warning: "alert",
  danger: "alert",
};
/** The bar that empties as the toast's time runs out: its tone's fill. */
const toneBarClassName: Record<ToastTone, string> = {
  info: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};
const toneIconClassName: Record<ToastTone, string> = {
  info: "text-accent-ink",
  success: "text-success-ink",
  warning: "text-warning-ink",
  danger: "text-danger-ink",
};

function Toast({
  item,
  onDismiss,
  onPause,
  onResume,
}: {
  item: ToastItem;
  onDismiss: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const t = useT();
  // The pointer and the focus each hold the count; it runs again only when
  // neither is on the toast — hovering, tabbing to «Deshacer» and then moving
  // the mouse away must not let it vanish under the keyboard's focus.
  const holds = useRef({ pointer: false, focus: false });
  const hold = (which: "pointer" | "focus", on: boolean) => {
    const was = holds.current.pointer || holds.current.focus;
    holds.current[which] = on;
    const is = holds.current.pointer || holds.current.focus;
    if (is && !was) onPause();
    else if (!is && was) onResume();
  };
  return (
    // The pointer or the focus on it holds the count (and its bar): reading it,
    // or reaching for «Deshacer», never races the clock.
    <div
      className={cn(
        "relative flex items-start gap-2 overflow-hidden rounded-md border p-3 text-sm shadow-overlay",
        toneClassName[item.tone],
        // A dismissed toast keeps its box while it fades, but stops taking
        // clicks: its action button is on its way out and pressing it would
        // fire whatever it offered a second time.
        item.exiting ? "wa-toast-exit pointer-events-none" : "wa-toast-enter pointer-events-auto",
      )}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) hold("focus", false);
      }}
      onFocus={() => hold("focus", true)}
      onMouseEnter={() => hold("pointer", true)}
      onMouseLeave={() => hold("pointer", false)}
      role="status"
    >
      <Icon className={cn("mt-0.5", toneIconClassName[item.tone])} name={toneIcon[item.tone]} />
      {/* Selectable for the same reason as `LoadingState`'s hint: some
          messages carry a name or a count the operator needs to repeat over
          the phone. `anywhere`: a file name or a path has no space to break
          at, and it ran out of the box (owner, 2026-11-05). */}
      <p className="min-w-0 flex-1 select-text [overflow-wrap:anywhere]">{item.message}</p>
      {/* On the message's line, before the ✕: «Deshacer» on a line of its own
          made a two-line toast of a one-line message (2026-11-05 review). */}
      {item.action ? (
        <Button
          className="shrink-0"
          onClick={() => {
            item.action!.onClick();
            onDismiss();
          }}
          variant="link"
        >
          {item.action.label}
        </Button>
      ) : null}
      <IconButton aria-label={t("common.dismiss")} onClick={onDismiss} size="xs" variant="ghost">
        <Icon name="close" />
      </IconButton>
      {/* Every toast goes after its time (owner, 2026-11-05), and this says
          how much is left: a 2 px bar along the bottom edge that empties, in
          the toast's colour, held while the count is. */}
      <span
        aria-hidden
        className={cn("wa-toast-countdown absolute inset-x-0 bottom-0 h-0.5 origin-left opacity-80", toneBarClassName[item.tone])}
        style={{ animationDuration: `${item.durationMs}ms`, animationPlayState: item.paused ? "paused" : "running" }}
      />
    </div>
  );
}

/**
 * Mounted once in `App.tsx`. `--z-toast` is the top of the stacking scale so a
 * toast fired from inside a modal is still visible.
 *
 * Portaled to `document.body`, like the modals and for the same reason: a
 * modal marks `#root` `inert` (see `shared/modal/modal-stack.ts`), and a toast
 * rendered inside it would still be readable but its action — "Undo",
 * "Remove anyway" — would silently stop being clickable.
 *
 * The container is always mounted, empty or not: a screen reader generally
 * does not announce content inserted into a live region that was created in
 * the same tick, so a host that appears together with its first toast
 * announces nothing at all.
 */
export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const pause = useToastStore((s) => s.pause);
  const resume = useToastStore((s) => s.resume);

  return createPortal(
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 left-1/2 z-[var(--z-toast)] flex w-full max-w-sm -translate-x-1/2 flex-col gap-2 px-4"
    >
      {toasts.map((item) => (
        <Toast
          item={item}
          key={item.id}
          onDismiss={() => dismiss(item.id)}
          onPause={() => pause(item.id)}
          onResume={() => resume(item.id)}
        />
      ))}
    </div>,
    document.body,
  );
}
