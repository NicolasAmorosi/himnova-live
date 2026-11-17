import { useCallback, type ReactNode } from "react";
import { ChannelStrip, Menu, Tooltip } from "@renderer/components/ui";
import { useMuteToggle } from "@renderer/components/ui/use-mute-toggle";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { useAudioOutputPicker, useAudioOutputs } from "@renderer/lib/hooks/use-audio-outputs";
import { useAudioRouteStore } from "@renderer/stores/audio-route.store";
import { useAudioLevelsStore, type StereoLevel } from "@renderer/stores/audio-levels.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useUiStore } from "@renderer/stores/ui.store";
import type { AudioBus } from "@shared/types/audio";

/** Why the bus plays through the default instead of its chosen output, said on the strip. */
const FALLBACK = {
  missing: "audio.fallbackMissing",
  unusable: "audio.fallbackUnusable",
  pending: "audio.fallbackPending",
} as const;

/** Wide enough for «Predeterminada del sistema» and a USB interface's name beside the check. */
const OUTPUT_MENU_WIDTH_PX = 288;

/**
 * The audio strip beside a monitor (owner, 2026-11-15, sketch A): the same strip on PREVIEW and LIVE so the two
 * columns stay identical, shown only while `audio.strips` is on.
 *
 * - LIVE's fader is the master (`audio.live.volume`, remembered): everything that sounds live plays at its own level
 *   times this one (`busVolume`). Its mute is session state (`ui.store`), so the app never opens with LIVE silent;
 *   dragging the fader to 0 is that mute, and the remembered level stays. PREVIEW's IS PREVIEW's volume
 *   (`preview.store`), 0 with every new item.
 * - The output menu writes `audio.output.<bus>`. It turns amber when the chosen output is not used (not plugged in,
 *   one either side cannot open, or not yet named by the media engine: the bus plays through the default,
 *   `effects/audio-route.ts`), and PREVIEW's
 *   when both buses end up in the same device AND PREVIEW is audible (D6): then it is heard in the room, and in the
 *   NDI® when it is on. The tooltip says so whenever the outputs are shared.
 */
export function AudioStrip({ bus }: { bus: AudioBus }) {
  const t = useT();
  const live = bus === "live";
  const master = useSettingsStore((s) => s.settings["audio.live.volume"]);
  const previewVolume = usePreviewStore((s) => s.volume);
  const setPreviewVolume = usePreviewStore((s) => s.setVolume);
  const update = useSettingsStore((s) => s.update);
  const ndi = useSettingsStore((s) => s.settings["ndi.output.enabled"]);
  const liveMuted = useUiStore((s) => s.liveMuted);
  const setLiveMuted = useUiStore((s) => s.setLiveMuted);
  const toggleLiveMute = () => setLiveMuted(!liveMuted);
  const togglePreviewMute = useMuteToggle(previewVolume, setPreviewVolume);
  const outputs = useAudioOutputs();
  const picker = useAudioOutputPicker(bus, outputs);
  const shared = useAudioRouteStore((s) => !live && s.shared);
  const state = useAudioRouteStore((s) => s[bus].state);

  const subscribeLevels = useCallback(
    (listener: (level: StereoLevel) => void) =>
      useAudioLevelsStore.subscribe((s) => s.levels[bus], listener, { fireImmediately: true }),
    [bus],
  );

  const outputLabel = t(live ? "audio.liveOutput" : "audio.previewOutput");
  const fallback = state === "ok" ? null : t(FALLBACK[state]);
  const notice = fallback ?? (shared ? t(ndi ? "audio.sharedOutputNdi" : "audio.sharedOutput") : null);
  const warn = fallback !== null || (shared && previewVolume > 0);
  const outputName = t("audio.outputIs", { output: outputLabel, name: picker.name });
  const setMaster = (volume: number, from: number) => {
    // 0 is the mute, not a level to remember: a fade-out down to it leaves the level its gesture started from, which
    // is what unmuting — and the next launch — come back to. Keeping the last step before 0 left the room at −40 dB
    // (2026-11-15 audit, A8).
    setLiveMuted(volume === 0);
    const level = volume > 0 ? volume : from;
    if (level > 0) void update({ "audio.live.volume": Number(level.toFixed(2)) });
  };

  return (
    <ChannelStrip
      alarmWhenMuted={live}
      label={t(live ? "audio.liveStrip" : "audio.previewStrip")}
      muted={live ? liveMuted : previewVolume === 0}
      muteLabel={t(live ? "audio.liveMute" : "audio.previewMute")}
      onChange={live ? setMaster : setPreviewVolume}
      onToggleMute={live ? toggleLiveMute : togglePreviewMute}
      output={
        <Tooltip
          content={
            <>
              {outputName}
              {notice ? <span className="mt-1 block text-warning-ink">{notice}</span> : null}
            </>
          }
          floating
        >
          <Menu
            align="end"
            caret
            {...(warn ? { className: "text-warning-ink" } : {})}
            icon={live ? "speaker" : "headphones"}
            label={outputLabel}
            onSelect={picker.choose}
            options={picker.options}
            triggerLabel={notice ? `${outputName}. ${notice}` : outputName}
            value={picker.value}
            width={OUTPUT_MENU_WIDTH_PX}
          />
        </Tooltip>
      }
      subscribeLevels={subscribeLevels}
      value={live ? (liveMuted ? 0 : master) : previewVolume}
      volumeLabel={t(live ? "audio.liveVolume" : "audio.previewVolume")}
    />
  );
}

/** A monitor with its column's strip beside it, while the strips are on; just the monitor otherwise. PREVIEW's and
 *  LIVE's columns both go through here, so the two monitors stay the same size. */
export function MonitorWithStrip({ bus, children }: { bus: AudioBus; children: ReactNode }) {
  const strips = useSettingsStore((s) => s.settings["audio.strips"]);
  // The same tree with or without the strip: a different one remounts the monitor, and with it PREVIEW's video.
  return (
    <div className="flex shrink-0 gap-2">
      <div className="min-w-0 flex-1">{children}</div>
      {strips ? <AudioStrip bus={bus} /> : null}
    </div>
  );
}
