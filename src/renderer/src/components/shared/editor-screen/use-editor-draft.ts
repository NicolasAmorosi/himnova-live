import { useEffect, useRef } from "react";
import { create } from "zustand";
import { api } from "@renderer/lib/api";
import type { EditorDraft, EditorKind } from "@shared/types/editor-draft";

/** The order of service's draft's pace (`draft-autosave.ts`): a keystroke or two at risk, one write per burst. */
const DEBOUNCE_MS = 600;

type EditorRecoveryState = {
  /** What the editors left unsaved when the app last went down, neither recovered nor discarded yet. */
  pending: EditorDraft[];
  /** The notice is up (`EditorDraftsNotice`). */
  asking: boolean;
  /** «Recuperar»: the editors to open, one at a time. The first is open (or opening); the next opens when it closes. */
  queue: EditorDraft[];
};

/**
 * The drafts of the five editors with «Guardar» (owner, 2026-11-23, DU-1). Each editor keeps its own form on disk
 * while it has unsaved changes (`useEditorDraft`), so a crash, a killed process or a power cut costs a keystroke or
 * two, not the song typed for ten minutes. At the next launch `App` offers what was left (`offerEditorDrafts`), and
 * «Recuperar» opens each editor on its form, taking the operator to its tab.
 */
export const useEditorRecovery = create<EditorRecoveryState>(() => ({ pending: [], asking: false, queue: [] }));

let offered = false;

/** At launch, once, after the order of service is back: what the editors left, and the notice if anything. */
export async function offerEditorDrafts(): Promise<void> {
  if (offered) return;
  offered = true;
  try {
    const pending = await api.editors.loadDrafts();
    useEditorRecovery.setState({ pending, asking: pending.length > 0 });
  } catch (error) {
    // The drafts are a safety net, never a reason for the launch to fail.
    console.warn("[editors] drafts not read", error);
  }
}

export function recoverEditorDrafts(): void {
  const { pending, queue } = useEditorRecovery.getState();
  useEditorRecovery.setState({ pending: [], asking: false, queue: [...queue, ...pending] });
}

export async function discardEditorDrafts(): Promise<void> {
  const { pending } = useEditorRecovery.getState();
  useEditorRecovery.setState({ pending: [], asking: false });
  await Promise.all(pending.map((draft) => api.editors.saveDraft(draft.editor, null)));
}

/** «Cancelar» or Escape: neither. They stay on disk, and opening one of those editors asks again before its own
 *  form replaces them. */
export function postponeEditorDrafts(): void {
  useEditorRecovery.setState({ asking: false });
}

/** The draft «Recuperar» is opening now, when it is `editor`'s: what the panel that holds that editor opens it on. */
export function useRecovering(editor: EditorKind): EditorDraft | null {
  return useEditorRecovery((s) => (s.queue[0]?.editor === editor ? s.queue[0] : null));
}

/** The editors with unsaved changes right now, and whether a quit the operator confirmed already dropped them. */
const unsavedNow = new Set<EditorKind>();
let dropped = false;

/** A quit the operator confirmed over unsaved editors («Cerrar igualmente»): their drafts go with it, or the next
 *  launch would offer what they chose to lose. Nothing this page writes after it reaches the disk. Drafts left by an
 *  earlier run and not touched since stay. */
export function dropEditorDrafts(): void {
  dropped = true;
  for (const editor of unsavedNow) {
    void api.editors.saveDraft(editor, null).catch((error: unknown) => console.warn("[editors] draft not dropped", error));
  }
}

/** A recovered draft the editor took back leaves «Recuperar»'s queue: the next one opens. By identity, so a second
 *  call is a no-op. */
function releaseRecovered(applied: { current: EditorDraft | null }): void {
  const draft = applied.current;
  if (draft === null) return;
  applied.current = null;
  useEditorRecovery.setState((s) => ({ queue: s.queue.filter((queued) => queued !== draft) }));
}

/** What an editor hands over: what it edits (`null`: something new), its name for the notice, and its form. */
export type EditorSnapshot = { id: number | null; name: string; state: unknown };

/**
 * One editor's draft, shared by the five (`EditorScreen` is only their shell and holds no form). While it is open
 * with unsaved changes, its snapshot goes to disk 600 ms after the last change; once it has none (saved, discarded,
 * closed with nothing to lose) the row is dropped at once. A page that goes away with changes leaves it, which is the
 * point. `restore` takes a recovered draft back into the form, once the editor is open on it.
 *
 * Call it AFTER the editor's own effect that loads what it opens: both run as it opens, and the recovered form has to
 * be the last word.
 */
export function useEditorDraft(
  editor: EditorKind,
  open: boolean,
  dirty: boolean,
  { id, name, state }: EditorSnapshot,
  restore: (draft: EditorDraft) => void,
): void {
  const unsaved = open && dirty;
  /** This editor's row is on disk: written here, or recovered. */
  const held = useRef(false);
  /** The recovered draft this editor took back, until it closes or goes. */
  const applied = useRef<EditorDraft | null>(null);
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  const recovering = useRecovering(editor);

  useEffect(() => {
    if (!open || recovering === null || applied.current) return;
    applied.current = recovering;
    held.current = true;
    restoreRef.current(recovering);
  }, [open, recovering]);

  // Closed after a recovery: the next one opens.
  useEffect(() => {
    if (!open) releaseRecovered(applied);
  }, [open]);

  // Opened by hand with this editor's row put off: asked again, before its own form replaces it.
  useEffect(() => {
    if (open && useEditorRecovery.getState().pending.some((draft) => draft.editor === editor)) {
      useEditorRecovery.setState({ asking: true });
    }
  }, [open, editor]);

  useEffect(() => {
    if (!unsaved) {
      unsavedNow.delete(editor);
      if (!held.current) return;
      held.current = false;
      void api.editors.saveDraft(editor, null).catch((error: unknown) => console.warn("[editors] draft not dropped", error));
      return;
    }
    unsavedNow.add(editor);
    const timer = window.setTimeout(() => {
      if (dropped) return;
      held.current = true;
      // Its row replaces the one left from before, which is no longer there to recover.
      useEditorRecovery.setState((s) => ({ pending: s.pending.filter((draft) => draft.editor !== editor) }));
      const draft: EditorDraft = { v: 1, editor, id, name, state, updatedAt: Date.now() };
      void api.editors.saveDraft(editor, draft).catch((error: unknown) => {
        // One lost write is survivable: the next change writes again.
        console.warn("[editors] draft not kept", error);
      });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [editor, unsaved, id, name, state]);

  // Gone with its changes (its boundary caught a throw): the row stays, but a later quit no longer drops it. A
  // recovered form leaves the queue too: maybe it was what threw, and still first there it broke the editor again at
  // every opening for the rest of the session. The row stays on disk, offered at the next launch.
  useEffect(
    () => () => {
      unsavedNow.delete(editor);
      releaseRecovered(applied);
    },
    [editor],
  );
}
