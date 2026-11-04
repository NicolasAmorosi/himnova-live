import { defaultMediaVolume } from "@renderer/stores/settings.store";
import { DECK_SOUND_TRACK_PREFIX, nextDeckSoundTrack, useAudioStore } from "@renderer/stores/audio.store";
import { useDeckStore } from "@renderer/stores/deck.store";
import { useProjectionStore, type LiveDeck, type ProjectionStoreState } from "@renderer/stores/projection.store";
import type { DeckSound } from "@shared/types/deck";

/**
 * What the live deck's sounds (`LiveDeck.sounds`: everything in the file but
 * its music) do when the live slide becomes `slide`. The whole rule, decided
 * by the owner on 2026-10-27:
 *
 * - a sound whose slides include `slide` and that isn't playing starts, from
 *   the top — reached in order, by a jump over its first slide, or by GO LIVE
 *   straight onto one of its slides;
 * - one that is playing stops once the slide is past its last;
 * - one that is playing KEEPS playing when the operator goes back before its
 *   first slide: they moved the slide, not the music (the soundtrack's rule,
 *   `deck-autoplay.ts`).
 */
export function deckSoundChanges(
  sounds: readonly DeckSound[],
  slide: number,
  playing: ReadonlySet<number>,
): { start: DeckSound[]; stop: number[] } {
  const start: DeckSound[] = [];
  const stop: number[] = [];
  for (const sound of sounds) {
    const past = sound.stopSlideIndex !== null && slide > sound.stopSlideIndex;
    if (playing.has(sound.id)) {
      if (past) stop.push(sound.id);
    } else if (slide >= sound.startSlideIndex && !past) {
      start.push(sound);
    }
  }
  return { start, stop };
}

/** The live deck's sounds — from the deck store while it holds this same
 *  deck: a WMA the media engine takes after GO LIVE arrives there
 *  (`deck-updated` → `refreshDeck`), never in the snapshot `liveDeck` is. */
function liveSounds(deck: LiveDeck): readonly DeckSound[] {
  const fresh = useDeckStore.getState().byAssetId[deck.assetId]?.deck;
  return fresh?.deckId === deck.deckId ? fresh.sounds : deck.sounds;
}

/** The scene the sounds playing now belong to: a new GO LIVE (even of the
 *  same deck) starts them all over, as it starts the soundtrack over. */
let scene: string | null = null;

function reconcile(state: ProjectionStoreState): void {
  const audio = useAudioStore.getState();
  const deck = state.base?.kind === "deck" ? state.liveDeck : null;
  const current = deck ? `${state.sceneEpoch}:${deck.deckId}` : null;
  if (current !== scene) {
    scene = current;
    for (const track of audio.tracks) {
      if (track.trackId.startsWith(DECK_SOUND_TRACK_PREFIX)) audio.removeTrack(track.trackId);
    }
  }
  if (!deck || state.base?.kind !== "deck") return;

  const playing = new Set(
    useAudioStore
      .getState()
      .tracks.filter((track) => track.trackId.startsWith(DECK_SOUND_TRACK_PREFIX))
      .map((track) => Number(track.trackId.slice(DECK_SOUND_TRACK_PREFIX.length))),
  );
  const { start, stop } = deckSoundChanges(liveSounds(deck), state.base.slideIndex, playing);
  for (const id of stop) audio.removeTrack(`${DECK_SOUND_TRACK_PREFIX}${id}`);
  for (const sound of start) {
    audio.addTrack({
      ...nextDeckSoundTrack(sound.id),
      source: "deck",
      assetId: null,
      label: "",
      url: sound.url,
      paused: false,
      startAtSeconds: 0,
      volume: defaultMediaVolume(),
      loop: sound.loop,
    });
  }
}

/** The transport's «restart»: the deck from its first slide, so its sounds
 *  from nothing — then whatever the first slide plays. */
export function restartDeckSounds(): void {
  scene = null;
  reconcile(useProjectionStore.getState());
}

/** Keeps the live deck's sounds playing on their slides. Runs in the control
 *  window with the other effects (`projection-sync.ts`); `source: "deck"` is
 *  what makes BLACK/LOGO pause them with the soundtrack. */
export function startDeckSounds(): () => void {
  scene = null;
  const unsubscribeLive = useProjectionStore.subscribe(
    (state) =>
      state.base?.kind === "deck" && state.liveDeck
        ? `${state.sceneEpoch}:${state.liveDeck.deckId}:${state.base.slideIndex}`
        : null,
    () => reconcile(useProjectionStore.getState()),
  );
  // A sound that becomes playable mid-slide starts there and then. Cheap and
  // a no-op when nothing changed: a deck has a handful of sounds.
  const unsubscribeDecks = useDeckStore.subscribe(() => reconcile(useProjectionStore.getState()));
  reconcile(useProjectionStore.getState());
  return () => {
    unsubscribeLive();
    unsubscribeDecks();
  };
}
