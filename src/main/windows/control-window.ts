import { app, BrowserWindow, screen } from "electron";
import path from "node:path";
import { trustWindow } from "../ipc/trusted-senders";
import { broadcast, controlWindows, registerBroadcastTarget } from "../services/broadcast";
import { syncStageWindow } from "./stage-window";

const PRELOAD = path.join(__dirname, "../preload/index.js");

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

/** The screen the operator works on: the one hosting the control window. Not the OS's «primary»
 *  screen — a church may well have made the projector its primary display (owner, 2026-11-10). */
export function operatorDisplay(): Electron.Display {
  const control = controlWindows()[0];
  return control ? screen.getDisplayMatching(control.getBounds()) : screen.getPrimaryDisplay();
}
