import { onIpc } from "@renderer/lib/ipc";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useUiStore } from "@renderer/stores/ui.store";

/** The toast while it may still be on screen. */
let toastId: string | null = null;

/**
 * «Himnova Live X is available», with «View», which opens Settings › About —
 * where downloading and installing live. Raised by whatever check finds the
 * version, which in practice is the one main runs on its own after launch.
 *
 * Once per version, not every morning until it is installed
 * (`updates.announcedVersion`), and only in this window: nothing about
 * updating ever reaches the projector. A version found from About itself is
 * already on screen there, so it counts as announced without a toast on top.
 */
export function startUpdateAnnouncement(): () => void {
  return onIpc("update-status", (status) => {
    // It carries an action, so it never leaves on its own: retired once the
    // version is downloading or gone, or it would offer a «View» of a state
    // that has moved on.
    if (status.kind !== "available") {
      if (toastId) toast.dismiss(toastId);
      toastId = null;
      return;
    }
    const { loaded, settings, update } = useSettingsStore.getState();
    if (!loaded || settings["updates.announcedVersion"] === status.version) return;
    // `update` merges before it persists, so a second `available` arriving
    // in the meantime already reads the version as announced.
    update({ "updates.announcedVersion": status.version }).catch((error: unknown) =>
      console.warn("[updates] could not remember the announced version", error),
    );
    if (useUiStore.getState().settingsSection === "about") return;
    toastId = toast.info(t("settings.updatesState.available", { version: status.version }), {
      action: { label: t("settings.updatesView"), onClick: () => useUiStore.getState().openSettings("about") },
    });
  });
}
