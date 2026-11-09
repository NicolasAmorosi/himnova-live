/**
 * What the projector does when a live video reaches its end on its own —
 * `projection.videoEnd`, mirrored into the projection store — and when a deck
 * ends, on its own or stepped past its last slide (`projection.deckEnd`).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startEndOfPlaybackEffects } from "@renderer/effects/end-of-playback";
import { useProgramStore } from "@renderer/stores/program.store";
import { useDeckStore } from "@renderer/stores/deck.store";
import { buildCumulativeMs, selectOutput, useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { advanceSlide } from "@renderer/lib/actions/playback";
import type { VideoEndAction } from "@shared/types/projection";
import { DEFAULT_SETTINGS } from "@shared/types/settings";
import { assetUrl, slideUrl } from "@shared/urls";

const initialState = useProjectionStore.getState();
let stop: () => void = () => undefined;

beforeEach(() => {
  useProjectionStore.setState(initialState, true);
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  stop = startEndOfPlaybackEffects();
});
afterEach(() => stop());

/** A video live, then its element reporting the end. */
function playToTheEnd(videoEnd: VideoEndAction) {
  const store = useProjectionStore.getState();
  store.setVideoEnd(videoEnd);
  store.setBase({ kind: "video", assetId: 5, url: assetUrl(5), epoch: 2, startAtSeconds: 0 });
  store.setMediaStatus({ target: { kind: "video" }, epoch: 2, currentTimeSeconds: 8, durationSeconds: 8, paused: true, ended: true });
  return useProjectionStore.getState();
}

test("«Mostrar el logo» clears the stage under LOGO, as before the setting existed", () => {
  const state = playToTheEnd("logo");
  expect(state.base).toBeNull();
  expect(state.overlay).toBe("logo");
});

test("«Pantalla en negro» clears it under BLACK", () => {
  const state = playToTheEnd("black");
  expect(state.base).toBeNull();
  expect(state.overlay).toBe("black");
});

test("«Quedarse en el último cuadro» leaves the video where it ended, and stopped", () => {
  const state = playToTheEnd("hold");
  expect(state.base?.kind).toBe("video");
  expect(state.overlay).toBe("none");
  // The LIVE row offers «Reproducir», not «Pausar», over the held frame.
  expect(state.videoPaused).toBe(true);
});

test("«Repetir en bucle» travels in the output, so the element loops instead of ending", () => {
  const store = useProjectionStore.getState();
  store.setBase({ kind: "video", assetId: 5, url: assetUrl(5), epoch: 2, startAtSeconds: 0 });
  expect(selectOutput(useProjectionStore.getState()).videoUnderlay?.loop).toBe(false);
  store.setVideoEnd("loop");
  expect(selectOutput(useProjectionStore.getState()).videoUnderlay?.loop).toBe(true);
});

test("«Pasar al siguiente del programa» sends the next row that shows something, past a plate", async () => {
  const program = useProgramStore.getState();
  program.clear();
  program.addItem({ kind: "media", mediaAssetId: 5, title: "Video" });
  program.addItem({ kind: "plate", overlayPlateId: 1, title: "Zócalo" });
  program.addItem({
    kind: "bible",
    bibleVersionId: null,
    bibleBookId: null,
    chapter: null,
    verseFrom: null,
    verseTo: null,
    reference: "Juan 3:16",
    text: "Porque de tal manera amó Dios al mundo",
  });
  program.setActive(0);
  playToTheEnd("next");
  await vi.waitFor(() => expect(useProjectionStore.getState().base?.kind).toBe("bible"));
  expect(useProgramStore.getState().activeIndex).toBe(2);
});

test("a video that is not a schedule row has no next: the logo", async () => {
  useProgramStore.getState().clear();
  const state = playToTheEnd("next");
  await vi.waitFor(() => expect(useProjectionStore.getState().overlay).toBe("logo"));
  expect(state.base?.kind).toBe("video");
  expect(useProjectionStore.getState().base).toBeNull();
});

test("a next row that cannot go live — a deck that will not open — falls back to the logo, not the frozen video", async () => {
  // Adding a deck row asks main to read it in the background.
  (window as unknown as { worship: unknown }).worship = { invoke: () => Promise.resolve({ ok: true, data: null }) };
  const ensure = useDeckStore.getState().ensure;
  useDeckStore.setState({ ensure: () => Promise.resolve(null) });
  try {
    const program = useProgramStore.getState();
    program.clear();
    program.addItem({ kind: "media", mediaAssetId: 5, title: "Video" });
    program.addItem({ kind: "ppt", mediaAssetId: 9, title: "Himno roto" });
    program.setActive(0);
    playToTheEnd("next");
    await vi.waitFor(() => expect(useProjectionStore.getState().base).toBeNull());
    expect(useProjectionStore.getState().overlay).toBe("logo");
    expect(useProgramStore.getState().activeIndex).toBeNull();
  } finally {
    useDeckStore.setState({ ensure });
  }
});

/** A three-slide deck live on its last slide, auto-advancing or not. */
function deckOnLastSlide(deckEnd: VideoEndAction, autoAdvance = false) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, "projection.deckEnd": deckEnd } });
  const slides = [1, 2, 3].map((index) => ({
    index,
    url: slideUrl(500, index),
    thumbUrl: `${slideUrl(500, index)}/thumb`,
    modelUrl: null,
    advanceAfterMs: autoAdvance ? 2000 : null,
    transition: null,
  }));
  const store = useProjectionStore.getState();
  const deck = { assetId: 9, deckId: 500, slides, soundtrack: null, sounds: [], videos: [], autoAdvance, cumulativeMs: buildCumulativeMs(slides) };
  store.setLiveDeck(deck);
  store.setBase({ kind: "deck", assetId: 9, slideIndex: 3 });
  if (autoAdvance) store.setAutoplay("playing");
}

test("a deck that finishes on its own clears to the logo by default, as before the setting existed", () => {
  deckOnLastSlide("logo", true);
  useProjectionStore.getState().setAutoplay("finished");
  expect(useProjectionStore.getState().base).toBeNull();
  expect(useProjectionStore.getState().overlay).toBe("logo");
});

test("one step past the last slide ends the deck too — under BLACK if that is the choice", () => {
  deckOnLastSlide("black");
  advanceSlide(1);
  expect(useProjectionStore.getState().base).toBeNull();
  expect(useProjectionStore.getState().overlay).toBe("black");
});

test("a held key's repeat never ends the deck: only a fresh press does", () => {
  deckOnLastSlide("logo");
  advanceSlide(1, true);
  expect(useProjectionStore.getState().base?.kind).toBe("deck");
});

test("«Quedarse en la última diapositiva» leaves it there, on its own or stepped past", () => {
  deckOnLastSlide("hold", true);
  useProjectionStore.getState().setAutoplay("finished");
  advanceSlide(1);
  const { base, overlay } = useProjectionStore.getState();
  expect(base?.kind === "deck" && base.slideIndex).toBe(3);
  expect(overlay).toBe("none");
});

test("«Volver a la primera diapositiva» starts it over, and an auto-advancing one plays again", () => {
  deckOnLastSlide("loop", true);
  useProjectionStore.getState().setAutoplay("finished");
  const { base, autoplay } = useProjectionStore.getState();
  expect(base?.kind === "deck" && base.slideIndex).toBe(1);
  expect(autoplay).toBe("playing");
});

test("«Pasar al siguiente del programa» sends the next row; under BLACK it only clears", async () => {
  const program = useProgramStore.getState();
  program.clear();
  program.addItem({ kind: "plate", overlayPlateId: 1, title: "Zócalo" });
  program.addItem({
    kind: "bible",
    bibleVersionId: null,
    bibleBookId: null,
    chapter: null,
    verseFrom: null,
    verseTo: null,
    reference: "Juan 3:16",
    text: "Porque de tal manera amó Dios al mundo",
  });
  program.setActive(0);
  deckOnLastSlide("next");
  advanceSlide(1);
  await vi.waitFor(() => expect(useProjectionStore.getState().base?.kind).toBe("bible"));

  program.setActive(0);
  deckOnLastSlide("next");
  useProjectionStore.getState().setOverlay("black");
  advanceSlide(1);
  expect(useProjectionStore.getState().base).toBeNull();
  expect(useProjectionStore.getState().overlay).toBe("black");
});
