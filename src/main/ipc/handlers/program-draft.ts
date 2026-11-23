import { BrowserWindow } from "electron";
import type { Handlers } from "../register";
import { getDraftRepo, getSettingsRepo } from "../../services/repos";
import { controlWindows } from "../../services/broadcast";
import { projectionState } from "../../services/projection-state";
import { stopPreviewEngine } from "../../media/engine-sessions";
import { resolveClose } from "../../windows/close-guard";

/** The control window's copy of what is live (`window:keepLiveCopy`), for a page of it that starts again. */
let liveCopy: unknown = null;

/** The control window closed: a window opened after it (macOS keeps the app) starts from nothing. */
export function forgetLiveCopy(): void {
  liveCopy = null;
}

/** A clean close: the control window's page answered «close» (`window:closeDecision`), or the update or the restore
 *  quit after the page asked (`releaseForUpdate`). The projector goes with the window, so no row is on air and the
 *  next launch puts none in PREVIEW (`programs.liveRow`, DU-6); a restored copy swapped in at that launch brings its own
 *  mark. Not from the window's `closed`: a hung page's window closed by the grace gets there too, and that end is the
 *  crash the mark is for. A crash, a killed process or a power cut never call this either, nor a dead page's box
 *  (`askWithoutPage`): that page could not say what was on air. */
export function forgetLiveRow(): void {
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
    if (!win) return;
    if (decision === "close") forgetLiveRow();
    resolveClose(win, decision);
  },
};
