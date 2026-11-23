import { ConfirmModal } from "@renderer/components/shared/modal";
import { useI18n } from "@renderer/lib/i18n/i18n-provider";
import {
  discardEditorDrafts,
  postponeEditorDrafts,
  recoverEditorDrafts,
  useEditorRecovery,
} from "./use-editor-draft";

/**
 * «¿Recuperar lo que estabas editando?»: what the editors left unsaved when the app went down, every one named, with
 * «Recuperar» (each editor opens on its form, one after the other) and «Descartar» (owner, 2026-11-23, DU-1). The
 * small `ConfirmModal`, as every question about unsaved work. `blocked` holds it behind the welcome and «Novedades».
 */
export function EditorDraftsNotice({ blocked }: { blocked: boolean }) {
  const { locale, t } = useI18n();
  const pending = useEditorRecovery((s) => s.pending);
  const asking = useEditorRecovery((s) => s.asking);
  const items = new Intl.ListFormat(locale, { type: "conjunction" }).format(
    pending.map((draft) => t(`editorDrafts.kinds.${draft.editor}`, { name: draft.name.trim() || t("editorDrafts.untitled") })),
  );
  return (
    <ConfirmModal
      confirmLabel={t("editorDrafts.recover")}
      description={t("editorDrafts.body", { items })}
      onConfirm={recoverEditorDrafts}
      onOpenChange={(open) => {
        if (!open) postponeEditorDrafts();
      }}
      open={asking && pending.length > 0 && !blocked}
      secondary={{ label: t("editorDrafts.discard"), onClick: discardEditorDrafts }}
      title={t("editorDrafts.title")}
    />
  );
}
