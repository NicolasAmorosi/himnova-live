import {
  BrowserWindow,
  dialog,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
  type SaveDialogOptions,
  type SaveDialogReturnValue,
  type WebContents,
} from "electron";

/**
 * `dialog.showOpenDialog`, owned by the window that asked. Without an owner,
 * Windows gives the dialog a taskbar entry of its own and is free to open it
 * BEHIND the app, where an operator in a hurry never finds it; on macOS it
 * becomes a sheet of that window instead of a free-floating panel.
 */
export function showOpenDialogFor(sender: WebContents, options: OpenDialogOptions): Promise<OpenDialogReturnValue> {
  const owner = BrowserWindow.fromWebContents(sender);
  return owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options);
}

/** `dialog.showSaveDialog`, owned the same way. */
export function showSaveDialogFor(sender: WebContents, options: SaveDialogOptions): Promise<SaveDialogReturnValue> {
  const owner = BrowserWindow.fromWebContents(sender);
  return owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options);
}
