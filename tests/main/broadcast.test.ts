import { expect, test, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { broadcast, registerBroadcastTarget } from "../../src/main/services/broadcast";

test("a control window whose page died is sent nothing, so main.log is not flooded until it comes back", () => {
  let crashed = true;
  const send = vi.fn();
  const win = { isDestroyed: () => false, once: () => undefined, webContents: { isCrashed: () => crashed, send } };
  registerBroadcastTarget(win as unknown as BrowserWindow);

  // Fails if a dead page is still sent to: each send logged a stack, ~29 a second with music on (2026-11-16).
  broadcast("library-changed", { kind: "video" });
  expect(send).not.toHaveBeenCalled();

  crashed = false;
  broadcast("library-changed", { kind: "video" });
  expect(send).toHaveBeenCalledWith("library-changed", { kind: "video" });
});
