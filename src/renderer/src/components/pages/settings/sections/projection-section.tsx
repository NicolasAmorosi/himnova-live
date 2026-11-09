import { useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Button, FieldGroup, FieldRow, Icon, Segmented, Select, Slider } from "@renderer/components/ui";
import { ConfirmModal } from "@renderer/components/shared/modal";
import { transitionDurationOptions, transitionStyleOptions } from "@renderer/lib/transition";
import { useDisplayStore } from "@renderer/stores/display.store";
import { selectOutputMemo, useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { clearLive } from "@renderer/lib/actions/playback";
import { api } from "@renderer/lib/api";
import { toast } from "@renderer/lib/toast";
import { IpcError } from "@shared/ipc/result";
import { logoModeOf } from "@shared/types/settings";
import type { TransitionStyle } from "@shared/types/transition";
import { LogoSceneFields } from "./logo-scene-fields";
import { VIDEO_END_ACTIONS, type VideoEndAction } from "@shared/types/projection";

/** Everything about what the projector shows: which screen, the fallback
 *  logo, and clearing whatever is currently live. */
export function ProjectionSection() {
  const t = useT();
  const { displayId, displays, setDisplayId } = useDisplayStore();
  const presentationOpen = useProjectionStore((s) => s.presentationOpen);
  const base = useProjectionStore((s) => s.base);
  // What the projector is showing right now, read the same way the LIVE
  // monitor reads it — the only honest way to know whether removing the logo
  // is about to blank a screen the congregation is looking at.
  const output = useProjectionStore(selectOutputMemo);
  const logoPath = useSettingsStore((s) => s.settings["logo.path"]);
  const logoMode = logoModeOf(useSettingsStore((s) => s.settings["logo.mode"]), logoPath);
  const stageDisplayId = useSettingsStore((s) => s.settings["stage.displayId"]);
  const transitionStyle = useSettingsStore((s) => s.settings["projection.transition.style"]);
  const transitionDurationMs = useSettingsStore((s) => s.settings["projection.transition.durationMs"]);
  const startVolume = useSettingsStore((s) => s.settings["media.volume"]);
  const videoEnd = useSettingsStore((s) => s.settings["projection.videoEnd"]);
  const deckEnd = useSettingsStore((s) => s.settings["projection.deckEnd"]);
  const updateSettings = useSettingsStore((s) => s.update);

  const logoOnAir = presentationOpen && output.kind === "logo";
  // Never the projector's screen: fullscreen and on top, the stage would cover
  // it — except the operator's own, where both are movable windows. A saved
  // choice off this list (the projector's now, or unplugged) reads «Ninguna»,
  // which is what is on (`chooseStageDisplay` in main); the setting stays, so
  // the stage comes back once the projector moves or the screen returns.
  const stageDisplays = displays.filter((d) => d.primary || d.id !== displayId);
  const stageValue = stageDisplays.some((d) => d.id === stageDisplayId) ? String(stageDisplayId) : "none";
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
    <div className="flex flex-col gap-8">
      <FieldGroup title={t("settings.groups.screen")}>
        <FieldRow description={t("settings.displayDesc")} label={t("settings.display")}>
          <Select
            onChange={(value) => void setDisplayId(Number(value))}
            options={displays.map((d) => ({
              label: `${d.label}${d.primary ? ` ${t("header.primaryDisplay")}` : ""}`,
              value: String(d.id),
            }))}
            value={displayId !== null ? String(displayId) : ""}
          />
        </FieldRow>
        <FieldRow description={t("settings.windowDesc")} label={t("settings.windowLabel")}>
          {presentationOpen ? (
            <Button onClick={() => void useDisplayStore.getState().close()} variant="outline">
              {t("header.closeDisplay")}
            </Button>
          ) : (
            // The same look as «Close» in the same place: Settings applies at
            // once and has no primary action (2026-11-04 review).
            <Button disabled={displayId === null} onClick={() => void useDisplayStore.getState().open()} variant="outline">
              {t("header.openDisplay")}
            </Button>
          )}
        </FieldRow>
        {/* Open whenever its screen is connected and is not the projector's; main places it (`stage-window.ts`). */}
        <FieldRow
          description={t("settings.stageDisplayDesc")}
          help={t("settings.stageDisplayHelp")}
          label={t("settings.stageDisplay")}
        >
          <Select
            onChange={(value) =>
              void useSettingsStore.getState().update({ "stage.displayId": value === "none" ? null : Number(value) })
            }
            options={[
              { label: t("settings.stageNone"), value: "none" },
              ...stageDisplays.map((d) => ({
                label: `${d.label}${d.primary ? ` ${t("header.primaryDisplay")}` : ""}`,
                value: String(d.id),
              })),
            ]}
            value={stageValue}
          />
        </FieldRow>
      </FieldGroup>

      <FieldGroup title={t("settings.groups.logo")}>
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
        <LogoSceneFields />
      </FieldGroup>

      <FieldGroup title={t("settings.groups.liveContent")}>
        <FieldRow description={t("settings.clearLiveDesc")} label={t("settings.clearLive")}>
          <Button disabled={base === null} onClick={clearLive} variant="outline">
            <Icon name="offAir" /> {t("live.takeOffAir")}
          </Button>
        </FieldRow>
        <FieldRow
          description={t("settings.videoEndDesc")}
          help={t("settings.videoEndHelp")}
          label={t("settings.videoEnd")}
        >
          <Select
            onChange={(value) => void updateSettings({ "projection.videoEnd": value as VideoEndAction })}
            options={VIDEO_END_ACTIONS.map((action) => ({ label: t(`settings.videoEndOptions.${action}`), value: action }))}
            value={videoEnd}
          />
        </FieldRow>
        <FieldRow
          description={t("settings.deckEndDesc")}
          help={t("settings.deckEndHelp")}
          label={t("settings.deckEnd")}
        >
          <Select
            onChange={(value) => void updateSettings({ "projection.deckEnd": value as VideoEndAction })}
            options={VIDEO_END_ACTIONS.map((action) => ({ label: t(`settings.deckEndOptions.${action}`), value: action }))}
            value={deckEnd}
          />
        </FieldRow>
        {/* With what goes live, not a group of one row (2026-11-05 review); a
            slider with its readout on the right, like every other one. */}
        <FieldRow
          description={t("settings.startVolumeDesc")}
          help={t("settings.startVolumeHelp")}
          label={t("settings.startVolume")}
        >
          <Slider
            format={(volume) => `${Math.round(volume * 100)}%`}
            label={t("settings.startVolume")}
            max={1}
            min={0}
            onChange={(volume) => void updateSettings({ "media.volume": Number(volume.toFixed(2)) })}
            step={0.05}
            value={startVolume}
          />
        </FieldRow>
      </FieldGroup>


      <ConfirmModal
        confirmLabel={t("settings.logoRemove")}
        description={t("settings.logoRemoveLiveBody")}
        onConfirm={removeLogo}
        onOpenChange={setConfirmRemove}
        open={confirmRemove}
        title={t("settings.logoRemoveTitle")}
      />

      <FieldGroup title={t("settings.groups.transition")}>
        <FieldRow description={t("settings.transitionStyleDesc")} label={t("settings.transitionStyle")}>
          <Select
            onChange={(value) => void updateSettings({ "projection.transition.style": value as TransitionStyle })}
            options={transitionStyleOptions(t)}
            value={transitionStyle}
          />
        </FieldRow>
        <FieldRow description={t("settings.transitionDurationDesc")} label={t("settings.transitionDuration")}>
          <Select
            disabled={transitionStyle === "none"}
            onChange={(value) => void updateSettings({ "projection.transition.durationMs": Number(value) })}
            options={transitionDurationOptions(t, transitionDurationMs)}
            value={String(transitionDurationMs)}
          />
        </FieldRow>
      </FieldGroup>
    </div>
  );
}
