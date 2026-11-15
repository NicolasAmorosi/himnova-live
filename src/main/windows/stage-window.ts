import { app, BrowserWindow, powerSaveBlocker, screen, type Display } from "electron";
import path from "node:path";
import type { StageOutput } from "@shared/types/projection";
import { mt } from "../i18n";
import { trustWindow } from "../ipc/trusted-senders";
import { broadcast } from "../services/broadcast";
import { getSettingsRepo } from "../services/repos";
import { projectionState } from "../services/projection-state";
import { syncLiveEngine } from "../media/engine-sessions";
import { forwardKeysToControl } from "./projection-window";
import { operatorDisplay } from "./control-window";
import { chooseStageDisplay } from "./projector-display-choice";

const PRELOAD = path.join(__dirname, "../preload/index.js");

/**
 * The musicians' screen: what is live, what comes next and the time, on the
 * screen chosen in Settings ▸ Screens (`stage.displayId`). Unlike the
 * projector it is open whenever that screen is connected — the band reads the
 * time before anything goes live. It plays what is live, videos included,
 * unless Settings turns that off (`videoMotion`): then a video is its poster
 * and it decodes nothing (`syncCopy`). Always silent.
 *
 * `syncStageWindow` is the one place that decides whether it exists and where:
 * called when the control window opens, when its setting or the projector's
 * changes and when a screen comes or goes. A screen that disappears closes it
 * (there is nothing in it to lose, unlike the projector's audio); one that
 * comes back reopens it. Never on the projector's screen (`chooseStageDisplay`).
 * Whether it is on screen is told to the control window (`stage-screen`): the
 * stage panel's dot, and a toast when a screen coming or going is the reason.
 * While it exists the screens stay awake, as they do while the projector
 * exists: the band reads the time long before the first GO LIVE.
 *
 * Closed by the operator (its ✕, Alt+F4) it stays closed for the session, as
 * the projector does (owner, 2026-11-15): no screen coming or going brings it
 * back, only `reopenStageWindow` (the stage panel's «Reabrir», or a stage role
 * chosen again in Settings ▸ Screens: «Escenario» or «Copia del proyector», for the same screen or another).
 */
let current: { win: BrowserWindow; displayId: number; own: boolean; blocker: number } | null = null;
let lastOutput: StageOutput | null = null;
let shown = false;
let closedByOperator = false;

/** `byScreens`: called because a screen came or went, not because a setting changed. */
export function syncStageWindow(byScreens = false): void {
  let displayId: number | null = null;
  try {
    const settings = getSettingsRepo();
    const displays = screen.getAllDisplays().map((candidate) => candidate.id);
    displayId = chooseStageDisplay(
      displays,
      operatorDisplay().id,
      settings.get("stage.displayId"),
      settings.get("projection.displayId"),
    );
  } catch {
    // Settings not ready: nothing to show yet.
  }
  const display = closedByOperator ? undefined : screen.getAllDisplays().find((candidate) => candidate.id === displayId);
  // The control window moved onto the stage's screen (or off it) is a different window there: a movable one, never
  // a fullscreen one on top of the operator's (2026-11-14 review).
  const own = display !== undefined && display.id === operatorDisplay().id;
  if (!(current && !current.win.isDestroyed() && current.displayId === display?.id && current.own === own)) {
    closeStageWindow();
    if (display) {
      const win = createStageWindow(display, own);
      current = { win, displayId: display.id, own, blocker: powerSaveBlocker.start("prevent-display-sleep") };
      syncCopy();
    }
  }
  const now = current !== null;
  if (now === shown) return;
  shown = now;
  broadcast("stage-screen", { shown, byScreens, closed: closedByOperator });
}

/** Undoes the operator's closing it: open again wherever `syncStageWindow` puts it, if anywhere. */
export function reopenStageWindow(): void {
  if (!closedByOperator) return;
  closedByOperator = false;
  syncStageWindow();
  // No screen to open on: the panel still has to stop offering «Reabrir».
  if (!shown) broadcast("stage-screen", { shown, byScreens: false, closed: false });
}

/** Whether the stage window is on screen now, and whether the operator closed it (the stage panel's dot, at mount). */
export function stageShown(): { shown: boolean; closed: boolean } {
  return { shown, closed: closedByOperator };
}

export function closeStageWindow(): void {
  const open = current;
  current = null;
  if (!open) return;
  powerSaveBlocker.stop(open.blocker);
  if (!open.win.isDestroyed()) open.win.close();
}

/** Its screen changed size (another resolution, a rotated monitor): fullscreen there again. macOS resizes a
 *  fullscreen window on its own; Windows and Linux leave it at the old size. */
export function refitStageWindow(display: Display): void {
  if (process.platform === "darwin" || !current || current.win.isDestroyed() || current.displayId !== display.id) return;
  if (current.win.isFullScreen()) current.win.setBounds(display.bounds);
}

export function showOnStage(output: StageOutput): void {
  lastOutput = output;
  if (current && !current.win.isDestroyed()) current.win.webContents.send("stage-content", output);
  syncCopy();
}

/** While the stage plays videos (`videoMotion`, the default) it is one of the projector's mirrors, so it gets the
 *  projector's pushes, its reports and the engine's frames — and only then: with stills it decodes nothing. */
function syncCopy(): void {
  const win = current?.win;
  if (!win || win.isDestroyed()) return;
  const copy = lastOutput?.videoMotion === true;
  if (copy === projectionState.isMirror(win)) return;
  // Unwatched: the room does not look at it, so a video's start never waits for it to draw (2026-11-14 review).
  if (copy) projectionState.addMirror(win, false);
  else projectionState.removeMirror(win);
  syncLiveEngine();
}

/** Pulled by the stage window once mounted, for the reason `projectionState`'s
 *  snapshot exists: a push sent while its page loads reaches nobody. */
export function stageSnapshot(): StageOutput | null {
  return lastOutput;
}

/** `own`: on the operator's own screen (one screen, or testing) a window they can move, never a fullscreen one over
 *  the control window — the projector's rule. */
function createStageWindow(display: Electron.Display, own: boolean): BrowserWindow {
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
  // Never a sound: it plays what the projector plays, and the room hears the projector.
  win.webContents.setAudioMuted(true);
  forwardKeysToControl(win);
  win.on("page-title-updated", (event) => event.preventDefault());
  win.once("closed", () => {
    if (current?.win !== win) return;
    powerSaveBlocker.stop(current.blocker);
    current = null;
    shown = false;
    // Main's own closing drops `current` first, so only the operator gets here.
    closedByOperator = true;
    broadcast("stage-screen", { shown, byScreens: false, closed: true });
  });

  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (!app.isPackaged && devServerUrl) void win.loadURL(`${devServerUrl}/stage.html`);
  else void win.loadFile(path.join(__dirname, "../renderer/stage.html"));
  // Shown the way the projector is (see `createProjectionWindow`); a key that
  // reaches it anyway is forwarded to the control window.
  win.once("ready-to-show", () => (process.platform === "win32" ? win.showInactive() : win.show()));
  return win;
}
