/**
 * The rule a deck's sounds follow as the live slide moves (owner, 2026-10-27):
 * a sound starts when its slides are reached — in order, by a jump, or by
 * GO LIVE onto one — stops past its last slide, and keeps playing when the
 * operator goes back before its first.
 */
import { afterEach, expect, test } from "vitest";
import { deckSoundChanges, startDeckSounds } from "@renderer/effects/deck-sounds";
import { useAudioStore } from "@renderer/stores/audio.store";
import { useProjectionStore, type LiveDeck } from "@renderer/stores/projection.store";
import type { DeckSlide, DeckSound } from "@shared/types/deck";

const hymn: DeckSound = { id: 1, url: "worship://a/1", startSlideIndex: 13, stopSlideIndex: 14, loop: false };
const communion: DeckSound = { id: 2, url: "worship://a/2", startSlideIndex: 39, stopSlideIndex: null, loop: true };
const sounds = [hymn, communion];
const ids = (changes: ReturnType<typeof deckSoundChanges>) => ({ start: changes.start.map((s) => s.id), stop: changes.stop });

test("nothing plays before a sound's first slide", () => {
  expect(ids(deckSoundChanges(sounds, 12, new Set()))).toEqual({ start: [], stop: [] });
});

test("reaching its slide starts it, and the next slide in its range leaves it alone", () => {
  expect(ids(deckSoundChanges(sounds, 13, new Set()))).toEqual({ start: [1], stop: [] });
  expect(ids(deckSoundChanges(sounds, 14, new Set([1])))).toEqual({ start: [], stop: [] });
});

test("past its last slide it stops; one with no last slide plays to the end", () => {
  expect(ids(deckSoundChanges(sounds, 15, new Set([1])))).toEqual({ start: [], stop: [1] });
  expect(ids(deckSoundChanges(sounds, 80, new Set([2])))).toEqual({ start: [], stop: [] });
});

test("jumping over its first slide, or going live straight onto it, starts it from the top", () => {
  expect(ids(deckSoundChanges(sounds, 50, new Set()))).toEqual({ start: [2], stop: [] });
});

test("going back before its first slide keeps it playing", () => {
  expect(ids(deckSoundChanges(sounds, 38, new Set([2])))).toEqual({ start: [], stop: [] });
});

test("a jump past a short sound's range never starts it", () => {
  expect(ids(deckSoundChanges(sounds, 20, new Set()))).toEqual({ start: [], stop: [] });
});

/** The live deck's sound tracks: which sound, and which playback of it (`epoch`, what the projector remounts on). */
const soundTracks = () =>
  useAudioStore
    .getState()
    .tracks.filter((track) => track.source === "deck")
    .map((track) => `${track.trackId}@${track.epoch}`);

const initialProjection = useProjectionStore.getState();
const initialAudio = useAudioStore.getState();
let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  useProjectionStore.setState(initialProjection, true);
  useAudioStore.setState(initialAudio, true);
});

/** A deck of 40 slides with the communion music from slide 39 on, live on `slide`. */
function liveDeckOn(slide: number): void {
  const deck: LiveDeck = {
    assetId: 5,
    deckId: 50,
    slides: Array.from({ length: 40 }, (_, i) => ({ index: i + 1 }) as DeckSlide),
    soundtrack: null,
    sounds: [communion],
    videos: [],
    cumulativeMs: [],
    autoAdvance: false,
  };
  const store = useProjectionStore.getState();
  store.beginScene();
  store.setLiveDeck(deck);
  store.setBase({ kind: "deck", assetId: 5, slideIndex: slide });
  stop = startDeckSounds();
}

/** What `toggleOverlay` does: a new scene, and the cover. */
function pressB(): void {
  useProjectionStore.getState().beginScene();
  const { overlay, setOverlay } = useProjectionStore.getState();
  setOverlay(overlay === "black" ? "none" : "black");
}

test("NEGRO and back keeps the deck's sound where it was: the same playback, never a new one from 0:00", () => {
  liveDeckOn(39);
  const playing = soundTracks();
  expect(playing).toHaveLength(1);
  pressB();
  pressB();
  expect(soundTracks()).toEqual(playing);
});

test("a sound kept playing past a move back before its first slide survives NEGRO", () => {
  liveDeckOn(39);
  const playing = soundTracks();
  useProjectionStore.getState().setSlideIndex(38);
  expect(soundTracks()).toEqual(playing);
  pressB();
  expect(soundTracks()).toEqual(playing);
});
