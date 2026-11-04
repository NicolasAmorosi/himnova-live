/**
 * `deck-autoplay` — a deck that advances by itself, with no soundtrack to
 * follow, runs on a wall-clock chain of deadlines.
 *
 * The chain is monotonic on purpose (a late timeout must not push every later
 * boundary out), which is exactly why it must start over for each deck: the
 * next deck sent live inherited what was left of the previous one's slide.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startDeckAutoplay } from "@renderer/effects/deck-autoplay";
import { buildCumulativeMs, useProjectionStore, type LiveDeck } from "@renderer/stores/projection.store";

function deck(assetId: number, advanceAfterMs: number): LiveDeck {
  const slides = [1, 2, 3].map((index) => ({
    index,
    url: `worship://deck/${assetId}/${index}`,
    thumbUrl: `worship://deck/${assetId}/${index}/thumb`,
    modelUrl: null,
    advanceAfterMs,
    transition: null,
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
