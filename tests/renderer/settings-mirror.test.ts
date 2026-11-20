/**
 * The settings `selectOutput` depends on, mirrored into `projection.store` outside React (`effects/settings-mirror.ts`):
 * `App` subscribed to each of them, so every step of LIVE's fader rendered the whole control window again (2026-11-15
 * audit, R16). Each mirror runs only for its own keys: with a verse live, the fader moves no output at all.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS, type SettingsMap } from "@shared/types/settings";

const h = vi.hoisted(() => ({ stopLevels: vi.fn(), startLevels: vi.fn() }));
vi.mock("@renderer/effects/audio-levels", () => ({ startAudioLevels: h.startLevels }));

const { startSettingsMirror } = await import("@renderer/effects/settings-mirror");
const { selectOutputMemo, useProjectionStore } = await import("@renderer/stores/projection.store");
const { useSettingsStore } = await import("@renderer/stores/settings.store");

const initialProjection = useProjectionStore.getState();
const change = (partial: Partial<SettingsMap>) =>
  useSettingsStore.setState((state) => ({ settings: { ...state.settings, ...partial } }));
let stop: () => void = () => undefined;

beforeEach(() => {
  h.startLevels.mockReset().mockReturnValue(h.stopLevels);
  h.stopLevels.mockReset();
  useProjectionStore.setState(initialProjection, true);
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, "audio.strips": true, "audio.live.volume": 0.8 }, loaded: true });
});

afterEach(() => stop());

test("applied at once, then followed: the master, the meters and their measuring", () => {
  stop = startSettingsMirror();
  expect(useProjectionStore.getState()).toMatchObject({ liveMasterVolume: 0.8, liveMeters: true });
  expect(h.startLevels).toHaveBeenCalledOnce();

  change({ "audio.live.muted": true });
  expect(useProjectionStore.getState().liveMasterVolume).toBe(0);
  change({ "audio.strips": false });
  expect(useProjectionStore.getState()).toMatchObject({ liveMasterVolume: 1, liveMeters: false });
  expect(h.stopLevels).toHaveBeenCalledOnce();
  expect(h.startLevels).toHaveBeenCalledOnce();

  stop();
  change({ "audio.strips": true });
  expect(useProjectionStore.getState().liveMeters).toBe(false);
});

test("with a verse live, a step of LIVE's fader is not a new output", () => {
  stop = startSettingsMirror();
  useProjectionStore.getState().setBase({ kind: "bible", text: "Jesús lloró.", reference: "Juan 11:35", versionLabel: null });
  const before = selectOutputMemo(useProjectionStore.getState());
  change({ "audio.live.volume": 0.5 });
  expect(useProjectionStore.getState().liveMasterVolume).toBe(0.5);
  expect(selectOutputMemo(useProjectionStore.getState())).toBe(before);
});

test("a setting of its own reaches the projector in place; anyone else's mirrors nothing", () => {
  stop = startSettingsMirror();
  const { logoScene, slideText, bibleStyle } = useProjectionStore.getState();
  change({ "stage.layout": "preacher", "audio.live.volume": 0.3 });
  expect(useProjectionStore.getState()).toMatchObject({ liveMasterVolume: 0.3 });
  expect(useProjectionStore.getState().logoScene).toBe(logoScene);
  expect(useProjectionStore.getState().slideText).toBe(slideText);

  change({ "ui.locale": "en", "bible.style": { ...bibleStyle, lineHeight: 1.3 } });
  expect(useProjectionStore.getState().slideText).toEqual({ fallbackFont: DEFAULT_SETTINGS["slides.fallbackFont"], locale: "en" });
  expect(useProjectionStore.getState().bibleStyle).toMatchObject({ lineHeight: 1.3 });
});
