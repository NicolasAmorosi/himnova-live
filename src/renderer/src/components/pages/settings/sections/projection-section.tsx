import { useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Box, Button, FieldGroup, FieldRow, Icon, Select, Tooltip, VolumeControl } from "@renderer/components/ui";
import { ConfirmModal } from "@renderer/components/shared/modal";
import { transitionDurationOptions, transitionStyleOptions } from "@renderer/lib/transition";
import { useDisplayStore } from "@renderer/stores/display.store";
import { selectOutputMemo, useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { clearLive } from "@renderer/lib/actions/playback";
import { api } from "@renderer/lib/api";
import { toast } from "@renderer/lib/toast";
import { IpcError } from "@shared/ipc/result";
import { LOGO_URL } from "@shared/urls";
import type { TransitionStyle } from "@shared/types/transition";

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
  const stageDisplayId = useSettingsStore((s) => s.settings["stage.displayId"]);
  const transitionStyle = useSettingsStore((s) => s.settings["projection.transition.style"]);
  const transitionDurationMs = useSettingsStore((s) => s.settings["projection.transition.durationMs"]);
  const startVolume = useSettingsStore((s) => s.settings["media.volume"]);
  const updateSettings = useSettingsStore((s) => s.update);

  // The URL carries the logo's own path as a cache-buster: it's the same
  // "worship://logo" host for every logo, so without something in the URL
  // that actually changes when the file changes, the <img> keeps showing the
  // previous image after picking a new one (React sees an unchanged `src`
  // and never re-fetches).
  const logoUrl = logoPath ? `${LOGO_URL}?p=${encodeURIComponent(logoPath)}` : null;
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
    <div className="flex flex-col gap-6">
      <FieldGroup title={t("settings.groups.screen")}>
        <FieldRow description={t("settings.displayDesc")} label={t("settings.display")}>
          <Select
            className="min-w-56"
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
        {/* Open whenever its screen is connected; main places it (`stage-window.ts`). */}
        <FieldRow description={t("settings.stageDisplayDesc")} label={t("settings.stageDisplay")}>
          <Select
            className="min-w-56"
            onChange={(value) =>
              void useSettingsStore.getState().update({ "stage.displayId": value === "none" ? null : Number(value) })
            }
            options={[
              { label: t("settings.stageNone"), value: "none" },
              ...displays.map((d) => ({
                label: `${d.label}${d.primary ? ` ${t("header.primaryDisplay")}` : ""}`,
                value: String(d.id),
              })),
            ]}
            value={stageDisplayId !== null ? String(stageDisplayId) : "none"}
          />
        </FieldRow>
      </FieldGroup>

      <FieldGroup title={t("settings.groups.logo")}>
        <FieldRow description={t("settings.logoDesc")} label={t("settings.logo")}>
          <Tooltip content={t("settings.logoFormats")} floating>
            <Icon className="text-subtle" name="help" />
          </Tooltip>
          <Button onClick={() => void changeLogo()} variant="outline">
            {t("settings.chooseFile")}
          </Button>
          {/* Asked first only when the logo IS the picture on the projector:
              removing it then turns the screen black in front of everybody,
              which is not what "removing a preference" looks like. With
              nothing on air it is a plain setting and gets no dialog. */}
          <Button
            disabled={logoPath === null}
            onClick={handleRemoveLogo}
            variant="outline"
          >
            <Icon name="close" /> {t("settings.logoRemove")}
          </Button>
        </FieldRow>
        {/* The projector's own proportion, small — the empty 704×256 slab it
            was took the page over (2026-11-04 review). */}
        <div className="py-3">
          <Box className="flex aspect-video w-full max-w-sm flex-col items-center justify-center gap-2 overflow-hidden px-4">
          {logoUrl ? (
            <img alt="" className="h-full max-w-full object-contain" src={logoUrl} />
          ) : (
            <>
              <Icon className="text-subtle" name="image" />
              <span className="text-xs text-subtle">{t("settings.logoEmpty")}</span>
            </>
          )}
          </Box>
        </div>
      </FieldGroup>

      <FieldGroup title={t("settings.groups.liveContent")}>
        <FieldRow description={t("settings.clearLiveDesc")} label={t("settings.clearLive")}>
          <Button disabled={base === null} onClick={clearLive} variant="outline">
            <Icon name="offAir" /> {t("live.takeOffAir")}
          </Button>
        </FieldRow>
      </FieldGroup>

      <FieldGroup title={t("settings.groups.audio")}>
        <FieldRow description={t("settings.startVolumeDesc")} label={t("settings.startVolume")}>
          <span className="w-10 text-right text-sm tabular-nums text-muted-foreground">
            {Math.round(startVolume * 100)}%
          </span>
          <VolumeControl
            label={t("settings.startVolume")}
            muteLabel={startVolume === 0 ? t("media.unmute") : t("media.mute")}
            onChange={(volume) => void updateSettings({ "media.volume": volume })}
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
            className="min-w-48"
            onChange={(value) => void updateSettings({ "projection.transition.style": value as TransitionStyle })}
            options={transitionStyleOptions(t)}
            value={transitionStyle}
          />
        </FieldRow>
        <FieldRow description={t("settings.transitionDurationDesc")} label={t("settings.transitionDuration")}>
          <Select
            className="min-w-40"
            disabled={transitionStyle === "none"}
            onChange={(value) => void updateSettings({ "projection.transition.durationMs": Number(value) })}
            options={transitionDurationOptions(t)}
            value={String(transitionDurationMs)}
          />
        </FieldRow>
      </FieldGroup>
    </div>
  );
}
