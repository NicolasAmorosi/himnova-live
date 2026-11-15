import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Caption, FieldGroup, FieldRow, Select, Slider, Switch } from "@renderer/components/ui";
import { useAudioOutputPicker, useAudioOutputs, type AudioOutputs } from "@renderer/lib/hooks/use-audio-outputs";
import { useSettingsStore } from "@renderer/stores/settings.store";
import type { AudioBus } from "@shared/types/audio";

/** One bus's output, the same choices as its strip's menu. */
function OutputRow({ bus, outputs }: { bus: AudioBus; outputs: AudioOutputs }) {
  const t = useT();
  const picker = useAudioOutputPicker(bus, outputs);
  return (
    <FieldRow
      description={t(bus === "live" ? "settings.sound.liveOutputDesc" : "settings.sound.previewOutputDesc")}
      label={t(bus === "live" ? "audio.liveOutput" : "audio.previewOutput")}
    >
      <Select onChange={picker.choose} options={picker.options} value={picker.value} />
    </FieldRow>
  );
}

/** Settings ▸ Sound (owner, 2026-11-15): the audio strips, where each bus sounds, and the level what goes live
 *  starts at (it was in Projection). The outputs apply with the strips off too (D3). */
export function SoundSection() {
  const t = useT();
  const strips = useSettingsStore((s) => s.settings["audio.strips"]);
  const startVolume = useSettingsStore((s) => s.settings["media.volume"]);
  const update = useSettingsStore((s) => s.update);
  const outputs = useAudioOutputs();

  return (
    <div className="flex flex-col gap-8">
      <FieldGroup title={t("settings.groups.strips")}>
        <FieldRow
          description={t("settings.sound.stripsDesc")}
          help={t("settings.sound.stripsHelp")}
          label={t("settings.sound.strips")}
        >
          <Switch
            aria-label={t("settings.sound.strips")}
            checked={strips}
            onChange={(e) => void update({ "audio.strips": e.target.checked })}
          />
        </FieldRow>
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
            onChange={(volume) => void update({ "media.volume": Number(volume.toFixed(2)) })}
            step={0.05}
            value={startVolume}
          />
        </FieldRow>
      </FieldGroup>

      <FieldGroup title={t("settings.groups.outputs")}>
        <OutputRow bus="live" outputs={outputs} />
        <OutputRow bus="preview" outputs={outputs} />
        <Caption className="block px-4 py-3">{t("settings.sound.ndiNote")}</Caption>
      </FieldGroup>
    </div>
  );
}
