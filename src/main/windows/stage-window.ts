import { app, BrowserWindow, screen } from "electron";
import path from "node:path";
import type { StageOutput } from "@shared/types/projection";
import { mt } from "../i18n";
import { trustWindow } from "../ipc/trusted-senders";
import { getSettingsRepo } from "../services/repos";
import { forwardKeysToControl } from "./projection-window";

const PRELOAD = path.join(__dirname, "../preload/index.js");

/**
 * The musicians' screen: what is live, what comes next and the time, on the
 * screen chosen in Settings ▸ Projection (`stage.displayId`). Unlike the
 * projector it is open whenever that screen is connected — the band reads the
 * time before anything goes live — and it plays nothing: a video shows as its
 * poster, so there is no media, no audio and no engine to keep in step.
 *
 * `syncStageWindow` is the one place that decides whether it exists and where:
 * called when the control window opens, when the setting changes and when a
 * screen comes or goes. A screen that disappears closes it (there is nothing in
 * it to lose, unlike the projector's audio); one that comes back reopens it.
 */
let current: { win: BrowserWindow; displayId: number } | null = null;
let lastOutput: StageOutput | null = null;

export function syncStageWindow(): void {
  let displayId: number | null = null;
  try {
    displayId = getSettingsRepo().get("stage.displayId");
  } catch {
    // Settings not ready: nothing to show yet.
  }
  const display = screen.getAllDisplays().find((candidate) => candidate.id === displayId);
  if (current && !current.win.isDestroyed() && current.displayId === display?.id) return;
  closeStageWindow();
  if (display) current = { win: createStageWindow(display), displayId: display.id };
}

export function closeStageWindow(): void {
  const open = current;
  current = null;
  if (open && !open.win.isDestroyed()) open.win.close();
}

export function showOnStage(output: StageOutput): void {
  lastOutput = output;
  if (current && !current.win.isDestroyed()) current.win.webContents.send("stage-content", output);
}

/** Pulled by the stage window once mounted, for the reason `projectionState`'s
 *  snapshot exists: a push sent while its page loads reaches nobody. */
export function stageSnapshot(): StageOutput | null {
  return lastOutput;
}

function createStageWindow(display: Electron.Display): BrowserWindow {
  // On the operator's own screen (one screen, or testing) a window they can
  // move, never a fullscreen one over the control window — the projector's rule.
  const own = display.id === screen.getPrimaryDisplay().id;
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: own ? 800 : display.bounds.width,
    height: own ? 450 : display.bounds.height,
    center: own,
    frame: own,
    fullscreen: !own,
    alwaysOnTop: !own,
    skipTaskbar: !own,
    backgroundColor: "#000000",
    title: mt("window.stageTitle"),
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
  forwardKeysToControl(win);
  win.on("page-title-updated", (event) => event.preventDefault());
  win.once("closed", () => {
    if (current?.win === win) current = null;
  });

  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (!app.isPackaged && devServerUrl) void win.loadURL(`${devServerUrl}/stage.html`);
  else void win.loadFile(path.join(__dirname, "../renderer/stage.html"));
  // Shown the way the projector is (see `createProjectionWindow`); a key that
  // reaches it anyway is forwarded to the control window.
  win.once("ready-to-show", () => (process.platform === "win32" ? win.showInactive() : win.show()));
  return win;
}
