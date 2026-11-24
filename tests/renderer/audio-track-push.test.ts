/** What the control window sends the projector for each live audio track (`projection-sync.ts`), and what the room
 *  hears when the projector goes away, a track ends or CLEAR is pressed (2026-11-22 audit, TQ13). */
import { beforeEach, expect, test, vi } from "vitest";
import { startProjectionEffects, toAudioTrackPush } from "@renderer/effects/projection-sync";
import { clearLive } from "@renderer/lib/actions/playback";
import { useAudioStore, type LiveAudioTrack } from "@renderer/stores/audio.store";
import { useDisplayStore } from "@renderer/stores/display.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { buildCumulativeMs, useProjectionStore, type LiveDeck } from "@renderer/stores/projection.store";
import { useToastStore } from "@renderer/stores/toast.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import type { IpcEventName, IpcEvents } from "@shared/ipc/contract";
import { mediaErrorKey, type AudioEndAction, type AudioTrackPush } from "@shared/types/projection";
import { DEFAULT_SETTINGS } from "@shared/types/settings";

const track = (source: LiveAudioTrack["source"], paused = false): LiveAudioTrack => ({
  trackId: source,
  source,
  assetId: null,
  label: source,
  url: `worship://${source}`,
  epoch: 1,
  paused,
  startAtSeconds: 0,
  volume: 1,
  loop: false,
});

test("BLACK/LOGO pause the deck's music, never a standalone audio", () => {
  // Fails if the deck's soundtrack plays on over BLACK.
  expect(toAudioTrackPush(track("deck"), true, false, 1).paused).toBe(true);
  // Fails if covering the screen stops a standalone track (the prelude music goes on under BLACK).
  expect(toAudioTrackPush(track("asset"), true, false, 1).paused).toBe(false);
  // Fails if the operator's own pause is lost.
  expect(toAudioTrackPush(track("asset", true), false, false, 1).paused).toBe(true);
});

test("«loop» at the end of an audio loops a standalone track, not the deck's", () => {
  // Fails if `projection.audioEnd` «loop» is not folded in, or reaches the deck's soundtrack.
  expect([toAudioTrackPush(track("asset"), false, true, 1).loop, toAudioTrackPush(track("deck"), false, true, 1).loop]).toEqual([true, false]);
});

test("a live track sounds at its own level times the LIVE master", () => {
  // Fails if the LIVE strip's fader does not reach the tracks the projector and the engine play.
  expect(toAudioTrackPush({ ...track("asset"), volume: 0.8 }, false, false, 0.5).volume).toBeCloseTo(0.4, 6);
  expect(toAudioTrackPush({ ...track("deck"), volume: 0.8 }, false, false, 1).volume).toBeCloseTo(0.8, 6);
});

test("with nothing playing, LIVE's fader does not send the empty list again on every step (audit R16)", async () => {
  const invoke = vi.fn((_channel: string, _req?: unknown) => Promise.resolve({ ok: true, data: null }));
  (window as unknown as { worship: unknown }).worship = { invoke, on: () => () => {} };
  const pushes = () => invoke.mock.calls.filter(([channel]) => channel === "projection:setAudioTracks").map(([, req]) => req);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const stop = startProjectionEffects();
  try {
    for (const volume of [0.9, 0.8, 0.7]) {
      useProjectionStore.getState().setLiveMasterVolume(volume);
      await settle();
    }
    expect(pushes()).toEqual([[]]);
    // A track, its level with the master, and its end: each still goes.
    useAudioStore.getState().addTrack({ ...track("asset"), volume: 0.5 });
    await settle();
    useProjectionStore.getState().setLiveMasterVolume(0.6);
    await settle();
    useAudioStore.getState().clear();
    await settle();
    expect(pushes().map((list) => (list as AudioTrackPush[]).map((push) => push.volume))).toEqual([[], [0.35], [0.3], []]);
  } finally {
    stop();
  }
});

/** Main's side of the bridge: what was sent on each channel, and the events it can fire at the control window. */
const handlers = new Map<IpcEventName, (payload: unknown) => void>();
const emit = <E extends IpcEventName>(event: E, payload: IpcEvents[E]): void => handlers.get(event)?.(payload);
/** What main answers: an audio for every `library:get`, nothing for the rest. */
const answer = (channel: string, req?: unknown) =>
  Promise.resolve({
    ok: true,
    data: channel === "library:get" ? { ...(req as { id: number }), kind: "audio", name: "" } : null,
  });
let invoke = vi.fn(answer);
const lastPush = (): AudioTrackPush[] | undefined =>
  invoke.mock.calls.filter(([channel]) => channel === "projection:setAudioTracks").at(-1)?.[1] as AudioTrackPush[] | undefined;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const initialProjection = useProjectionStore.getState();
const initialAudio = useAudioStore.getState();
const initialProgram = useProgramStore.getState();
const initialDisplay = useDisplayStore.getState();
beforeEach(() => {
  handlers.clear();
  invoke = vi.fn(answer);
  (window as unknown as { worship: unknown }).worship = {
    invoke,
    on: (event: IpcEventName, callback: (payload: unknown) => void) => {
      handlers.set(event, callback);
      return () => handlers.delete(event);
    },
  };
  useProjectionStore.setState(initialProjection, true);
  useAudioStore.setState(initialAudio, true);
  useProgramStore.setState(initialProgram, true);
  useDisplayStore.setState(initialDisplay, true);
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
});

const audioEnd = (action: AudioEndAction) =>
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, "projection.audioEnd": action } });

test("NEGRO pauses the deck's music on the projector, and lifting it sends the music playing again", async () => {
  const stop = startProjectionEffects();
  try {
    const music = { url: "worship://deck-audio/1", epoch: 1, paused: false, startAtSeconds: 0, label: "", volume: 1, loop: false };
    useAudioStore.getState().setDeckTrack(music);
    await settle();
    // Fails if the cover is not folded into the push, or a cover alone sends nothing: the hymn sings behind NEGRO.
    useProjectionStore.getState().setOverlay("black");
    await settle();
    expect(lastPush()?.map((push) => push.paused)).toEqual([true]);
    useProjectionStore.getState().setOverlay("none");
    await settle();
    expect(lastPush()?.map((push) => push.paused)).toEqual([false]);
  } finally {
    stop();
  }
});

test("a projector that closes keeps where each track was, so it resumes there and not from the start", () => {
  const stop = startProjectionEffects();
  try {
    useAudioStore.getState().addTrack(track("asset"));
    const target = { kind: "audio", trackId: "asset" } as const;
    emit("media-status", { target, epoch: 1, currentTimeSeconds: 42, durationSeconds: 200, paused: false, ended: false });
    emit("projection-closed", { reopen: false });
    // Fails if the positions are not frozen: the prelude music starts over from 0:00 when the projector reopens.
    expect(useAudioStore.getState().tracks[0]?.startAtSeconds).toBe(42);
  } finally {
    stop();
  }
});

test("a projector whose renderer died opens again on its own; one closed by hand waits for the operator", () => {
  const openIfNeeded = vi.fn(() => Promise.resolve());
  useDisplayStore.setState({ openIfNeeded });
  const stop = startProjectionEffects();
  try {
    emit("projection-closed", { reopen: false });
    expect(openIfNeeded).not.toHaveBeenCalled();
    // Fails if the dead projector is left down: the room sees the desktop until someone notices.
    emit("projection-closed", { reopen: true });
    expect(openIfNeeded).toHaveBeenCalledTimes(1);
  } finally {
    stop();
  }
});

/** A standalone audio sent from schedule row 10, the projector reporting its end. */
function endOfTrackFromRow10(): void {
  useAudioStore.getState().addTrack({ ...track("asset"), trackId: "asset:1:1", assetId: 1, fromItemId: 10 });
  const target = { kind: "audio", trackId: "asset:1:1" } as const;
  emit("media-status", { target, epoch: 1, currentTimeSeconds: 90, durationSeconds: 90, paused: true, ended: true });
}

test("a standalone audio that plays to its end leaves the live list", () => {
  audioEnd("stop");
  const stop = startProjectionEffects();
  try {
    endOfTrackFromRow10();
    // Fails if the ended track stays: the operator has to clean up a song that already finished.
    expect(useAudioStore.getState().tracks).toEqual([]);
  } finally {
    stop();
  }
});

test("with «Al terminar: siguiente», the audio row after the one that ended plays", async () => {
  audioEnd("next");
  useProgramStore.setState({
    items: [10, 11].map((id) => ({ id, position: id, kind: "media" as const, mediaAssetId: id - 9, title: null })),
  });
  const stop = startProjectionEffects();
  try {
    endOfTrackFromRow10();
    // Fails if the end does not chain: the background music stops after its first song.
    await vi.waitFor(() => expect(useAudioStore.getState().tracks.map((t) => t.assetId)).toEqual([2]));
  } finally {
    stop();
  }
});

test("CLEAR silences every track, the standalone ones too", async () => {
  const stop = startProjectionEffects();
  try {
    useAudioStore.getState().addTrack(track("asset"));
    await settle();
    expect(lastPush()).toHaveLength(1);
    clearLive();
    await settle();
    // Fails if CLEAR leaves the audio: «CLEAR means silence».
    expect(lastPush()).toEqual([]);
  } finally {
    stop();
  }
});

/** A deck on air of three slides with no music. */
function hymn(): LiveDeck {
  const slides = [1, 2, 3].map((index) => ({ index, url: `worship://deck/9/${index}`, thumbUrl: "", modelUrl: null, advanceAfterMs: null, transition: null }));
  return { assetId: 9, deckId: 9, slides, soundtrack: null, sounds: [], videos: [], cumulativeMs: buildCumulativeMs(slides), autoAdvance: false };
}

test("a broken slide gone back to, or looped over, is told once in its scene, and again in the next", () => {
  const stop = startProjectionEffects();
  useToastStore.setState({ toasts: [] });
  try {
    const store = useProjectionStore.getState();
    store.setLiveDeck(hymn());
    store.setBase({ kind: "deck", assetId: 9, slideIndex: 1 });
    store.beginScene();
    const broken = { target: { kind: "scene" as const }, url: "worship://deck/9/2", code: null };
    store.setSlideIndex(2);
    emit("media-error", broken);
    // Its slot leaves with the slide (RN2-2): without a memory of its own, each return toasted again (RN3-3).
    store.setSlideIndex(3);
    store.setSlideIndex(2);
    emit("media-error", broken);
    store.setSlideIndex(1);
    store.setSlideIndex(2);
    emit("media-error", broken);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    // GO LIVE on it again is a new attempt: told again.
    useProjectionStore.getState().beginScene();
    emit("media-error", broken);
    expect(useToastStore.getState().toasts).toHaveLength(2);
  } finally {
    stop();
  }
});

test("under LOGO, changing slides keeps the logo's failure: it stays up and is never told again", () => {
  const store = useProjectionStore.getState();
  store.setLiveDeck(hymn());
  store.setBase({ kind: "deck", assetId: 9, slideIndex: 1 });
  const logo = { target: { kind: "scene" as const }, url: "worship://logo/broken.png", code: null };
  store.setMediaError(logo);
  // Fails if the slot is cleared whatever it holds (review of the night 3, RN3-4).
  store.setSlideIndex(2);
  expect(useProjectionStore.getState().mediaErrors[mediaErrorKey({ kind: "scene" })]?.url).toBe(logo.url);
  // The slide's own failure still leaves with it (RN2-2).
  store.setMediaError({ ...logo, url: "worship://deck/9/2" });
  store.setSlideIndex(3);
  expect(useProjectionStore.getState().mediaErrors[mediaErrorKey({ kind: "scene" })]).toBeUndefined();
});
