import { useCallback, type ReactNode } from "react";
import { ChannelStrip, Menu, Tooltip } from "@renderer/components/ui";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { sameAudioOutput, useAudioOutputPicker, useAudioOutputs } from "@renderer/lib/hooks/use-audio-outputs";
import { useAudioLevelsStore, type StereoLevel } from "@renderer/stores/audio-levels.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import type { AudioBus } from "@shared/types/audio";

/** Wide enough for «Predeterminada del sistema» and a USB interface's name beside the check. */
const OUTPUT_MENU_WIDTH_PX = 288;

/**
 * The audio strip beside a monitor (owner, 2026-11-15, sketch A): the same strip on PREVIEW and LIVE so the two
 * columns stay identical, shown only while `audio.strips` is on.
 *
 * - LIVE's fader is the master (`audio.live.volume`, remembered): everything that sounds live plays at its own level
 *   times this one (`busVolume`). PREVIEW's IS PREVIEW's volume (`preview.store`), 0 with every new item.
 * - The output menu writes `audio.output.<bus>`. PREVIEW's turns amber when both buses end up in the same device
 *   (D6): then PREVIEW is heard in the room, and in the NDI® when it is on.
 */
export function AudioStrip({ bus }: { bus: AudioBus }) {
  const t = useT();
  const live = bus === "live";
  const master = useSettingsStore((s) => s.settings["audio.live.volume"]);
  const previewVolume = usePreviewStore((s) => s.volume);
  const setPreviewVolume = usePreviewStore((s) => s.setVolume);
  const update = useSettingsStore((s) => s.update);
  const liveChoice = useSettingsStore((s) => s.settings["audio.output.live"]);
  const previewChoice = useSettingsStore((s) => s.settings["audio.output.preview"]);
  const ndi = useSettingsStore((s) => s.settings["ndi.output.enabled"]);
  const outputs = useAudioOutputs();
  const picker = useAudioOutputPicker(bus, outputs);
  const shared = !live && sameAudioOutput(liveChoice, previewChoice, outputs);

  const subscribeLevels = useCallback(
    (listener: (level: StereoLevel) => void) =>
      useAudioLevelsStore.subscribe((s) => s.levels[bus], listener, { fireImmediately: true }),
    [bus],
  );

  const outputLabel = t(live ? "audio.liveOutput" : "audio.previewOutput");
  const notice = shared ? t(ndi ? "audio.sharedOutputNdi" : "audio.sharedOutput") : null;

  return (
    <ChannelStrip
      alarmWhenMuted={live}
      label={t(live ? "audio.liveStrip" : "audio.previewStrip")}
      muteLabel={t("media.mute")}
      onChange={live ? (volume) => void update({ "audio.live.volume": Number(volume.toFixed(2)) }) : setPreviewVolume}
      output={
        <Tooltip
          content={
            <>
              {t("audio.outputIs", { output: outputLabel, name: picker.name })}
              {notice ? <span className="mt-1 block text-warning-ink">{notice}</span> : null}
            </>
          }
          floating
        >
          <Menu
            align="end"
            caret
            {...(shared ? { className: "text-warning-ink" } : {})}
            icon={live ? "speaker" : "headphones"}
            label={outputLabel}
            onSelect={picker.choose}
            options={picker.options}
            value={picker.value}
            width={OUTPUT_MENU_WIDTH_PX}
          />
        </Tooltip>
      }
      subscribeLevels={subscribeLevels}
      unmuteLabel={t("media.unmute")}
      value={live ? master : previewVolume}
      volumeLabel={t(live ? "audio.liveVolume" : "audio.previewVolume")}
    />
  );
}

/** A monitor with its column's strip beside it, while the strips are on; just the monitor otherwise. PREVIEW's and
 *  LIVE's columns both go through here, so the two monitors stay the same size. */
export function MonitorWithStrip({ bus, children }: { bus: AudioBus; children: ReactNode }) {
  const strips = useSettingsStore((s) => s.settings["audio.strips"]);
  if (!strips) return children;
  return (
    <div className="flex shrink-0 gap-2">
      <div className="min-w-0 flex-1">{children}</div>
      <AudioStrip bus={bus} />
    </div>
  );
}
