/**
 * Guards of a deck with music that nothing else in the suite would see break (2026-11-22 audit, TQ1 to TQ3, TQ7 and
 * TQ8): each test fails on the mutant the audit named. Music longer than the slides keeps the deck up until it ends;
 * pausing and resuming move the music with the slides; music ending under a slide stepped back to leaves it up; a late
 * report from the previous deck's music, or the old slide's timer after «Reiniciar», moves nothing. And what only the
 * full E2E saw until TQ13: music that starts over mid-deck goes back to its slide, music that fails lets the slides go
 * on, and «Reiniciar» under NEGRO never plays the music behind it.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notifyManualNavigation, pauseAutoplay, restartDeck, resumeAutoplay, startDeckAutoplay } from "@renderer/effects/deck-autoplay";
import { startEndOfPlaybackEffects } from "@renderer/effects/end-of-playback";
import { useAudioStore } from "@renderer/stores/audio.store";
import { buildCumulativeMs, useProjectionStore, type LiveDeck } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { DEFAULT_SETTINGS } from "@shared/types/settings";

function deck(assetId: number, advanceAfterMs: number): LiveDeck {
  const slides = [1, 2, 3].map((index) => ({ index, url: `worship://deck/${assetId}/${index}`, thumbUrl: "t", modelUrl: null, advanceAfterMs, transition: null }));
  return {
    assetId,
    deckId: assetId,
    slides,
    soundtrack: { url: `worship://deck-audio/${assetId}`, durationMs: null, origin: "linked", name: "a.mp3" },
    sounds: [],
    videos: [],
    cumulativeMs: buildCumulativeMs(slides),
    autoAdvance: true,
  };
}
function sendLive(live: LiveDeck): void {
  const store = useProjectionStore.getState();
  store.setLiveDeck(live);
  store.setBase({ kind: "deck", assetId: live.assetId, slideIndex: 1 });
  const epoch = useProjectionStore.getState().soundtrackEpoch;
  useAudioStore.getState().setDeckTrack({ url: live.soundtrack!.url, epoch, paused: false, startAtSeconds: 0, label: "", volume: 1, loop: false });
  store.setAutoplay("playing");
}
function report(t: number, { ended = false, epoch = useProjectionStore.getState().soundtrackEpoch } = {}): void {
  useProjectionStore.getState().setMediaStatus({ target: { kind: "audio", trackId: "deck-soundtrack" }, epoch, currentTimeSeconds: t, durationSeconds: 20, paused: ended, ended });
}
const slide = () => (useProjectionStore.getState().base as { slideIndex: number } | null)?.slideIndex ?? null;
const music = () => useAudioStore.getState().tracks.find((t) => t.trackId === "deck-soundtrack");

const initial = useProjectionStore.getState();
const initialAudio = useAudioStore.getState();
let stops: (() => void)[] = [];
const answer = (_channel: string, _req?: unknown) => Promise.resolve({ ok: true, data: undefined });
let invoke = vi.fn(answer);
/** The commands sent to the deck's music in the projector. */
const musicCommands = () =>
  invoke.mock.calls.filter(([channel]) => channel === "projection:mediaCommand").map(([, command]) => command);
beforeEach(() => {
  vi.useFakeTimers();
  invoke = vi.fn(answer);
  (window as unknown as { worship: unknown }).worship = { invoke, on: () => () => {} };
  useProjectionStore.setState(initial, true);
  useAudioStore.setState(initialAudio, true);
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  stops = [startDeckAutoplay(), startEndOfPlaybackEffects()];
});
afterEach(() => {
  stops.forEach((stop) => stop());
  vi.useRealTimers();
});

// P11 (end-of-playback.ts:37): the slides are done, the hymn's music is not. The deck waits for it.
test("a deck whose slides finish before its music stays up until the music ends, then goes", () => {
  sendLive(deck(6, 2000));
  report(0.1);
  report(5.9);
  vi.advanceTimersByTime(100);
  expect(useProjectionStore.getState().autoplay).toBe("finished");
  expect(useProjectionStore.getState().base?.kind).toBe("deck");
  report(9, { ended: true });
  expect(useProjectionStore.getState().base).toBeNull();
});

// G (deck-autoplay.ts:212): Space on a deck with music freezes the slides AND the music.
test("pausing a deck with music pauses its music, and resuming plays it", () => {
  sendLive(deck(7, 4000));
  report(0.1);
  pauseAutoplay();
  expect(music()?.paused).toBe(true);
  resumeAutoplay();
  expect(music()?.paused).toBe(false);
});

// A (deck-autoplay.ts:364): the operator stepped back to repeat a chorus; the music ends under it.
test("music that ends under a slide the operator stepped back to leaves that slide up", () => {
  sendLive(deck(8, 4000));
  report(0.1);
  report(8.1);
  expect(slide()).toBe(3);
  useProjectionStore.getState().setSlideIndex(2);
  notifyManualNavigation();
  report(12, { ended: true });
  expect(slide()).toBe(2);
  expect(useProjectionStore.getState().base?.kind).toBe("deck");
});

// F (deck-autoplay.ts:333): the previous hymn's last report, still in flight, is not the new hymn's clock.
test("a report from the previous deck's music does not move the new deck's slide", () => {
  sendLive(deck(9, 4000));
  report(0.1);
  const old = useProjectionStore.getState().soundtrackEpoch;
  sendLive(deck(10, 4000));
  report(9, { epoch: old });
  expect(slide()).toBe(1);
});

// E (deck-autoplay.ts:122): «Reiniciar» on a deck the operator had taken by hand; the old chain's timer must not fire.
test("«Reiniciar» after a manual step is not followed by the old slide's timer", () => {
  sendLive(deck(11, 4000));
  report(0.1);
  notifyManualNavigation();
  vi.advanceTimersByTime(3000);
  restartDeck();
  vi.advanceTimersByTime(1500);
  expect(slide()).toBe(1);
});

// TQ13 (deck-autoplay.ts, the first report of a play): a projector reopened mid-hymn gives a fresh music player at 0.
test("music that starts over under the hymn's second slide is sent back to where that slide begins", () => {
  sendLive(deck(12, 4000));
  useProjectionStore.getState().setSlideIndex(2);
  report(0.1);
  expect(musicCommands()).toEqual([{ target: { kind: "audio", trackId: "deck-soundtrack" }, action: "seek", timeSeconds: 4 }]);
  expect(slide()).toBe(2);
});

// TQ13 (deck-autoplay.ts, the music's error): a file the projector cannot play leaves a synced deck on a stopped clock.
test("music that fails lets the slides go on with their own times", () => {
  sendLive(deck(13, 4000));
  const target = { kind: "audio", trackId: "deck-soundtrack" } as const;
  useProjectionStore.getState().setMediaError({ target, url: "worship://deck-audio/13", code: null });
  expect(useProjectionStore.getState().autoplayMode).toBe("detached");
  vi.advanceTimersByTime(4100);
  expect(slide()).toBe(2);
});

// TQ13 (restartDeck): «restart» is a `play()` in the projector, which beat the cover's pause.
test("«Reiniciar» under NEGRO only rewinds the music, it never plays it behind the black", () => {
  sendLive(deck(14, 4000));
  report(0.1);
  useProjectionStore.getState().setOverlay("black");
  restartDeck();
  expect(musicCommands()).toEqual([{ target: { kind: "audio", trackId: "deck-soundtrack" }, action: "seek", timeSeconds: 0 }]);
});
