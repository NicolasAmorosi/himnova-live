import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Caption, ChannelStrip, Icon, Monitor, VolumeControl } from "@renderer/components/ui";
import { OutputView } from "@renderer/components/shared/output-view";
import { AudioOutputsGroup, StripsGroup } from "@renderer/components/shared/settings-groups/sound-groups";
import { useSettingsStore } from "@renderer/stores/settings.store";
import type { AudioBus } from "@shared/types/audio";
import type { ProjectionOutput } from "@shared/types/projection";
import { StepLayout } from "./StepLayout";
import { useSampleVerses } from "./use-sample-verses";

/** How often the demo's meter is fed: the media engine's own pace (≤ 40 ms). */
const DEMO_LEVEL_MS = 40;

/**
 * «Sonido», the same step in the welcome and in «Novedades»: the strips' switch (on unless turned off, D5: on is the
 * default) and where each bus sounds, Settings ▸ Sound's own groups; beside them, what the switch changes on the work
 * screen.
 */
export function SoundStep() {
  const t = useT();
  return (
    <StepLayout aside={<SoundDemo />} subtitle={t("welcome.sound.subtitle")} title={t("welcome.sound.title")}>
      <StripsGroup essentials />
      <AudioOutputsGroup essentials />
    </StepLayout>
  );
}

/**
 * The work screen's two monitors in small, PREVIEW over LIVE, each with its strip while the switch is on, or with the
 * row volume it brings back while it is off.
 */
function SoundDemo() {
  const t = useT();
  const strips = useSettingsStore((s) => s.settings["audio.strips"]);
  const [live, next] = useSampleVerses();
  return (
    <>
      <Caption>{t("welcome.sound.demo")}</Caption>
      <DemoMonitor bus="preview" output={next} strips={strips} />
      <DemoMonitor bus="live" output={live} strips={strips} />
      <p className="text-xs text-muted-foreground">{t(strips ? "welcome.sound.demoHint" : "welcome.sound.demoOffHint")}</p>
    </>
  );
}

/** Where each bus's made-up song sits and starts, in dBFS and on its fader: LIVE louder, PREVIEW a quieter listen. */
const DEMO_BUS = {
  live: { level: -21, volume: 0.8, icon: "speaker", title: "live.title" },
  preview: { level: -27, volume: 0.6, icon: "headphones", title: "slides.title" },
} as const;

/**
 * One monitor and a strip that moves without anything sounding: gentle made-up levels (a song that now and then
 * reaches the amber), times its own fader. It never writes the real meters' store nor any setting.
 */
function DemoMonitor({ bus, output, strips }: { bus: AudioBus; output: ProjectionOutput; strips: boolean }) {
  const t = useT();
  const { icon, level, title } = DEMO_BUS[bus];
  const name = t(title);
  const [volume, setVolume] = useState<number>(DEMO_BUS[bus].volume);
  const volumeRef = useRef(volume);
  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  const subscribe = useCallback(
    (listener: (level: readonly [number, number]) => void) => {
      let phase = Math.random() * 10;
      const timer = setInterval(() => {
        phase += DEMO_LEVEL_MS / 1000;
        const song = level + 4 * Math.sin(phase * 1.7) + 3 * Math.sin(phase * 4.3) + 2 * Math.random();
        const gain = volumeRef.current > 0 ? 20 * Math.log10(volumeRef.current) : -Infinity;
        listener([song + gain, song - 1 + 1.5 * Math.sin(phase * 2.9) + gain]);
      }, DEMO_LEVEL_MS);
      return () => clearInterval(timer);
    },
    [level],
  );

  return (
    <div className="flex flex-col gap-1.5">
      <Caption className="font-normal">{name}</Caption>
      <div className="flex gap-2">
        <Monitor className="min-w-0 flex-1 p-0" onAir={bus === "live"}>
          <OutputView mode="preview" output={output} />
        </Monitor>
        {strips ? (
          <ChannelStrip
            alarmWhenMuted={bus === "live"}
            label={t("welcome.sound.demoStrip", { bus: name })}
            muteLabel={t("media.mute")}
            onChange={setVolume}
            output={
              <span className="flex size-7 items-center justify-center text-muted-foreground">
                <Icon name={icon} />
              </span>
            }
            subscribeLevels={subscribe}
            unmuteLabel={t("media.unmute")}
            value={volume}
            volumeLabel={t("welcome.sound.demoVolume", { bus: name })}
          />
        ) : null}
      </div>
      {strips ? null : (
        <VolumeControl
          label={t("welcome.sound.demoVolume", { bus: name })}
          muteLabel={t("media.mute")}
          onChange={setVolume}
          value={volume}
        />
      )}
    </div>
  );
}
