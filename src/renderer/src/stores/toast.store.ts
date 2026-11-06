import { create } from "zustand";

export type ToastTone = "info" | "success" | "warning" | "danger";

export type ToastAction = { label: string; onClick: () => void };

export type ToastItem = {
  id: string;
  tone: ToastTone;
  message: string;
  action?: ToastAction | undefined;
  /** Dismissed, still on screen playing its exit animation. It stops being
   *  interactive the moment this flips — otherwise the 180 ms of fade are a
   *  window where "Undo" still looks clickable and no longer is. */
  exiting?: boolean;
  /** How long it stays. EVERY toast goes on its own (owner, 2026-11-05: the
   *  ones with an action, and the «screen lost» warning, stayed until closed
   *  by hand), its time drawn as a bar that empties; hovering or focusing it
   *  holds the count (`pause`/`resume`). */
  durationMs: number;
  /** While the pointer or the focus is on it: the bar and the count stop. */
  paused?: boolean;
};

type ToastInput = {
  tone: ToastTone;
  message: string;
  action?: ToastAction | undefined;
  durationMs?: number | undefined;
};

type ToastStoreState = {
  toasts: ToastItem[];
  push: (input: ToastInput) => string;
  dismiss: (id: string) => void;
  pause: (id: string) => void;
  resume: (id: string) => void;
};

/** Long enough to read a sentence and press «Deshacer» (owner, 2026-11-05: first «unos 10 segundos», the same
 *  evening «5 segundos, 10 es mucho»). */
export const TOAST_DURATION_MS = 5_000;

/** Must match the `toast-exit` animation in `styles/globals.css`: the item is
 *  removed from the store when the animation ends, so a shorter value here
 *  cuts the fade off and a longer one leaves an invisible gap in the stack. */
const EXIT_MS = 180;

/** Most toasts on screen at once. Past this the oldest is retired to make
 *  room: a burst — one per failing file while a whole folder is missing —
 *  otherwise stacks past the height of the window, hiding the app behind its
 *  own notifications and burying the newest (most relevant) message off
 *  screen — for the ten seconds each one lasts. */
const MAX_TOASTS = 4;

/** Auto-dismiss timers, so a toast closed by hand (or evicted by the cap)
 *  doesn't leave one behind still counting down towards an id that is already
 *  gone. With when each one ends, so a pause can keep what is left. */
const timers = new Map<string, { handle: ReturnType<typeof setTimeout>; endsAt: number }>();
/** What a paused toast still had to go. */
const remaining = new Map<string, number>();

/** Separate from `timers`: a toast being dismissed has already had its
 *  auto-dismiss timer cancelled, and these have to be cleared too when the cap
 *  evicts something that was already fading out. */
const exitTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelTimer(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer.handle);
    timers.delete(id);
  }
  remaining.delete(id);
  const exitTimer = exitTimers.get(id);
  if (exitTimer !== undefined) {
    clearTimeout(exitTimer);
    exitTimers.delete(id);
  }
}

export const useToastStore = create<ToastStoreState>((set, get) => ({
  toasts: [],

  push: ({ tone, message, action, durationMs }) => {
    const id = crypto.randomUUID();
    const effectiveDuration = durationMs ?? TOAST_DURATION_MS;
    const evicted: string[] = [];
    set((state) => {
      const next = [...state.toasts, { id, tone, message, action, durationMs: effectiveDuration }];
      while (next.length > MAX_TOASTS) {
        const oldest = next.shift();
        if (oldest) evicted.push(oldest.id);
      }
      return { toasts: next };
    });
    for (const evictedId of evicted) cancelTimer(evictedId);
    timers.set(id, { handle: setTimeout(() => get().dismiss(id), effectiveDuration), endsAt: Date.now() + effectiveDuration });
    return id;
  },

  pause: (id) => {
    const timer = timers.get(id);
    if (!timer) return;
    clearTimeout(timer.handle);
    timers.delete(id);
    remaining.set(id, Math.max(0, timer.endsAt - Date.now()));
    set((state) => ({ toasts: state.toasts.map((t) => (t.id === id ? { ...t, paused: true } : t)) }));
  },

  resume: (id) => {
    const left = remaining.get(id);
    if (left === undefined) return;
    remaining.delete(id);
    timers.set(id, { handle: setTimeout(() => get().dismiss(id), left), endsAt: Date.now() + left });
    set((state) => ({ toasts: state.toasts.map((t) => (t.id === id ? { ...t, paused: false } : t)) }));
  },

  /**
   * Starts the exit animation and removes the toast when it ends.
   *
   * Eviction by `MAX_TOASTS` is deliberately NOT animated: that path removes a
   * toast to make room for a new one, and fading it would keep its height in
   * the stack for exactly as long as the room is needed.
   */
  dismiss: (id) => {
    const item = get().toasts.find((t) => t.id === id);
    if (!item || item.exiting) return;
    cancelTimer(id);
    set((state) => ({
      toasts: state.toasts.map((t) => (t.id === id ? { ...t, exiting: true } : t)),
    }));
    exitTimers.set(
      id,
      setTimeout(() => {
        exitTimers.delete(id);
        set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
      }, EXIT_MS),
    );
  },
}));
