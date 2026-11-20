import { app, type BrowserWindow } from "electron";
import path from "node:path";

/**
 * Loads one of the renderer's pages into `win`: from electron-vite's dev server under `electron-vite dev`, which sets
 * ELECTRON_RENDERER_URL, and from the build otherwise. `app.isPackaged` is the production check: the two together
 * avoid the church-presenter bug of NODE_ENV never being set and dev always falling through to the file.
 */
export function loadPage(win: BrowserWindow, page: string, query?: Record<string, string>): Promise<void> {
  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (!app.isPackaged && devServerUrl) {
    return win.loadURL(`${devServerUrl}/${page}${query ? `?${new URLSearchParams(query).toString()}` : ""}`);
  }
  return win.loadFile(path.join(__dirname, "../renderer", page), query ? { query } : {});
}
