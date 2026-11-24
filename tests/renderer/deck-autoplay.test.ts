/**
 * `deck-autoplay` — a deck that advances by itself, with no soundtrack to
 * follow, runs on a wall-clock chain of deadlines.
 *
 * The chain is monotonic on purpose (a late timeout must not push every later
 * boundary out), which is exactly why it must start over for each deck: the
 * next deck sent live inherited what was left of the previous one's slide.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  notifyManualNavigation,
  pauseAutoplay,
  restartDeck,
  resumeAutoplay,
  resyncDeck,
  startDeckAutoplay,
} from "@renderer/effects/deck-autoplay";
import { toAudioTrackPush } from "@renderer/effects/projection-sync";
import { toggleAudioTrackPause } from "@renderer/lib/actions/media";
import { useAudioStore } from "@renderer/stores/audio.store";
import { buildCumulativeMs, useProjectionStore, type LiveDeck } from "@renderer/stores/projection.store";
import type { SlideTransition } from "@shared/types/transition";

function deck(assetId: number, advanceAfterMs: number, transition: SlideTransition | null = null): LiveDeck {
  const slides = [1, 2, 3].map((index) => ({
    index,
    url: `worship://deck/${assetId}/${index}`,
    thumbUrl: `worship://deck/${assetId}/${index}/thumb`,
    modelUrl: null,
    advanceAfterMs,
    transition,
  }));
  return {
    assetId,
    deckId: assetId,
    slides,
    soundtrack: null,
    sounds: [],
    videos: [],
    cumulativeMs: buildCumulativeMs(slides),
    autoAdvance: true,
  };
}

/** What `goLiveWithDeck` does, without the IPC around it. */
function sendLive(live: LiveDeck): void {
  const store = useProjectionStore.getState();
  store.setLiveDeck(live);
  store.setBase({ kind: "deck", assetId: live.assetId, slideIndex: 1 });
  store.setAutoplay("playing");
}

let stop: () => void;
const initial = useProjectionStore.getState();

beforeEach(() => {
  vi.useFakeTimers();
  useProjectionStore.setState(initial, true);
  stop = startDeckAutoplay();
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

test("each deck sent live starts its own clock", () => {
  sendLive(deck(1, 8000));
  vi.advanceTimersByTime(5000);
  expect(useProjectionStore.getState().base).toMatchObject({ assetId: 1, slideIndex: 1 });

  // A hymn with 3 s slides goes live 5 s into the announcements' 8 s slide.
  sendLive(deck(2, 3000));
  vi.advanceTimersByTime(3100);
  expect(useProjectionStore.getState().base).toMatchObject({ assetId: 2, slideIndex: 2 });
  vi.advanceTimersByTime(3000);
  expect(useProjectionStore.getState().base).toMatchObject({ assetId: 2, slideIndex: 3 });
});

test("a slide's «After» time counts from the end of its transition, as PowerPoint plays it", () => {
  // The hymnal's slow fade on every slide: the first one's plays before the music, so only its time counts.
  const live = deck(4, 3000, { style: "crossfade", durationMs: 1000 });
  expect(live.cumulativeMs).toEqual([0, 0, 3000, 7000, 11000]);
  sendLive(live);
  vi.advanceTimersByTime(3100);
  expect(useProjectionStore.getState().base).toMatchObject({ slideIndex: 2 });
  vi.advanceTimersByTime(3000);
  expect(useProjectionStore.getState().base).toMatchObject({ slideIndex: 2 });
  vi.advanceTimersByTime(1000);
  expect(useProjectionStore.getState().base).toMatchObject({ slideIndex: 3 });
});

test("a soundtrack reported paused holds the slide where its music stopped", () => {
  const live = { ...deck(3, 2000), soundtrack: { url: "worship://engine/deck-audio/1", durationMs: null, origin: "embedded" as const, name: "1.wma" } };
  sendLive(live);
  const status = (currentTimeSeconds: number, paused: boolean) =>
    useProjectionStore.getState().setMediaStatus({
      target: { kind: "audio", trackId: "deck-soundtrack" },
      epoch: useProjectionStore.getState().soundtrackEpoch,
      currentTimeSeconds,
      durationSeconds: 6,
      paused,
      ended: false,
    });
  status(0.1, false);
  status(1.9, false);
  // The engine pauses it with the projector closed, and keeps saying so four times a second.
  for (let i = 0; i < 12; i += 1) {
    status(1.95, true);
    vi.advanceTimersByTime(250);
  }
  expect(useProjectionStore.getState().base).toMatchObject({ slideIndex: 1 });
  status(1.95, false);
  vi.advanceTimersByTime(100);
  expect(useProjectionStore.getState().base).toMatchObject({ slideIndex: 2 });
});

test("«Reiniciar» on a synced deck never jumps back to the music's slide for an instant", () => {
  (window as unknown as { worship: unknown }).worship = {
    invoke: () => Promise.resolve({ ok: true, data: undefined }),
    on: () => () => {},
  };
  const live = { ...deck(4, 10_000), soundtrack: { url: "worship://deck-audio/4", durationMs: null, origin: "embedded" as const, name: "a.mp3" } };
  sendLive(live);
  const seen: number[] = [];
  const unsubscribe = useProjectionStore.subscribe(
    (st) => (st.base?.kind === "deck" ? st.base.slideIndex : 0),
    (index) => seen.push(index),
  );
  const status = (currentTimeSeconds: number) =>
    useProjectionStore.getState().setMediaStatus({
      target: { kind: "audio", trackId: "deck-soundtrack" },
      epoch: useProjectionStore.getState().soundtrackEpoch,
      currentTimeSeconds,
      durationSeconds: 40,
      paused: false,
      ended: false,
    });
  status(0.1);
  status(25);
  restartDeck();
  status(25.25); // emitted before the projector applied «restart», still in flight
  status(0.05); // the first report after it
  status(12); // the music really moved on: synced again
  unsubscribe();
  expect(seen).toEqual([3, 1, 2]);
});

/** A deck with music, as `goLiveWithDeck` sends it, and the projector's reports of that music. */
function withMusic(live: LiveDeck): LiveDeck {
  return { ...live, soundtrack: { url: `worship://deck-audio/${live.assetId}`, durationMs: null, origin: "linked", name: "a.mp3" } };
}
function report(currentTimeSeconds: number, { ended = false, paused = false } = {}): void {
  useProjectionStore.getState().setMediaStatus({
    target: { kind: "audio", trackId: "deck-soundtrack" },
    epoch: useProjectionStore.getState().soundtrackEpoch,
    currentTimeSeconds,
    durationSeconds: 7.5,
    paused: paused || ended,
    ended,
  });
}
const slideOnAir = () => (useProjectionStore.getState().base as { slideIndex: number }).slideIndex;

test("slides that outlast their music stay up on their own times, as PowerPoint keeps them", () => {
  // Slides of 4 s plus a 1 s fade: boundaries at 4, 9 and 14 s. The music ends at 7.5 s, 1.5 s into slide 2.
  const live = withMusic(deck(5, 4000, { style: "crossfade", durationMs: 1000 }));
  sendLive(live);
  report(0.1);
  report(4.1);
  expect(slideOnAir()).toBe(2);
  report(7.5, { ended: true });
  report(7.5, { ended: true }); // the engine says it again: nothing re-arms
  // No clock to rejoin: «Resincronizar» changes nothing.
  resyncDeck();
  vi.advanceTimersByTime(1400);
  expect(slideOnAir()).toBe(2);
  vi.advanceTimersByTime(200);
  expect(slideOnAir()).toBe(3);
  // Slide 3 came in with its fade: 4 s after it.
  vi.advanceTimersByTime(4800);
  expect(useProjectionStore.getState().autoplay).toBe("playing");
  vi.advanceTimersByTime(300);
  expect(useProjectionStore.getState().autoplay).toBe("finished");
  expect(slideOnAir()).toBe(3);
});

test("music that ends with its position lost never sends the deck back to its first slide", () => {
  sendLive(withMusic(deck(8, 4000)));
  report(0.1);
  report(4.1);
  expect(slideOnAir()).toBe(2);
  // The engine's `ended` came with no position (0 s): the slides go on from where they are.
  report(0, { ended: true });
  expect(slideOnAir()).toBe(2);
});

test("music that outlasts the slides still decides the end", () => {
  sendLive(withMusic(deck(6, 2000)));
  report(0.1);
  report(5.9);
  vi.advanceTimersByTime(100);
  // The slides are done; `end-of-playback` waits for the music's own end.
  expect(useProjectionStore.getState().autoplay).toBe("finished");
  report(7.5, { ended: true });
  expect(useProjectionStore.getState().autoplay).toBe("finished");
  expect(useProjectionStore.getState().autoplayMode).toBe("synced");
  expect(slideOnAir()).toBe(3);
});

test("pausing past the music's end never starts the music over", () => {
  const setPaused = vi.spyOn(useAudioStore.getState(), "setPaused");
  sendLive(withMusic(deck(9, 4000)));
  report(0.1);
  report(4.1);
  report(7.5, { ended: true });
  pauseAutoplay();
  resumeAutoplay();
  expect(setPaused).not.toHaveBeenCalledWith("deck-soundtrack", false);
  // The resumed slide gets its time again, as any paused slide does, and the deck still ends.
  vi.advanceTimersByTime(4100);
  expect(slideOnAir()).toBe(3);
  setPaused.mockRestore();
});

test("a slide reached by a step back waits its own time, without the fade it never played", () => {
  sendLive(deck(7, 3000, { style: "crossfade", durationMs: 1000 }));
  vi.advanceTimersByTime(3100);
  vi.advanceTimersByTime(4000);
  expect(slideOnAir()).toBe(3);
  useProjectionStore.getState().setSlideIndex(2);
  notifyManualNavigation();
  vi.advanceTimersByTime(3100);
  expect(slideOnAir()).toBe(3);
});

test("BLACK over a detached deck with music gives its slide back only what was left of it", () => {
  sendLive(withMusic(deck(8, 4000)));
  notifyManualNavigation();
  vi.advanceTimersByTime(1000);
  useProjectionStore.getState().setOverlay("black");
  vi.advanceTimersByTime(10_000);
  expect(slideOnAir()).toBe(1);
  useProjectionStore.getState().setOverlay("none");
  vi.advanceTimersByTime(2900);
  expect(slideOnAir()).toBe(1);
  vi.advanceTimersByTime(200);
  expect(slideOnAir()).toBe(2);
});

test("music that ended is held paused, so lifting LOGO under the slides left never plays it from the top", () => {
  const live = withMusic(deck(10, 4000));
  sendLive(live);
  const epoch = useProjectionStore.getState().soundtrackEpoch;
  useAudioStore.getState().setDeckTrack({ url: live.soundtrack!.url, epoch, paused: false, startAtSeconds: 0, label: "", volume: 1, loop: false });
  const deckTrack = () => useAudioStore.getState().tracks.find((t) => t.trackId === "deck-soundtrack")!;
  report(0.1);
  report(4.1);
  report(7.5, { ended: true });
  // The push folds the cover into `paused`: false once LOGO lifts was a `play()` of an ended `<audio>`, which starts
  // it over from 0:00 under the slides still to come.
  useProjectionStore.getState().setOverlay("logo");
  useProjectionStore.getState().setOverlay("none");
  expect(toAudioTrackPush(deckTrack(), false, false, 1).paused).toBe(true);
  // «Reiniciar» plays it again, from the top with its slides, and the end's report still in flight does not stop it.
  restartDeck();
  expect(deckTrack().paused).toBe(false);
  report(7.5, { ended: true });
  expect(deckTrack().paused).toBe(false);
});

test("what a cover froze is forgotten once lifted over something else: a later deck's slide gets only its own time left", () => {
  sendLive(withMusic(deck(11, 4000)));
  notifyManualNavigation();
  vi.advanceTimersByTime(1000);
  useProjectionStore.getState().setOverlay("logo");
  // GO LIVE of a picture: the base changes first, then the cover lifts, over the picture.
  useProjectionStore.getState().setBase({ kind: "image", assetId: 1 });
  useProjectionStore.getState().setOverlay("none");
  sendLive(withMusic(deck(12, 4000)));
  notifyManualNavigation();
  vi.advanceTimersByTime(1000);
  useProjectionStore.getState().setOverlay("black");
  vi.advanceTimersByTime(10_000);
  useProjectionStore.getState().setOverlay("none");
  vi.advanceTimersByTime(2900);
  expect(slideOnAir()).toBe(1);
  vi.advanceTimersByTime(200);
  expect(slideOnAir()).toBe(2);
});

test("the music row pauses the music the slides finished before, and plays the deck again once it is over", () => {
  const live = withMusic(deck(13, 2000));
  sendLive(live);
  const epoch = useProjectionStore.getState().soundtrackEpoch;
  useAudioStore.getState().setDeckTrack({ url: live.soundtrack!.url, epoch, paused: false, startAtSeconds: 0, label: "", volume: 1, loop: false });
  const deckTrack = () => useAudioStore.getState().tracks.find((t) => t.trackId === "deck-soundtrack")!;
  report(0.1);
  report(5.9);
  vi.advanceTimersByTime(100);
  expect(useProjectionStore.getState().autoplay).toBe("finished");
  // The outro: the deck's clock has nothing left to pause, the row pauses the music itself, and plays it on.
  toggleAudioTrackPause("deck-soundtrack");
  expect(deckTrack().paused).toBe(true);
  toggleAudioTrackPause("deck-soundtrack");
  expect(deckTrack().paused).toBe(false);
  // Over: its ▶ plays the deck again, from the top with its music.
  report(7.5, { ended: true });
  toggleAudioTrackPause("deck-soundtrack");
  expect(useProjectionStore.getState().autoplay).toBe("playing");
  expect(slideOnAir()).toBe(1);
  expect(deckTrack().paused).toBe(false);
});
