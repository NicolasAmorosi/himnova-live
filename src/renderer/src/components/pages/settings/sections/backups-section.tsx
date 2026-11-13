import { useEffect, useState } from "react";
import type { BackupEntry, BackupKind } from "@shared/types/backups";
import { useT, type MessageKey } from "@renderer/lib/i18n/i18n-provider";
import {
  Button,
  Callout,
  Caption,
  ChoiceGroup,
  DialogContent,
  DialogFooter,
  DialogHeader,
  FieldGroup,
  FieldRow,
  LinearLoader,
} from "@renderer/components/ui";
import { ConfirmModal, Modal, ModalTitle } from "@renderer/components/shared/modal";
import { quitRiskText, quitRisks } from "@renderer/effects/draft-autosave";
import { backupWhen, createBackup, restoreBackup } from "@renderer/lib/actions/backups";
import { api } from "@renderer/lib/api";
import { toast } from "@renderer/lib/toast";
import type { CloseGuardReasons } from "@renderer/stores/ui.store";

const KIND_LABEL_KEYS: Record<BackupKind, MessageKey> = {
  daily: "settings.backupKinds.daily",
  update: "settings.backupKinds.update",
  restore: "settings.backupKinds.restore",
  file: "settings.backupKinds.file",
};

/** Settings › Backups: the database's copies (owner, 2026-11-13), in their own section since the same day
 *  («para un poco más de orden»): one made now and their folder, then the restore. */
export function BackupsSection() {
  const t = useT();
  const [making, setMaking] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);

  async function makeBackup() {
    setMaking(true);
    await createBackup();
    setMaking(false);
  }

  return (
    <div className="flex flex-col gap-8">
      <FieldGroup description={t("settings.backupsBody")} title={t("settings.groups.backupsMake")}>
        <FieldRow description={t("settings.backupNowDesc")} label={t("settings.backupNow")}>
          <Button loading={making} onClick={() => void makeBackup()} variant="outline">
            {t("settings.backupNowAction")}
          </Button>
        </FieldRow>
        <FieldRow description={t("settings.backupsFolderDesc")} label={t("settings.backupsFolder")}>
          <Button
            onClick={() => void api.backups.openFolder().catch(() => toast.danger(t("settings.backupsFolderError")))}
            variant="outline"
          >
            {t("settings.backupsFolderOpen")}
          </Button>
        </FieldRow>
      </FieldGroup>
      <FieldGroup title={t("settings.groups.backupsRestore")}>
        <FieldRow description={t("settings.restoreDesc")} label={t("settings.restore")}>
          <Button onClick={() => setRestoreOpen(true)} variant="outline">
            {t("settings.restoreOpen")}
          </Button>
        </FieldRow>
      </FieldGroup>
      <RestoreDialog onOpenChange={setRestoreOpen} open={restoreOpen} />
    </div>
  );
}

/** Every copy, newest first and the newest chosen, or a file picked anywhere else; «Restaurar y reiniciar»
 *  asks what a quit puts at risk first, as every quit does. */
function RestoreDialog({ onOpenChange, open }: { onOpenChange: (open: boolean) => void; open: boolean }) {
  const t = useT();
  const [entries, setEntries] = useState<BackupEntry[] | null>(null);
  const [chosen, setChosen] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [risks, setRisks] = useState<CloseGuardReasons | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setEntries(null);
    void api.backups
      .list()
      .catch(() => [])
      .then((list) => {
        if (!alive) return;
        setEntries(list);
        setChosen(list[0]?.path ?? "");
      });
    return () => {
      alive = false;
    };
  }, [open]);

  async function pickFile() {
    const entry = await api.backups.pick().catch(() => null);
    if (!entry) return;
    setEntries((list) => [entry, ...(list ?? []).filter((other) => other.path !== entry.path)]);
    setChosen(entry.path);
  }

  async function restore() {
    setRestoring(true);
    // The app restarts; only a refusal comes back.
    await restoreBackup(chosen);
    setRestoring(false);
  }

  function requestRestore() {
    const found = quitRisks();
    if (found) setRisks(found);
    else void restore();
  }

  const describe = (entry: BackupEntry) =>
    [
      t(KIND_LABEL_KEYS[entry.kind]),
      entry.programs !== null ? t("settings.backupPrograms", { count: entry.programs }) : null,
      entry.songs !== null ? t("settings.backupSongs", { count: entry.songs }) : null,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <>
      <Modal onOpenChange={onOpenChange} open={open} size="sm">
        <DialogHeader>
          <ModalTitle>{t("settings.restoreTitle")}</ModalTitle>
        </DialogHeader>
        <DialogContent className="flex flex-col gap-3">
          <Callout tone="warning">{t("settings.restoreBody")}</Callout>
          {entries === null ? (
            <LinearLoader className="w-full bg-muted" />
          ) : entries.length === 0 ? (
            <Caption>{t("settings.restoreEmpty")}</Caption>
          ) : (
            <div className="max-h-72 overflow-y-auto">
              <ChoiceGroup
                columns={1}
                label={t("settings.restoreTitle")}
                onChange={setChosen}
                options={entries.map((entry) => ({
                  description: describe(entry),
                  label: backupWhen(entry.takenAt),
                  value: entry.path,
                }))}
                value={chosen}
              />
            </div>
          )}
        </DialogContent>
        <DialogFooter>
          <Button className="mr-auto" onClick={() => void pickFile()} variant="outline">
            {t("settings.restorePick")}
          </Button>
          <Button onClick={() => onOpenChange(false)} variant="ghost">
            {t("common.cancel")}
          </Button>
          <Button disabled={chosen === ""} loading={restoring} onClick={requestRestore} variant="primary">
            {t("settings.restoreConfirm")}
          </Button>
        </DialogFooter>
      </Modal>
      <ConfirmModal
        confirmLabel={t("settings.restoreConfirm")}
        danger
        description={quitRiskText(risks)}
        onConfirm={restore}
        onOpenChange={(next) => {
          if (!next) setRisks(null);
        }}
        open={risks !== null}
        title={t("settings.restoreRisksTitle")}
      />
    </>
  );
}
