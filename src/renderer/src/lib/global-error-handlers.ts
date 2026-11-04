import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";

/** Consecutive failures collapse into one toast instead of stacking a wall of
 *  them over the workspace — a broken IPC channel fails on every retry. */
const REPEAT_WINDOW_MS = 5_000;

let lastDetail = "";
let lastShownAt = 0;

/**
 * The operator reads a translated, generic line; the technical detail goes to
 * the console only.
 *
 * `error.message` here is whatever the failing layer happened to throw —
 * English, often with a filesystem path in it, and meaningless to someone
 * running a service in a dark booth. Deduplication still keys on that detail
 * rather than on what is shown, so two *different* failures inside the same
 * window each get their toast instead of collapsing into one.
 */
function surface(detail: string): void {
  const now = Date.now();
  if (detail === lastDetail && now - lastShownAt < REPEAT_WINDOW_MS) return;
  lastDetail = detail;
  lastShownAt = now;
  toast.danger(t("app.unexpectedError"), { durationMs: 8000 });
}

function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return String(reason);
}

/**
 * Makes an unhandled async failure visible.
 *
 * The renderer calls IPC as `void api.something()` in dozens of places — a
 * deliberate style (there is nothing useful to do with most of those results),
 * but it means a rejection had **nowhere to surface**: no `catch`, no
 * `unhandledrejection` listener, and React's error boundaries never see a
 * promise. A full disk or a locked database would simply… not happen, silently, and the operator would be left wondering why
 * the click did nothing.
 *
 * Toast rather than a dialog on purpose: this fires for things that are often
 * recoverable, and a modal in the middle of a service is worse than the
 * failure it reports. Everything also goes to the console for a post-mortem.
 *
 * Returns the teardown, so a caller that mounts this can unmount it.
 */
export function installGlobalErrorHandlers(): () => void {
  const onRejection = (event: PromiseRejectionEvent) => {
    console.error("[renderer] unhandled rejection", event.reason);
    surface(describe(event.reason));
  };

  // `window.onerror`'s territory: a throw from an event handler or a timer
  // callback, which no error boundary can catch either.
  const onError = (event: ErrorEvent) => {
    console.error("[renderer] uncaught error", event.error ?? event.message);
    surface(describe(event.error ?? event.message));
  };

  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("error", onError);
  return () => {
    window.removeEventListener("unhandledrejection", onRejection);
    window.removeEventListener("error", onError);
  };
}
