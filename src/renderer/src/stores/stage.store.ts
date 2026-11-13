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
  /** The message field's text and urgency, kept while the panel folds. */
  draft: string;
  draftUrgent: boolean;

  /** Set to `totalMs`, held: ▶ starts it. */
  armCountdown: (totalMs: number) => void;
  /** Running at once, to today's `HH:MM`. */
  countdownUntil: (minuteOfDay: number) => void;
  toggleCountdown: () => void;
  /** Back to its length, held. */
  resetCountdown: () => void;
  /** ±1 min, running or not; the length follows, so the colours keep their place. */
  nudgeCountdown: (deltaMs: number) => void;
  clearCountdown: () => void;
  showMessage: (text: string, urgent: boolean) => void;
  /** The next message's urgency, and the one showing now's. */
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
  draftUrgent: false,
  panelOpen: false,
  setPanelOpen: (panelOpen) => set({ panelOpen }),

  armCountdown: (totalMs) => set({ countdown: { clock: { mode: "countdown", state: "held", remainingMs: totalMs }, totalMs } }),

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

  resetCountdown: () => {
    const { countdown } = get();
    if (countdown) get().armCountdown(countdown.totalMs);
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

  showMessage: (text, urgent) => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    set({ message: { text: trimmed, urgent, since: Date.now(), seq: ++seq } });
  },

  setUrgent: (urgent) => {
    set({ draftUrgent: urgent });
    const { message } = get();
    // A new `seq`: switching it off still announces the message once more, as it reads now.
    if (message && message.urgent !== urgent) set({ message: { ...message, urgent, seq: ++seq } });
  },

  clearMessage: () => set({ message: null }),
}));
