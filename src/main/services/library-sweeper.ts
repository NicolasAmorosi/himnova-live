import { app, BrowserWindow } from "electron";
import { getMediaRepo } from "./repos";
import { broadcast } from "./broadcast";
import { notifyMediaChanged } from "../media/engine-assets";

/** How often a focused window is allowed to re-trigger a sweep — covers "I
 *  unplugged the drive and plugged it back in" without re-`stat`ing the whole
 *  library on every alt-tab back into the app. */
const FOCUS_THROTTLE_MS = 30_000;
/** Backstop for a long unattended session left on one screen — only runs
 *  while some window is actually focused, so an idle app in the background
 *  costs nothing. */
const PERIODIC_MS = 5 * 60_000;
/** Coalesces bursts (e.g. several imports in a row) into one sweep. */
const DEBOUNCE_MS = 2_000;

let debounceTimer: NodeJS.Timeout | null = null;
let sweeping = false;
let pendingRerun = false;
let lastFocusSweepAt = 0;

async function runSweep(): Promise<void> {
  if (sweeping) {
    pendingRerun = true;
    return;
  }
  sweeping = true;
  try {
    const changedKinds = await getMediaRepo().sweep();
    for (const kind of changedKinds) broadcast("library-changed", { kind });
    // A file that came back (a drive plugged in again) is a candidate again.
    if (changedKinds.has("video") || changedKinds.has("audio")) notifyMediaChanged();
  } catch (error) {
    console.warn("[library] sweep failed", error);
  } finally {
    sweeping = false;
    if (pendingRerun) {
      pendingRerun = false;
      void runSweep();
    }
  }
}

/** Debounced entry point — safe to call as often as needed. */
export function scheduleSweep(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runSweep();
  }, DEBOUNCE_MS);
}

/** Starts the background schedule: once shortly after launch, then on window
 *  focus (throttled) and periodically while a window is focused. Deliberately
 *  no `fs.watch` on arbitrary church folders — network shares and removable
 *  drives make that noisy (EMFILE, phantom events) for no real gain over
 *  polling on focus, which already covers the actual failure mode (a drive
 *  reconnected, a file deleted from outside the app). */
export function startLibrarySweepScheduler(): void {
  scheduleSweep();

  app.on("browser-window-focus", () => {
    const now = Date.now();
    if (now - lastFocusSweepAt < FOCUS_THROTTLE_MS) return;
    lastFocusSweepAt = now;
    scheduleSweep();
  });

  // Never cleared, deliberately: this scheduler is started once at boot and
  // is meant to run for the life of the process. There is no teardown path to
  // hang it on — the app owns it, not a window — and it already costs nothing
  // while the app is in the background, since it only sweeps when a window has
  // focus.
  setInterval(() => {
    if (BrowserWindow.getAllWindows().some((win) => win.isFocused())) scheduleSweep();
  }, PERIODIC_MS);
}
