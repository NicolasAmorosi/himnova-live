import { create } from "zustand";
import { holdClock, resolveTargetMs, resumeClock } from "@shared/timer";
import type { StageOutput } from "@shared/types/projection";
import type { CountdownClock } from "@shared/types/stage";

const MINUTE = 60_000;

/** The window event that focuses the stage panel's message field (the M key: `use-global-shortcuts`). */
export const FOCUS_STAGE_MESSAGE = "stage:focus-message";

type StageCountdownState = { clock: CountdownClock; totalMs: number };
type StageMessageState = { text: string; urgent: boolean; since: number; seq: number };

type StageStoreState = {
  /** The preacher's countdown: manual only, nothing tied to the order of service (owner, 2026-11-13). */
  countdown: StageCountdownState | null;
  /** One message at a time; a new one replaces it. `since` for the panel's «visible for 1:20». */
  message: StageMessageState | null;
  /** What the stage was last sent (`effects/stage-sync.ts`): the panel's monitor draws exactly this. */
  output: StageOutput | null;
  /** Whether the stage window is on its screen (main's `stage-screen`): the panel's dot. */
  shown: boolean;
  /** The panel's card is open (`StagePanel`). Never remembered across launches: an overlay over the left column. */
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  /** Pinned, the card stays open when the operator presses elsewhere (owner, 2026-11-13); its arrow and Esc still
   *  fold it. For this session. */
  panelPinned: boolean;
  setPanelPinned: (pinned: boolean) => void;
  /** The message field's text, kept while the panel folds. */
  draft: string;
  /** The length the countdown field offers: the last one started, for this session. */
  lengthMs: number;

  /** Running at once, for `totalMs` (owner, 2026-11-14: no «set, then start»). */
  startCountdown: (totalMs: number) => void;
  /** Running at once, to today's `HH:MM`. */
  countdownUntil: (minuteOfDay: number) => void;
  toggleCountdown: () => void;
  /** ±1 min, running or not; the length follows, so the colours keep their place. */
  nudgeCountdown: (deltaMs: number) => void;
  clearCountdown: () => void;
  /** A new message always arrives plain: blinking until it is taken off is asked of the one showing (`setUrgent`). */
  showMessage: (text: string) => void;
  setUrgent: (urgent: boolean) => void;
  clearMessage: () => void;
};

let seq = 0;

export const useStageStore = create<StageStoreState>((set, get) => ({
  countdown: null,
  message: null,
  output: null,
  shown: false,
  draft: "",
  lengthMs: 30 * MINUTE,
  panelOpen: false,
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  panelPinned: false,
  setPanelPinned: (panelPinned) => set({ panelPinned }),

  startCountdown: (totalMs) =>
    set({ countdown: { clock: { mode: "countdown", state: "running", endsAtMs: Date.now() + totalMs }, totalMs }, lengthMs: totalMs }),

  countdownUntil: (minuteOfDay) => {
    const now = Date.now();
    const endsAtMs = resolveTargetMs(minuteOfDay, now);
    set({ countdown: { clock: { mode: "countdown", state: "running", endsAtMs }, totalMs: Math.max(MINUTE, endsAtMs - now) } });
  },

  toggleCountdown: () => {
    const { countdown } = get();
    if (!countdown) return;
    const now = Date.now();
    const clock = countdown.clock.state === "running" ? holdClock(countdown.clock, now) : resumeClock(countdown.clock, now);
    set({ countdown: { ...countdown, clock: clock as CountdownClock } });
  },

  nudgeCountdown: (deltaMs) => {
    const { countdown } = get();
    if (!countdown) return;
    const { clock } = countdown;
    set({
      countdown: {
        clock:
          clock.state === "running"
            ? { ...clock, endsAtMs: clock.endsAtMs + deltaMs }
            : { ...clock, remainingMs: clock.remainingMs + deltaMs },
        totalMs: Math.max(MINUTE, countdown.totalMs + deltaMs),
      },
    });
  },

  clearCountdown: () => set({ countdown: null }),

  showMessage: (text) => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    set({ message: { text: trimmed, urgent: false, since: Date.now(), seq: ++seq } });
  },

  setUrgent: (urgent) => {
    const { message } = get();
    // A new `seq`: switching it off still announces the message once more, as it reads now.
    if (message && message.urgent !== urgent) set({ message: { ...message, urgent, seq: ++seq } });
  },

  clearMessage: () => set({ message: null }),
}));

/** Opens the stage panel's card and puts the keyboard in its message field: the M key. At once
 *  when the card is open, so a letter typed right after it lands in the field and is never a shortcut (a «b» was
 *  BLACK); closed, the card mounts on the next render, so the focus waits a frame. */
export function focusStageMessage(): void {
  const stage = useStageStore.getState();
  const focus = () => void window.dispatchEvent(new Event(FOCUS_STAGE_MESSAGE));
  if (stage.panelOpen) return focus();
  stage.setPanelOpen(true);
  requestAnimationFrame(focus);
}
