import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Button, FieldGroup, FieldRow, Icon, Select, Switch } from "@renderer/components/ui";
import { LogoGroup } from "@renderer/components/shared/settings-groups/logo-group";
import { transitionDurationOptions, transitionStyleOptions } from "@renderer/lib/transition";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useDisplayStore } from "@renderer/stores/display.store";
import { useUiStore } from "@renderer/stores/ui.store";
import { screenLabel } from "@renderer/lib/screen-label";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { clearLive } from "@renderer/lib/actions/playback";
import type { TransitionStyle } from "@shared/types/transition";
import {
  AUDIO_END_ACTIONS,
  VIDEO_END_ACTIONS,
  type AudioEndAction,
  type VideoEndAction,
} from "@shared/types/projection";

/** Which screen the projector is on, read only: choosing it, its fit and its resolution are Settings ▸ Screens',
 *  where the button goes. Whoever looks for «the projector» here finds it (owner, 2026-11-25). */
function ProjectorScreenGroup() {
  const t = useT();
  const displays = useDisplayStore((s) => s.displays);
  const projectorId = useDisplayStore((s) => s.displayId);
  const openSettings = useUiStore((s) => s.openSettings);
  const index = displays.findIndex((d) => d.id === projectorId);
  const projector = displays[index];
  return (
    <FieldGroup title={t("settings.groups.projector")}>
      <FieldRow
        description={
          projector && !projector.operator ? `${index + 1} · ${screenLabel(projector, t)}` : t("welcome.done.noProjector")
        }
        label={t("settings.screens.projectorScreen")}
      >
        <Button onClick={() => openSettings("screens")} variant="outline">
          <Icon name="columns" /> {t("settings.screens.goToScreens")}
        </Button>
      </FieldRow>
    </FieldGroup>
  );
}

/** Everything about what the projector shows: the fallback logo, what happens live and at an end, the transition.
 *  Which screen is Settings ▸ Screens'; the NDI® output, Settings ▸ Streaming's. */
export function ProjectionSection() {
  const t = useT();
  const base = useProjectionStore((s) => s.base);
  const transitionStyle = useSettingsStore((s) => s.settings["projection.transition.style"]);
  const transitionDurationMs = useSettingsStore((s) => s.settings["projection.transition.durationMs"]);
  const videoEnd = useSettingsStore((s) => s.settings["projection.videoEnd"]);
  const deckEnd = useSettingsStore((s) => s.settings["projection.deckEnd"]);
  const songEnd = useSettingsStore((s) => s.settings["projection.songEnd"]);
  const audioEnd = useSettingsStore((s) => s.settings["projection.audioEnd"]);
  const previewNext = useSettingsStore((s) => s.settings["projection.previewNext"]);
  const updateSettings = useSettingsStore((s) => s.update);

  return (
    <div className="flex flex-col gap-8">
      <ProjectorScreenGroup />

      <LogoGroup />

      <FieldGroup title={t("settings.groups.liveContent")}>
        <FieldRow description={t("settings.clearLiveDesc")} label={t("settings.clearLive")}>
          <Button disabled={base === null} onClick={clearLive} variant="outline">
            <Icon name="offAir" /> {t("live.takeOffAir")}
          </Button>
        </FieldRow>
        <FieldRow description={t("settings.previewNextDesc")} label={t("settings.previewNext")}>
          <Switch
            checked={previewNext}
            onChange={(e) => void updateSettings({ "projection.previewNext": e.target.checked })}
          />
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
        <FieldRow
          description={t("settings.songEndDesc")}
          help={t("settings.songEndHelp")}
          label={t("settings.songEnd")}
        >
          <Select
            onChange={(value) => void updateSettings({ "projection.songEnd": value as VideoEndAction })}
            options={VIDEO_END_ACTIONS.map((action) => ({ label: t(`settings.deckEndOptions.${action}`), value: action }))}
            value={songEnd}
          />
        </FieldRow>
        <FieldRow
          description={t("settings.audioEndDesc")}
          help={t("settings.audioEndHelp")}
          label={t("settings.audioEnd")}
        >
          <Select
            onChange={(value) => void updateSettings({ "projection.audioEnd": value as AudioEndAction })}
            options={AUDIO_END_ACTIONS.map((action) => ({ label: t(`settings.audioEndOptions.${action}`), value: action }))}
            value={audioEnd}
          />
        </FieldRow>
      </FieldGroup>


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
