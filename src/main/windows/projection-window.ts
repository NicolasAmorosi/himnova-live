import { app, BrowserWindow, screen } from "electron";
import path from "node:path";
import { mt } from "../i18n";
import { trustWindow } from "../ipc/trusted-senders";
import { broadcast } from "../services/broadcast";
import { operatorDisplay } from "./control-window";
import { attachProjector } from "./projector-screen";

const PRELOAD = path.join(__dirname, "../preload/index.js");
/** The projector as a window: 16:9, like the stage's. */
const WINDOWED_WIDTH = 800;
const WINDOWED_HEIGHT = 450;

/**
 * Recreated (not reused) on every `projection:open`, exactly like the legacy
 * `createPresentationWindow` — so main must replay `lastOutput` once the new
 * window finishes loading (see ipc/handlers/projection.ts), or a reopened
 * projection sits blank even though the control window thinks it's live.
 */
export function createProjectionWindow(displayId?: number): BrowserWindow {
  const displays = screen.getAllDisplays();
  const operator = operatorDisplay();
  const target =
    (displayId !== undefined && displays.find((d) => d.id === displayId)) ||
    displays.find((d) => d.id !== operator.id) ||
    operator;

  // On the operator's own screen — one screen, or chosen there on purpose — a window they can move
  // (owner, 2026-11-10): fullscreen and always on top it covered the control window, and with it the
  // only way to close it. Centred on that screen: `center` does nothing next to an `x`/`y`, and left
  // it in a corner, under the control window (A14).
  const windowed = target.id === operator.id;
  const area = target.workArea;
  const bounds = windowed
    ? {
        x: area.x + Math.round((area.width - WINDOWED_WIDTH) / 2),
        y: area.y + Math.round((area.height - WINDOWED_HEIGHT) / 2),
        width: WINDOWED_WIDTH,
        height: WINDOWED_HEIGHT,
      }
    : target.bounds;

  const win = new BrowserWindow({
    ...bounds,
    useContentSize: windowed,
    frame: windowed,
    fullscreen: !windowed,
    alwaysOnTop: !windowed,
    skipTaskbar: !windowed,
    backgroundColor: "#000000",
    title: mt("window.projectionTitle"),
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
  attachProjector(win, target.id);
  // The page's <title> would replace the localized one on every load.
  win.on("page-title-updated", (event) => event.preventDefault());

  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  // See `control-window.ts` for why these are `void` and not `.catch`.
  if (!app.isPackaged && devServerUrl) {
    void win.loadURL(`${devServerUrl}/projection.html`);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/projection.html"));
  }

  // Never focused on Windows: the operator's next →, B or Enter belongs to the
  // control window, and a focused projector also answered the window's own
  // shortcuts there. macOS keeps `show()`: a native fullscreen window on a
  // second display was verified with it (2026-10-14 rehearsal), and
  // `showInactive` there has not been.
  win.once("ready-to-show", () => (process.platform === "win32" ? win.showInactive() : win.show()));
  // The projector has no keys of its own. Whatever reaches it — on macOS it
  // takes the keyboard when it opens, and a click on its screen gives it the
  // keyboard on any system — is the operator's shortcut, answered by the
  // control window as if pressed there; before this, → and B did nothing until
  // the operator clicked back on the control window.
  forwardKeysToControl(win);
  if (!windowed) {
    win.setAlwaysOnTop(true, "screen-saver");
  }

  return win;
}

/** Every key that reaches `win` is the operator's shortcut, answered by the
 *  control window as if pressed there (see the comment above its call). */
export function forwardKeysToControl(win: BrowserWindow): void {
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.control || input.meta || input.alt) return;
    event.preventDefault();
    broadcast("projector-key", { key: input.key, repeat: input.isAutoRepeat, shift: input.shift, code: input.code });
  });
}
