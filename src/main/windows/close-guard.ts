import { app, BrowserWindow, type Event, type WebContents } from "electron";
import { broadcast } from "../services/broadcast";
import type { CloseDecision } from "@shared/types/window";
import { CloseGate } from "./close-gate";

/**
 * Closing the control window is the control window's decision, not main's.
 *
 * The schedule being edited lives in the renderer, and `CLAUDE.md` is explicit
 * that main does not get a second, inferred copy of what the control window
 * knows. So main never asks itself "is there unsaved work?" — it vetoes the
 * close once, tells the control window the operator wants out, and waits to be
 * told what to do. Only the renderer can put the question to the operator, in
 * the app's own language, next to a Save button that actually works. The rules
 * — the veto, the answers and the grace timer — are `CloseGate`'s.
 */
const gates = new WeakMap<WebContents, CloseGate>();

/** Set by `holdQuitUntilAnswered`, consumed by the next vetoed close. */
let quitRequested = false;

/** The control window, the only one whose close asks the operator. */
let guarded: BrowserWindow | null = null;

/**
 * Called from `before-quit`. It holds the WHOLE quit until the control window
 * answers, instead of letting Electron start closing windows and vetoing only
 * the control window's `close`.
 *
 * That veto came too late. By the time the control window got its `close`,
 * Electron had already closed the projection window, which has no guard. So an
 * operator who hit ⌘Q by accident and answered «Cancel» kept the app and lost
 * the projector, in front of the congregation (measured in the 2026-10-14
 * rehearsal). Preventing `before-quit` itself means no window closes and none of
 * the quit's shutdown chores run until the answer is "close", and that answer
 * resumes the quit with `app.quit()`.
 *
 * Returns true when the quit is being held. The caller must then skip its
 * shutdown work.
 */
export function holdQuitUntilAnswered(event: Event): boolean {
  const win = guarded;
  if (!win || win.isDestroyed() || gates.get(win.webContents)?.cleared) return false;
  event.preventDefault();
  quitRequested = true;
  win.close();
  return true;
}

/**
 * Lets the updater's own quit through without asking. The control window has
 * already put the question (`installUpdate` in the renderer), and the installer
 * just launched kills the app within seconds whatever the answer: a second
 * question would offer a «Cancel» that cancels nothing, with the projector on.
 */
export function releaseForUpdate(): void {
  const gate = guarded && !guarded.isDestroyed() ? gates.get(guarded.webContents) : undefined;
  if (gate) gate.cleared = true;
}

export function installCloseGuard(win: BrowserWindow): void {
  guarded = win;
  const gate = new CloseGate({
    ask: () => {
      // Captured onto the pending close; the flag itself must not survive to
      // colour an unrelated close later on.
      quitRequested = false;
      broadcast("close-requested", undefined);
    },
    close: () => win.close(),
    quit: () => app.quit(),
    alive: () => !win.isDestroyed(),
  });
  gates.set(win.webContents, gate);
  win.on("close", (event) => {
    if (!gate.onClose(quitRequested)) event.preventDefault();
  });
}

/** The control window's answer (`CloseGate.resolve`). A window with no guard just closes on "close". */
export function resolveClose(win: BrowserWindow, decision: CloseDecision): void {
  const gate = gates.get(win.webContents);
  if (gate) gate.resolve(decision);
  else if (decision === "close") win.close();
}
