import { api } from "@renderer/lib/api";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { IpcError } from "@shared/ipc/result";
import type { BackupEntry } from "@shared/types/backups";

/** A copy's date and time, in the interface's language. */
export function backupWhen(takenAt: number): string {
  const locale = useSettingsStore.getState().settings["ui.locale"];
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short" }).format(takenAt);
}

/** «Hacer una copia»: taken off main's thread, said when done. */
export async function createBackup(): Promise<BackupEntry | null> {
  try {
    const entry = await api.backups.create();
    toast.success(t("settings.backupDone", { when: backupWhen(entry.takenAt) }));
    return entry;
  } catch (error) {
    console.warn("[backups] copy failed", error);
    toast.danger(t("settings.backupFailed"));
    return null;
  }
}

/** Stages `path` and restarts: nothing comes back unless main refused it, in its own words (damaged, not a
 *  Himnova copy, from a newer version). Whoever calls it already asked what a quit puts at risk. */
export async function restoreBackup(path: string): Promise<void> {
  try {
    await api.backups.restore(path);
  } catch (error) {
    console.warn("[backups] restore refused", error);
    toast.danger(error instanceof IpcError && error.code === "BACKUP_REFUSED" ? error.message : t("settings.restoreError"));
  }
}

/** What the restore before this launch did, said once the window is up. */
export async function announceLaunchRestore(): Promise<void> {
  const outcome = await api.backups.launchRestore().catch(() => null);
  if (outcome?.status === "ok") toast.success(t("settings.restored", { when: backupWhen(outcome.takenAt) }));
  else if (outcome?.status === "failed") toast.danger(t("settings.restoreFailed"));
}
