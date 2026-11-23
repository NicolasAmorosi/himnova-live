import type { Handlers } from "../register";
import { getDraftRepo } from "../../services/repos";
import { isEditorDraft } from "../../db/repositories/draft.repo";
import { IpcError } from "@shared/ipc/result";
import { isEditorKind } from "@shared/types/editor-draft";

/** The editors' unsaved forms (`editor_drafts`, owner 2026-11-23, DU-1): kept and dropped by the control window,
 *  read once at launch. Main never reads `state`; it only refuses what is not a draft of a known editor. */
export const editorDraftsHandlers: Pick<Handlers, "editors:saveDraft" | "editors:loadDrafts"> = {
  "editors:saveDraft": ({ editor, draft }) => {
    if (!isEditorKind(editor) || (draft !== null && (!isEditorDraft(draft) || draft.editor !== editor))) {
      throw new IpcError({ code: "INVALID_ARGUMENT", message: "Invalid editor draft." });
    }
    getDraftRepo().saveEditor(editor, draft);
  },
  "editors:loadDrafts": () => getDraftRepo().editors(),
};
