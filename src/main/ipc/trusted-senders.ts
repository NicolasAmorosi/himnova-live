import type { BrowserWindow } from "electron";

/**
 * The `webContents` allowed to invoke IPC channels.
 *
 * The contract is a *type* contract: `registerHandlers` trusts whatever arrives
 * because the only thing that can arrive is one of our own windows. That
 * assumption is worth asserting rather than assuming, because the preload
 * bridge is generic — `invoke(channel, req)` reaches every channel in the
 * contract, so any context that gets hold of it gets hold of the whole surface,
 * including the ones that delete files and write settings.
 *
 * This is an allowlist of the windows the app itself creates that use the
 * contract (control, projection, stage and the NDI one); never the offscreen
 * rasterizer, which reads PDFs from anywhere and answers on its own channel
 * (`raster:reply`, checked against that window). It does not defend against a
 * script injected into one of those pages — that is the same webContents, and
 * what guards against it is never building markup from untrusted text (see
 * `.claude/knowledge/fts5-snippet-is-markup-wrapped-around-user-supplied-text.md`).
 * What it does close is everything else: a frame, a child window, or a page
 * that navigated somewhere it should not have.
 */
const trusted = new Set<number>();

export function trustWindow(win: BrowserWindow): void {
  const id = win.webContents.id;
  trusted.add(id);
  // Ids are recycled across the life of the process, so a stale entry is not
  // merely untidy — it would pre-approve whatever contents inherits the number.
  win.webContents.once("destroyed", () => trusted.delete(id));
}

export function isTrustedSender(webContentsId: number): boolean {
  return trusted.has(webContentsId);
}
