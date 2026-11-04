import type { BrowserWindow } from "electron";
import type { IpcEventName, IpcEvents } from "@shared/ipc/contract";

/**
 * Windows that listen to the control-side event channels.
 *
 * This used to be `BrowserWindow.getAllWindows()`, which meant every
 * `deck-progress`, `prewarm-progress`, `media-status`, `library-changed` and
 * `library-import-progress` was also serialized and pushed to two windows that
 * subscribe to none of them: the projection window and the offscreen
 * rasterizer. `media-status` was the clearest case — it ORIGINATES in the
 * projection window, travels to main, and was sent straight back to it.
 *
 * A registry rather than an `isProjectionWindow()`-style exclusion, because
 * the default has to be "receives nothing": a window added later (another
 * offscreen helper) should have to ask for these events, not silently start
 * getting them.
 */
const targets = new Set<BrowserWindow>();

/** Called by `createControlWindow`. Deregisters itself when the window goes,
 *  so a closed-and-reopened control window leaves nothing behind. */
export function registerBroadcastTarget(win: BrowserWindow): void {
  targets.add(win);
  win.once("closed", () => targets.delete(win));
}

/**
 * Push an event to every window that listens to control-side channels.
 *
 * Targeted sends (the projection window specifically) still go through
 * `projectionState` / `webContents.send` directly — the three projection
 * channels in `IpcEvents` are never broadcast.
 */
export function broadcast<K extends IpcEventName>(channel: K, payload: IpcEvents[K]): void {
  for (const win of targets) {
    if (win.isDestroyed()) continue;
    win.webContents.send(channel, payload);
  }
}

/** Those same windows, for what reaches them another way: the media engine's frames
 *  (`media/engine-sessions.ts`), which the LIVE monitor draws. */
export function controlWindows(): BrowserWindow[] {
  return [...targets].filter((win) => !win.isDestroyed());
}
