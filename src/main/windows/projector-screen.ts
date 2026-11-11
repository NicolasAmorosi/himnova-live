import { powerSaveBlocker, screen, type BrowserWindow, type Display } from "electron";
import { broadcast } from "../services/broadcast";
import { getSettingsRepo } from "../services/repos";
import { operatorDisplay } from "./control-window";
import { chooseProjectorMove } from "./projector-display-choice";
import { syncStageWindow } from "./stage-window";

/**
 * What the projection window needs from the operating system while it exists,
 * and what happens to it when screens come and go.
 *
 * - **The screens stay awake.** A verse can sit on the projector through a
 *   forty-minute sermon. Chromium only holds off sleep while a video with
 *   sound plays, so Windows' power plan would turn the screens off, or the
 *   screen saver and then the lock screen would come up, in the middle of a
 *   service. The blocker lives exactly as long as the window.
 * - **A screen that disappears takes its window out of sight, not out of
 *   existence.** A projector that goes to standby, a cable that moves, an
 *   input switched on the projector: Windows moves a fullscreen, always-on-top
 *   window onto the laptop, over the control window. So the window is HIDDEN
 *   (`projector-screen` → `connected: false`) and put back on its own once a
 *   second screen returns. Hidden rather than closed, because every `<audio>`
 *   of the service lives in it: closing it silenced the hymn's music and the
 *   background track in the room for as long as the projector was off, and
 *   rebuilt every element when it came back.
 * - **A projector turned on after the app started receives the window** that
 *   was sitting on the laptop (the single-screen windowed mode).
 *
 * The operator's call, 2026-10-18. Every change in the list of screens is also
 * broadcast (`displays-changed`) so Settings and the next GO LIVE see it.
 */

type Attached = { win: BrowserWindow; displayId: number; blocker: number; hidden: boolean };

let attached: Attached | null = null;
/** The screens of the last change, to tell the ones that just appeared (`chooseProjectorMove`). */
let knownIds: number[] = [];

/** Called for every new projection window, with the screen it was put on. A
 *  replaced window's `closed` arrives after the new one is attached, so it is
 *  identity-checked (the same trap as `projectionState.clearWindowIf`). */
export function attachProjector(win: BrowserWindow, displayId: number): void {
  if (attached) powerSaveBlocker.stop(attached.blocker);
  attached = { win, displayId, blocker: powerSaveBlocker.start("prevent-display-sleep"), hidden: false };
  knownIds = screen.getAllDisplays().map((display) => display.id);
  win.once("closed", () => {
    if (attached?.win !== win) return;
    powerSaveBlocker.stop(attached.blocker);
    attached = null;
  });
}

function setting<K extends "projection.displayId" | "stage.displayId">(key: K): number | null {
  try {
    return getSettingsRepo().get(key);
  } catch {
    return null;
  }
}

/** Fullscreen on `display`, without taking the keyboard from the control
 *  window on Windows (see `createProjectionWindow`). */
function place(current: Attached, display: Display): void {
  const { win } = current;
  win.setBounds(display.bounds);
  if (process.platform === "win32") win.showInactive();
  else win.show();
  win.setSkipTaskbar(true);
  win.setFullScreen(true);
  win.setAlwaysOnTop(true, "screen-saver");
  current.displayId = display.id;
  current.hidden = false;
}

function onDisplaysChanged(): void {
  const current = attached;
  const displays = screen.getAllDisplays();
  const ids = displays.map((display) => display.id);
  const addedIds = ids.filter((id) => !knownIds.includes(id));
  knownIds = ids;
  if (current && !current.win.isDestroyed()) {
    if (!ids.includes(current.displayId) && !current.hidden) {
      current.hidden = true;
      current.win.hide();
      broadcast("projector-screen", { connected: false });
    }

    // Back to the chosen screen, or onto one that just appeared (a projector turned on after the
    // app, or back under a new id) — never onto one that was already there (`chooseProjectorMove`).
    const targetId = chooseProjectorMove(
      ids,
      operatorDisplay().id,
      setting("projection.displayId"),
      current.hidden ? null : current.displayId,
      addedIds,
      setting("stage.displayId"),
    );
    const target = displays.find((display) => display.id === targetId);
    if (target) {
      const wasHidden = current.hidden;
      place(current, target);
      // Said only when it is true: before, it was said as the window fell back to a third screen.
      if (wasHidden) broadcast("projector-screen", { connected: true });
    }
  }
  syncStageWindow();
  broadcast("displays-changed", undefined);
}

export function watchDisplays(): void {
  screen.on("display-added", onDisplaysChanged);
  screen.on("display-removed", onDisplaysChanged);
}
