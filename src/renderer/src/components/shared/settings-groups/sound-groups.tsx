import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Caption, FieldGroup, FieldRow, Select, Slider, Switch } from "@renderer/components/ui";
import { useAudioOutputPicker, useAudioOutputs, type AudioOutputs } from "@renderer/lib/hooks/use-audio-outputs";
import { useSettingsStore } from "@renderer/stores/settings.store";
import type { AudioBus } from "@shared/types/audio";

/**
 * Settings ▸ Sound ▸ «Tiras de sonido»: the strips' switch and the level what goes live starts at. `essentials` (the
 * welcome and «Novedades»): the switch only.
 */
export function StripsGroup({ essentials = false }: { essentials?: boolean }) {
  const t = useT();
  const strips = useSettingsStore((s) => s.settings["audio.strips"]);
  const startVolume = useSettingsStore((s) => s.settings["media.volume"]);
  const update = useSettingsStore((s) => s.update);
  return (
    <FieldGroup title={t("settings.groups.strips")}>
      <FieldRow description={t("settings.sound.stripsDesc")} help={t("settings.sound.stripsHelp")} label={t("settings.sound.strips")}>
        <Switch
          aria-label={t("settings.sound.strips")}
          checked={strips}
          onChange={(e) => void update({ "audio.strips": e.target.checked })}
        />
      </FieldRow>
      {essentials ? null : (
        <FieldRow description={t("settings.startVolumeDesc")} help={t("settings.startVolumeHelp")} label={t("settings.startVolume")}>
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
      )}
    </FieldGroup>
  );
}

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

/**
 * Settings ▸ Sound ▸ «Salidas»: where each bus sounds. They apply with the strips off too (D3). `essentials`: the NDI®
 * note only to whoever has the output on.
 */
export function AudioOutputsGroup({ essentials = false }: { essentials?: boolean }) {
  const t = useT();
  const outputs = useAudioOutputs();
  const ndi = useSettingsStore((s) => s.settings["ndi.output.enabled"]);
  return (
    <FieldGroup title={t("settings.groups.outputs")}>
      <OutputRow bus="live" outputs={outputs} />
      <OutputRow bus="preview" outputs={outputs} />
      {!essentials || ndi ? <Caption className="block px-4 py-3">{t("settings.sound.ndiNote")}</Caption> : null}
    </FieldGroup>
  );
}
