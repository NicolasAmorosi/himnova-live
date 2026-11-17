/**
 * The strips' switch (`lib/actions/audio-strips.ts`). Turned on, a «Volumen inicial» under 100 % was a ceiling the
 * strip neither showed nor let pass: LIVE's fader at 100 % still played every item at it (2026-11-15 audit, U5). It
 * becomes LIVE's master instead, and goes back to 100 % (owner): the room keeps its level, and the strip shows it.
 */
import { beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS, type SettingsMap } from "@shared/types/settings";

const h = vi.hoisted(() => ({ set: vi.fn<(partial: Partial<SettingsMap>) => Promise<void>>(() => Promise.resolve()) }));
vi.mock("@renderer/lib/api", () => ({ api: { settings: { set: h.set } } }));

const { setAudioStrips } = await import("@renderer/lib/actions/audio-strips");
const { useSettingsStore } = await import("@renderer/stores/settings.store");
const { useToastStore } = await import("@renderer/stores/toast.store");

const levels = () => {
  const { settings } = useSettingsStore.getState();
  return { strips: settings["audio.strips"], master: settings["audio.live.volume"], start: settings["media.volume"] };
};
const start = (settings: Partial<SettingsMap>) =>
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...settings }, loaded: true });

beforeEach(() => {
  h.set.mockClear();
  useToastStore.setState({ toasts: [] });
});

test("turned on, a starting volume under 100 % becomes LIVE's master, in one write", async () => {
  start({ "audio.strips": false, "media.volume": 0.5, "audio.live.volume": 1 });
  await setAudioStrips(true);
  expect(levels()).toEqual({ strips: true, master: 0.5, start: 1 });
  expect(h.set.mock.calls).toEqual([[{ "audio.strips": true, "audio.live.volume": 0.5, "media.volume": 1 }]]);
  expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
    "Tiras prendidas: el volumen inicial (50 %) pasa a ser el volumen general de EN VIVO.",
  ]);
});

test("at 100 %, at 0, or with the strips already on, only the switch moves", async () => {
  start({ "audio.strips": false, "media.volume": 1, "audio.live.volume": 0.7 });
  await setAudioStrips(true);
  expect(levels()).toEqual({ strips: true, master: 0.7, start: 1 });

  start({ "audio.strips": false, "media.volume": 0, "audio.live.volume": 0.7 });
  await setAudioStrips(true);
  expect(levels()).toEqual({ strips: true, master: 0.7, start: 0 });

  start({ "audio.strips": true, "media.volume": 0.5, "audio.live.volume": 0.7 });
  await setAudioStrips(true);
  expect(levels()).toEqual({ strips: true, master: 0.7, start: 0.5 });
  expect(useToastStore.getState().toasts).toEqual([]);
});

test("turned off with the starting volume at 100 %, LIVE's master goes back to being it: off, LIVE ignores its master", async () => {
  // Off then played every item at 100 %: the room's 50 % was gone (review of U5).
  start({ "audio.strips": true, "media.volume": 1, "audio.live.volume": 0.5 });
  await setAudioStrips(false);
  expect(levels()).toEqual({ strips: false, master: 1, start: 0.5 });
  expect(h.set.mock.calls).toEqual([[{ "audio.strips": false, "media.volume": 0.5, "audio.live.volume": 1 }]]);
  expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
    "Tiras apagadas: el volumen general de EN VIVO (50 %) pasa a ser el volumen inicial.",
  ]);
  // On and off again: the same level both ways.
  await setAudioStrips(true);
  expect(levels()).toEqual({ strips: true, master: 0.5, start: 1 });

  // A starting volume already set, or a master at 100 % or 0: only the switch moves.
  for (const [master, startAt] of [[0.5, 0.8], [1, 1], [0, 1]] as const) {
    start({ "audio.strips": true, "media.volume": startAt, "audio.live.volume": master });
    await setAudioStrips(false);
    expect(levels()).toEqual({ strips: false, master, start: startAt });
  }
});

test("with something sounding on the air, the notice says it changes too: the switch moves only the starting volume", async () => {
  // Turning the strips off, what is live goes back to 100 % (LIVE ignores its master), and the notice spoke only of the
  // starting volume (owner, 2026-11-16: keep the round trip, say it). On, what is live plays under the new master.
  const { useAudioStore } = await import("@renderer/stores/audio.store");
  const { useProjectionStore } = await import("@renderer/stores/projection.store");
  useProjectionStore.setState({ presentationOpen: true });
  useAudioStore.setState({
    tracks: [
      { trackId: "a", source: "asset", assetId: 1, label: "Preludio", url: "u", epoch: 1, paused: false, startAtSeconds: 0, volume: 1, loop: false },
    ],
  });
  try {
    start({ "audio.strips": true, "media.volume": 1, "audio.live.volume": 0.5 });
    await setAudioStrips(false);
    start({ "audio.strips": false, "media.volume": 0.5, "audio.live.volume": 1 });
    await setAudioStrips(true);
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      "Tiras apagadas: el volumen general de EN VIVO (50 %) pasa a ser el volumen inicial, y lo que ya está al aire vuelve al 100 %.",
      "Tiras prendidas: el volumen inicial (50 %) pasa a ser el volumen general de EN VIVO, y lo que ya está al aire suena más bajo.",
    ]);
  } finally {
    useAudioStore.setState({ tracks: [] });
    useProjectionStore.setState({ presentationOpen: false });
  }
});

test("a verse on air after a deck with a clip is no sound: the plain notice", async () => {
  // `liveDeck` outlives its deck: the notice said what was live changed level over a silent verse (review of
  // 2026-11-16).
  const { useAudioStore } = await import("@renderer/stores/audio.store");
  const { useProjectionStore } = await import("@renderer/stores/projection.store");
  useAudioStore.setState({ tracks: [] });
  useProjectionStore.setState({
    presentationOpen: true,
    base: { kind: "bible", text: "…", reference: "Juan 3:16", versionLabel: null },
    liveDeck: { videos: [{ slideIndex: 1 }] } as never,
  });
  try {
    start({ "audio.strips": false, "media.volume": 0.5, "audio.live.volume": 1 });
    await setAudioStrips(true);
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      "Tiras prendidas: el volumen inicial (50 %) pasa a ser el volumen general de EN VIVO.",
    ]);
  } finally {
    useProjectionStore.setState({ presentationOpen: false, base: null, liveDeck: null });
  }
});
