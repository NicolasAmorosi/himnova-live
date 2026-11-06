import { useState, type ReactNode } from "react";
import { Button, DialogContent, DialogFooter, DialogHeader } from "@renderer/components/ui";
import { ModalTitle } from "./ModalTitle";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Modal } from "./Modal";
import { toast } from "@renderer/lib/toast";

type ConfirmModalProps = {
  confirmLabel?: string;
  danger?: boolean;
  description?: ReactNode;
  onConfirm: () => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
  /** An unsaved-changes prompt that can save: a third button, «Guardar y
   *  salir» (owner, 2026-11-05), the dialog's primary — the discard turns
   *  outline. It saves, then does what the confirm does (leave, close). `false`
   *  (the save failed, and said so) keeps the dialog open. */
  onSave?: (() => Promise<boolean>) | undefined;
  /** The save button's words when what follows is not leaving: «Guardar y
   *  abrir», «Guardar y empezar». */
  saveLabel?: string | undefined;
  open: boolean;
  title: string;
};

export function ConfirmModal({
  confirmLabel,
  danger = false,
  description,
  onConfirm,
  onOpenChange,
  onSave,
  saveLabel,
  open,
  title,
}: ConfirmModalProps) {
  const t = useT();
  const [loading, setLoading] = useState<"confirm" | "save" | null>(null);

  async function run(which: "confirm" | "save") {
    setLoading(which);
    try {
      if (which === "save" && !(await onSave?.())) return;
      await onConfirm();
      onOpenChange(false);
    } catch (error) {
      // The modal stays open. A caller with its own error UI handles the
      // failure and does not rethrow, so reaching this means nobody said
      // anything: five confirmations (a forced delete, unlinking a folder,
      // emptying the slide cache…) used to stop their spinner and sit there.
      console.error("[confirm] action failed", error);
      toast.danger(t("app.unexpectedError"));
    } finally {
      setLoading(null);
    }
  }

  return (
    <Modal onOpenChange={onOpenChange} open={open} size="sm">
      <DialogHeader>
        <ModalTitle>{title}</ModalTitle>
      </DialogHeader>
      {description ? <DialogContent className="text-sm text-muted-foreground">{description}</DialogContent> : null}
      <DialogFooter>
        <Button onClick={() => onOpenChange(false)} variant="ghost">
          {t("common.cancel")}
        </Button>
        <Button
          disabled={loading === "save"}
          loading={loading === "confirm"}
          onClick={() => void run("confirm")}
          variant={danger ? "danger" : onSave ? "outline" : "primary"}
        >
          {confirmLabel ?? t("common.confirm")}
        </Button>
        {onSave ? (
          <Button
            disabled={loading === "confirm"}
            loading={loading === "save"}
            onClick={() => void run("save")}
            variant="primary"
          >
            {saveLabel ?? t("common.saveAndExit")}
          </Button>
        ) : null}
      </DialogFooter>
    </Modal>
  );
}
