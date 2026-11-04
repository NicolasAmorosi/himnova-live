import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Button, Icon, type IconName } from "@renderer/components/ui";

type EditorActionsProps = {
  canSave: boolean;
  dirty: boolean;
  /** `false` for a draft that does not exist yet: it has nothing to copy or delete. */
  persisted: boolean;
  onDelete: () => void;
  onDuplicate: () => void;
  onRevert: () => void;
  onSave: () => void;
  saving: boolean;
};

/**
 * The «Scenes», «Overlays» and song editors' actions as one row of icons under
 * «New», in the list column. Icon-only, so each one carries its label as
 * `aria-label` and `title`. A draft's copy and delete are DISABLED rather than
 * hidden, so the row never reflows under the pointer — and «Delete» sits at
 * the far end, as far from «Save» as the row allows.
 */
export function EditorActions({
  canSave,
  dirty,
  onDelete,
  onDuplicate,
  onRevert,
  onSave,
  persisted,
  saving,
}: EditorActionsProps) {
  const t = useT();
  const actions: { disabled: boolean; icon: IconName; label: string; onClick: () => void }[] = [
    { disabled: !dirty, icon: "restart", label: t("common.revert"), onClick: onRevert },
    { disabled: !persisted, icon: "copy", label: t("common.duplicate"), onClick: onDuplicate },
    { disabled: !persisted, icon: "remove", label: t("common.delete"), onClick: onDelete },
  ];
  return (
    <div className="grid grid-cols-4 gap-1.5">
      <Button
        aria-label={t("common.save")}
        disabled={!canSave}
        loading={saving}
        onClick={onSave}
        size="xs"
        title={t("common.save")}
      >
        <Icon name="save" />
      </Button>
      {actions.map(({ disabled, icon, label, onClick }) => (
        <Button
          aria-label={label}
          disabled={disabled}
          key={icon}
          onClick={onClick}
          size="xs"
          title={label}
          variant="outline"
        >
          <Icon name={icon} />
        </Button>
      ))}
    </div>
  );
}
