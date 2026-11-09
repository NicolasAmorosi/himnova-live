import { useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Button, FieldGroup, FieldRow, Segmented } from "@renderer/components/ui";
import { ConfirmModal } from "@renderer/components/shared/modal";
import { selectOutputMemo, useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { api } from "@renderer/lib/api";
import { toast } from "@renderer/lib/toast";
import { IpcError } from "@shared/ipc/result";
import { logoModeOf } from "@shared/types/settings";
import { LogoSceneFields } from "./logo-scene-fields";

/** «Logo»: what LOGO shows — an image, or the church's name over a background. Settings ▸ Projection's,
 *  and the welcome's «Tu iglesia» step, which draws the preview bigger beside it (`preview={false}`). */
export function LogoGroup({ description, preview = true }: { description?: string; preview?: boolean }) {
  const t = useT();
  const presentationOpen = useProjectionStore((s) => s.presentationOpen);
  // What the projector is showing right now, read the same way the LIVE
  // monitor reads it — the only honest way to know whether removing the logo
  // is about to blank a screen the congregation is looking at.
  const output = useProjectionStore(selectOutputMemo);
  const logoPath = useSettingsStore((s) => s.settings["logo.path"]);
  const logoMode = logoModeOf(useSettingsStore((s) => s.settings["logo.mode"]), logoPath);
  const updateSettings = useSettingsStore((s) => s.update);
  const logoOnAir = presentationOpen && output.kind === "logo";
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function changeLogo() {
    try {
      await api.files.setLogo();
    } catch (error) {
      // Main refuses an image it cannot decode rather than persisting one that
      // would leave LOGO black on the projector, so there is nothing to
      // reload: the previous logo is still the one in the database.
      if (error instanceof IpcError && error.code === "LOGO_UNREADABLE") {
        toast.danger(t("settings.logoUnreadable"));
        return;
      }
      throw error;
    }
    // Refreshes `settings.store` from the DB — this drives both this
    // thumbnail and (via App.tsx) the logo actually shown on the projector.
    await useSettingsStore.getState().load();
  }

  /** Clears the setting, not a file: the image stays where it is on disk and
   *  can be picked again. Written through the store (unlike `changeLogo`,
   *  where main itself wrote the row and the store had to re-read it), so the
   *  thumbnail below and the projector both follow immediately. */
  async function removeLogo() {
    await updateSettings({ "logo.path": null });
  }

  function handleRemoveLogo() {
    if (logoOnAir) setConfirmRemove(true);
    else void removeLogo();
  }

  return (
    <>
      <FieldGroup description={description} title={t("settings.groups.logo")}>
        {/* One of two, chosen (owner, 2026-11-05): before, a loaded image
            silently won and the name rows below it stopped applying. */}
        <FieldRow description={t("settings.logoModeDesc")} label={t("settings.logoMode")}>
          <Segmented
            label={t("settings.logoMode")}
            onChange={(mode) => void updateSettings({ "logo.mode": mode })}
            options={[
              { icon: "image", label: t("settings.logoModes.image"), value: "image" },
              { icon: "text", label: t("settings.logoModes.name"), value: "name" },
            ]}
            value={logoMode}
          />
        </FieldRow>
        {logoMode === "image" ? (
          <FieldRow description={t("settings.logoDesc")} help={t("settings.logoFormats")} label={t("settings.logo")}>
            <Button onClick={() => void changeLogo()} variant="outline">
              {t("settings.chooseFile")}
            </Button>
            {/* Asked first only when the logo IS the picture on the projector:
                removing it then turns the screen black in front of everybody,
                which is not what "removing a preference" looks like. With
                nothing on air it is a plain setting and gets no dialog. */}
            <Button disabled={logoPath === null} onClick={handleRemoveLogo} variant="ghost">
              {t("settings.logoRemove")}
            </Button>
          </FieldRow>
        ) : null}
        {/* The name and background in «name» mode, and ONE preview of what
            LOGO shows now (2026-11-05 review: an image box and a scene box
            were two previews of one button). */}
        <LogoSceneFields preview={preview} />
      </FieldGroup>
      <ConfirmModal
        confirmLabel={t("settings.logoRemove")}
        description={t("settings.logoRemoveLiveBody")}
        onConfirm={removeLogo}
        onOpenChange={setConfirmRemove}
        open={confirmRemove}
        title={t("settings.logoRemoveTitle")}
      />
    </>
  );
}
