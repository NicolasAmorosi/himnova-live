import { app, BrowserWindow, screen } from "electron";
import path from "node:path";
import { mt } from "../i18n";
import { showSheet } from "./sheet";
import { trustWindow } from "../ipc/trusted-senders";
import { broadcast, controlWindows, registerBroadcastTarget } from "../services/broadcast";
import { syncStageWindow } from "./stage-window";
import { crashLimit } from "./crash-limit";

const PRELOAD = path.join(__dirname, "../preload/index.js");

/** Whether a control window that just died may be reloaded on its own (`crash-limit.ts`). */
const controlCrashed = crashLimit();

export function createControlWindow(): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1400, width),
    height: Math.min(900, height),
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: "#162231",
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  trustWindow(win);
  // Control-side events (`deck-progress`, `library-changed`, …) go to this
  // window and only this one — see `broadcast.ts`.
  registerBroadcastTarget(win);

  // electron-vite sets ELECTRON_RENDERER_URL in `electron-vite dev`; app.isPackaged
  // is the production check. Both paths avoid the church-presenter bug of NODE_ENV
  // never being set and dev always falling through to loadFile.
  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
    // `void`, not a `.catch`: a failed load is a startup failure with nothing
    // useful to do about it here, and `unhandledRejection` below already
    // writes it to `crash.log`.
  if (!app.isPackaged && devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  win.once("ready-to-show", () => win.show());
  // A dead page left the operator without controls for the rest of the service, with only quitting left, which took
  // the projector with it (2026-11-15 audit, A30). Reloaded, the page starts from the copy of what is live it kept
  // with main (`window:liveCopy`), so the room sees and hears nothing of it. Past the cap it is the operator's call:
  // a flat window with nothing on it said nothing (owner's hand test, 2026-11-16).
  win.webContents.on("render-process-gone", () => {
    if (win.isDestroyed()) return;
    if (controlCrashed()) win.webContents.reload();
    else offerReload(win);
  });
  // The operator's screen is where this window is (`operatorDisplay`): dragged to another one,
  // Settings' list of screens and the stage window follow.
  let lastDisplayId = screen.getDisplayMatching(win.getBounds()).id;
  win.on("moved", () => {
    const id = screen.getDisplayMatching(win.getBounds()).id;
    if (id === lastDisplayId) return;
    lastDisplayId = id;
    syncStageWindow();
    broadcast("displays-changed", undefined);
  });

  return win;
}

/** Asks whether to load a control page that keeps dying once more, in a box that never stops main (`showSheet`): the
 *  room goes on meanwhile. Another death past the cap asks again. */
function offerReload(win: BrowserWindow): void {
  void showSheet(win, {
    type: "warning",
    title: mt("dialogs.controlDownTitle"),
    message: mt("dialogs.controlDownMessage"),
    detail: mt("dialogs.controlDownDetail"),
    buttons: [mt("dialogs.controlDownRetry"), mt("dialogs.controlDownLeave")],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }).then((answer) => {
    if (answer?.response === 0 && !win.isDestroyed() && win.webContents.isCrashed()) win.webContents.reload();
  });
}

/** The screen the operator works on: the one hosting the control window. Not the OS's «primary»
 *  screen — a church may well have made the projector its primary display (owner, 2026-11-10). */
export function operatorDisplay(): Electron.Display {
  const control = controlWindows()[0];
  return control ? screen.getDisplayMatching(control.getBounds()) : screen.getPrimaryDisplay();
}
