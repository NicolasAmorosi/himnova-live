import { dialog, type BrowserWindow, type MessageBoxOptions, type MessageBoxReturnValue } from "electron";

/**
 * A box on `win`, shown only once the window is really visible. `showErrorBox`, or a box with no visible parent,
 * stopped main whole on macOS, and with it GO LIVE, NEGRO, the engine's frames and NDI (2026-11-15 audit, A23).
 * Minimized mid-service with the projector up (owner, 2026-11-13), the window is brought back first and the box waits
 * for the animated restore; the projector is never touched. Null when the window went first.
 */
export function showSheet(win: BrowserWindow, options: MessageBoxOptions): Promise<MessageBoxReturnValue | null> {
  if (win.isMinimized()) win.restore();
  else if (!win.isVisible()) win.show();
  return new Promise((resolve) => {
    const show = (): void => {
      if (win.isDestroyed()) return resolve(null);
      if (!win.isVisible()) return void setTimeout(show, 100);
      dialog.showMessageBox(win, options).then(resolve, () => resolve(null));
    };
    show();
  });
}
