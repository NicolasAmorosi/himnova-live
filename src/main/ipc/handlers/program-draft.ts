import { BrowserWindow } from "electron";
import type { Handlers } from "../register";
import { getDraftRepo, getSettingsRepo } from "../../services/repos";
import { controlWindows } from "../../services/broadcast";
import { projectionState } from "../../services/projection-state";
import { stopPreviewEngine } from "../../media/engine-sessions";
import { resolveClose } from "../../windows/close-guard";

/** The control window's copy of what is live (`window:keepLiveCopy`), for a page of it that starts again. */
let liveCopy: unknown = null;

/** The control window closed: a window opened after it (macOS keeps the app) starts from nothing. A close is clean by
 *  the time this runs (the operator answered, or the update and the restore quit the same way), and the projector
 *  went with the window: no row is on air, so the next launch puts none in PREVIEW (`programs.liveRow`, DU-6). A
 *  crash, a killed process or a power cut never gets here and leaves the mark. */
export function forgetLiveCopy(): void {
  liveCopy = null;
  try {
    getSettingsRepo().setMany({ "programs.liveRow": null });
  } catch (error) {
    // The window's other chores after this one still run: the worst left is one row in PREVIEW at the next launch.
    console.warn("[draft] the live row mark could not be cleared", error);
  }
}

export const programDraftHandlers: Pick<
  Handlers,
  "program:saveDraft" | "program:loadDraft" | "window:closeDecision" | "window:keepLiveCopy" | "window:liveCopy"
> = {
  "window:keepLiveCopy": (copy, ev) => {
    if (controlWindows().some((win) => win.webContents === ev.sender)) liveCopy = copy;
  },
  "window:liveCopy": () => {
    stopPreviewEngine();
    const { mediaStatus } = projectionState.getSnapshot();
    return { copy: liveCopy, projectorOpen: projectionState.getWindow() !== null, mediaStatus };
  },

  "program:saveDraft": (draft) => {
    if (draft === null) getDraftRepo().clear();
    else getDraftRepo().save(draft);
  },
  "program:loadDraft": () => getDraftRepo().load(),

  // The control window answering the `close-requested` it was sent. Resolved
  // against the sender rather than a remembered handle: `ev.sender` is by
  // definition the window that was asked.
  "window:closeDecision": ({ decision }, ev) => {
    const win = BrowserWindow.fromWebContents(ev.sender);
    if (win) resolveClose(win, decision);
  },
};
