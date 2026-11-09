import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Button, FieldGroup, FieldRow, Icon, Select, Slider } from "@renderer/components/ui";
import { LogoGroup } from "@renderer/components/shared/settings-groups/logo-group";
import { NdiOutputGroup } from "@renderer/components/shared/settings-groups/ndi-output-group";
import { ScreenGroup } from "@renderer/components/shared/settings-groups/screen-group";
import { transitionDurationOptions, transitionStyleOptions } from "@renderer/lib/transition";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { clearLive } from "@renderer/lib/actions/playback";
import type { TransitionStyle } from "@shared/types/transition";
import {
  AUDIO_END_ACTIONS,
  VIDEO_END_ACTIONS,
  type AudioEndAction,
  type VideoEndAction,
} from "@shared/types/projection";

/** Everything about what the projector shows: which screen, the fallback
 *  logo, and clearing whatever is currently live. */
export function ProjectionSection() {
  const t = useT();
  const base = useProjectionStore((s) => s.base);
  const transitionStyle = useSettingsStore((s) => s.settings["projection.transition.style"]);
  const transitionDurationMs = useSettingsStore((s) => s.settings["projection.transition.durationMs"]);
  const startVolume = useSettingsStore((s) => s.settings["media.volume"]);
  const videoEnd = useSettingsStore((s) => s.settings["projection.videoEnd"]);
  const deckEnd = useSettingsStore((s) => s.settings["projection.deckEnd"]);
  const songEnd = useSettingsStore((s) => s.settings["projection.songEnd"]);
  const audioEnd = useSettingsStore((s) => s.settings["projection.audioEnd"]);
  const updateSettings = useSettingsStore((s) => s.update);

  return (
    <div className="flex flex-col gap-8">
      <ScreenGroup />

      <NdiOutputGroup />

      <LogoGroup />

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
