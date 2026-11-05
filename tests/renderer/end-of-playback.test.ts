/**
 * What the projector does when a live video reaches its end on its own —
 * `projection.videoEnd`, mirrored into the projection store.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startEndOfPlaybackEffects } from "@renderer/effects/end-of-playback";
import { useProgramStore } from "@renderer/stores/program.store";
import { selectOutput, useProjectionStore } from "@renderer/stores/projection.store";
import type { VideoEndAction } from "@shared/types/projection";
import { assetUrl } from "@shared/urls";

const initialState = useProjectionStore.getState();
let stop: () => void = () => undefined;

beforeEach(() => {
  useProjectionStore.setState(initialState, true);
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

test("«Quedarse en el último cuadro» leaves the video where it ended", () => {
  const state = playToTheEnd("hold");
  expect(state.base?.kind).toBe("video");
  expect(state.overlay).toBe("none");
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
