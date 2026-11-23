/** The five full-screen editors that save on demand («Guardar»): the ones whose unsaved form has a draft. */
export const EDITOR_KINDS = ["song", "songTheme", "plate", "scene", "program"] as const;
export type EditorKind = (typeof EDITOR_KINDS)[number];

/**
 * What an editor was in the middle of, kept while it has unsaved changes (`use-editor-draft.ts`) and offered at the
 * next launch when the app went down before it was saved (owner, 2026-11-23, DU-1). One per editor, since each is one
 * screen with one form.
 *
 * `state` is the editor's own form, as it hands it over and takes it back: its shape is that editor's business, and
 * `v` drops one another build wrote.
 */
export type EditorDraft = {
  v: 1;
  editor: EditorKind;
  /** What it edits, `null` for something new: where the editor opens it again. */
  id: number | null;
  /** Its name as typed, for the notice. */
  name: string;
  state: unknown;
  updatedAt: number;
};

export function isEditorKind(value: unknown): value is EditorKind {
  return (EDITOR_KINDS as readonly unknown[]).includes(value);
}
