import { BrowserWindow, screen } from "electron";

const SHOWN_MS = 3_000;
const WIDTH = 560;
const HEIGHT = 340;
let open: BrowserWindow[] = [];

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * «Identificar» (Settings ▸ Screens): every screen shows, for three seconds, the number the map gives it and its
 * name, so «Pantalla 2» on the map is a wall the operator can point at. Over everything, the fullscreen projector
 * and stage included, and never taking the keyboard. The numbers and names come from the control window: the
 * map's, so the two can never disagree. A second press replaces the first.
 */
export function identifyDisplays(screens: readonly { id: number; number: number; name: string }[]): void {
  for (const win of open) if (!win.isDestroyed()) win.close();
  open = [];
  const displays = screen.getAllDisplays();
  for (const { id, number, name } of screens) {
    const display = displays.find((d) => d.id === id);
    // What reaches an HTML page is checked here: only a whole number and a string.
    if (!display || !Number.isInteger(number) || typeof name !== "string") continue;
    const area = display.bounds;
    const win = new BrowserWindow({
      x: area.x + Math.round((area.width - WIDTH) / 2),
      y: area.y + Math.round((area.height - HEIGHT) / 2),
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      // The identity sheet's navy and text, as in the app.
      backgroundColor: "#162231",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    // Over a fullscreen window on its own Space (macOS).
    if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:#162231;color:#eef2f6;font-family:system-ui,sans-serif;border:6px solid #78a8b2;box-sizing:border-box;overflow:hidden"><div style="font-size:190px;font-weight:700;line-height:1">${number}</div><div style="font-size:26px;max-width:90%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(name)}</div></body>`;
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    win.once("ready-to-show", () => win.showInactive());
    setTimeout(() => {
      if (!win.isDestroyed()) win.close();
    }, SHOWN_MS);
    open.push(win);
  }
}
