import { startAudioLevels } from "@renderer/effects/audio-levels";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { liveMasterVolume } from "@shared/types/audio";
import { logoLook, type SettingsMap } from "@shared/types/settings";

type Mirror = readonly [keys: readonly (keyof SettingsMap)[], apply: (settings: SettingsMap) => void];

/**
 * Mirrors the settings `selectOutput` depends on into `projection.store`, which it reads instead of settings so the
 * projection window's input stays one self-contained value. Edited in Settings, each reaches the projector in place:
 * the logo, the verse's look, a model slide's text, without a scene transition (nothing here touches `sceneEpoch`).
 *
 * Outside React: `App` subscribed to every one of them only to mirror it, so each step of LIVE's fader rendered the
 * whole control window again (2026-11-15 audit, R16). Each mirror runs only when one of its own keys changes:
 * `logoLook` and `setSlideText` build new objects, and a new one on every fader step is a new output.
 */
export function startSettingsMirror(): () => void {
  const projection = () => useProjectionStore.getState();
  let stopLevels: (() => void) | undefined;
  const mirrors: readonly Mirror[] = [
    [
      ["logo.path", "logo.mode", "logo.name", "logo.background"],
      (settings) => {
        const look = logoLook(settings);
        projection().setLogoUrl(look.url);
        projection().setLogoScene(look.scene);
      },
    ],
    [
      ["projection.transition.style", "projection.transition.durationMs"],
      (settings) =>
        projection().setTransitionSettings(
          settings["projection.transition.style"],
          settings["projection.transition.durationMs"],
        ),
    ],
    // What a video does at its end: `loop` travels in the output, the rest is `end-of-playback.ts`'s. Changed while a
    // video plays, it applies to that one.
    [["projection.videoEnd"], (settings) => projection().setVideoEnd(settings["projection.videoEnd"])],
    // Measuring only while the strips are on: nothing is listened to, sent or crossed to main otherwise. The projector
    // learns it through its output.
    [
      ["audio.strips"],
      (settings) => {
        stopLevels?.();
        stopLevels = settings["audio.strips"] ? startAudioLevels() : undefined;
        projection().setLiveMeters(settings["audio.strips"]);
      },
    ],
    // The LIVE strip's fader (100 % with the strips off): it multiplies every live level.
    [
      ["audio.strips", "audio.live.volume", "audio.live.muted"],
      (settings) =>
        projection().setLiveMasterVolume(
          liveMasterVolume(settings["audio.strips"], settings["audio.live.volume"], settings["audio.live.muted"]),
        ),
    ],
    [["bible.style"], (settings) => projection().setBibleStyle(settings["bible.style"])],
    // What a model slide leaves to the machine: the face for a missing font, the language of chart numbers.
    [
      ["slides.fallbackFont", "ui.locale"],
      (settings) => projection().setSlideText({ fallbackFont: settings["slides.fallbackFont"], locale: settings["ui.locale"] }),
    ],
  ];

  const apply = (settings: SettingsMap, previous: SettingsMap | null) => {
    for (const [keys, mirror] of mirrors) {
      if (previous === null || keys.some((key) => settings[key] !== previous[key])) mirror(settings);
    }
  };
  // At once too: a page started again over what is live has its settings already, and no change will come.
  apply(useSettingsStore.getState().settings, null);
  const unsubscribe = useSettingsStore.subscribe((state, previous) => {
    if (state.settings !== previous.settings) apply(state.settings, previous.settings);
  });
  return () => {
    unsubscribe();
    stopLevels?.();
  };
}
