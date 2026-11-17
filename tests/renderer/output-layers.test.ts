/**
 * `nextLayers`: what `OutputView` stacks after each push, driven through the real store and `selectOutput`.
 *
 * The rule it pins (audit A2, owner 2026-11-12: never black in between): while a new video waits for its first
 * frame, the picture the room sees is the outgoing layer, and only that frame (or the hold's cap) takes it down. A push
 * of the same scene during the wait (the LIVE fader, a pause, a plate) used to drop it and leave the video's empty box
 * on the projector; a new scene used to replace the held picture with the video that never drew.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { entryOf, nextLayers, type Layer, type LayerHold, type LayerStep } from "@renderer/lib/output-layers";
import { buildCumulativeMs, selectOutput, useProjectionStore, type LiveDeck } from "@renderer/stores/projection.store";
import { slideUrl } from "@shared/urls";
import type { DeckSlide } from "@shared/types/deck";
import { DEFAULT_PLATE_STYLE, type Plate } from "@shared/types/overlay";
import type { ProjectionOutput } from "@shared/types/projection";

const initialState = useProjectionStore.getState();
const store = () => useProjectionStore.getState();
const out = (): ProjectionOutput => selectOutput(store());

function goImage(assetId: number) {
  store().beginScene();
  store().setBase({ kind: "image", assetId });
  store().setOverlay("none");
}

function goVideo(assetId: number, epoch: number) {
  store().beginScene();
  store().setBase({ kind: "video", assetId, url: `worship://asset/${assetId}`, epoch, startAtSeconds: 0 });
  store().setOverlay("none");
}

function overlay(kind: "black" | "logo" | "none") {
  store().beginScene();
  store().setOverlay(kind);
}

const PLATE: Plate = {
  id: 1,
  name: "Pastor",
  kind: "lower-third",
  position: "bottom-left",
  title: "Juan Pérez",
  subtitle: "Pastor",
  imageAssetId: null,
  style: DEFAULT_PLATE_STYLE,
};

/** What `OutputView` keeps between pushes, and what it does with each step's hold. */
function stage(options: { animate?: boolean; videoMounted?: boolean } = {}) {
  const first = out();
  let layers: Layer[] = [{ seq: 0, output: first }];
  let hold: LayerHold | null = null;
  let lastEpoch = first.transition.epoch;
  let lastEnterSeq = entryOf(first)?.seq ?? null;
  let seq = 0;
  let ready: number | null = null;
  return {
    push(frozenFrame: HTMLCanvasElement | null = null): LayerStep {
      const output = out();
      const step = nextLayers({
        layers,
        hold,
        output,
        lastEpoch,
        lastEnterSeq,
        nextSeq: seq + 1,
        frozenFrame,
        animate: options.animate ?? true,
        videoMounted: options.videoMounted ?? true,
        readyVideoEpoch: ready,
      });
      lastEpoch = output.transition.epoch;
      lastEnterSeq = entryOf(output)?.seq ?? null;
      layers = step.layers;
      if (step.kind === "steady") hold = null;
      if (step.kind === "transition") {
        hold = step.hold;
        seq = step.layers[1].seq;
      }
      return step;
    },
    firstFrame(epoch: number) {
      ready = epoch;
      if (hold?.epoch === epoch) hold = null;
    },
    get hold() {
      return hold;
    },
  };
}

const kinds = (step: LayerStep) => step.layers.map((layer) => layer.output.kind);

beforeEach(() => {
  useProjectionStore.setState(initialState, true);
  store().setTransitionSettings("crossfade", 300);
});

describe("a new video holds the picture on screen", () => {
  test("GO LIVE of a video over an image: two layers, held for the video's epoch with the image as the one leaving", () => {
    goImage(1);
    const view = stage();
    goVideo(2, 50);
    const step = view.push();
    expect(step.kind).toBe("transition");
    expect(kinds(step)).toEqual(["image", "video"]);
    expect(view.hold).toEqual({ epoch: 50, seq: step.layers[0].seq, durationMs: 300 });
  });

  test("a video whose first frame already arrived does not hold", () => {
    goImage(1);
    const view = stage();
    view.firstFrame(51);
    goVideo(2, 51);
    expect(view.push().kind).toBe("transition");
    expect(view.hold).toBeNull();
  });

  test("a monitor showing a still mounts no video, so nothing holds", () => {
    goImage(1);
    const view = stage({ videoMounted: false });
    goVideo(2, 52);
    view.push();
    expect(view.hold).toBeNull();
  });

  test("a cut into a video holds too, and a cut into anything else is one layer at once", () => {
    store().setTransitionSettings("none", 0);
    goImage(1);
    const view = stage();
    goVideo(2, 53);
    const held = view.push();
    expect(held.kind).toBe("transition");
    expect(view.hold?.epoch).toBe(53);
    goImage(3);
    const cut = view.push();
    expect(cut.kind).toBe("steady");
    expect(kinds(cut)).toEqual(["image"]);
  });
});

describe("the same scene during the hold keeps the picture on screen (A2)", () => {
  function heldVideo() {
    goImage(1);
    const view = stage();
    goVideo(2, 60);
    const held = view.push();
    return { view, image: held.layers[0], video: held.layers[1]! };
  }

  test("the LIVE fader: the image stays as it was, the video takes the push in place, the hold goes on", () => {
    const { view, image, video } = heldVideo();
    store().setLiveMasterVolume(0.8);
    const step = view.push();
    expect(step.kind).toBe("patch");
    expect(step.layers[0]).toBe(image);
    expect(step.layers[1]!.seq).toBe(video.seq);
    expect(step.layers[1]!.output.videoUnderlay?.volume).not.toBe(video.output.videoUnderlay?.volume);
    expect(view.hold?.epoch).toBe(60);
  });

  test("the video's own volume and its pause", () => {
    const { view, image } = heldVideo();
    store().setVideoVolume(0.4);
    expect(view.push()).toMatchObject({ kind: "patch", layers: [image, expect.anything()] });
    store().setVideoPaused(true);
    expect(view.push()).toMatchObject({ kind: "patch", layers: [image, expect.anything()] });
    expect(view.hold?.epoch).toBe(60);
  });

  test("a plate going up, or the strips' meters turned on", () => {
    const { view, image } = heldVideo();
    store().showPlate(PLATE);
    expect(view.push()).toMatchObject({ kind: "patch", layers: [image, expect.anything()] });
    store().setLiveMeters(true);
    expect(view.push()).toMatchObject({ kind: "patch", layers: [image, expect.anything()] });
  });

  test("after the first frame the same push is an ordinary one: the fade runs and nothing is held", () => {
    const { view } = heldVideo();
    view.firstFrame(60);
    store().setLiveMasterVolume(0.5);
    const step = view.push();
    expect(step.kind).toBe("patch"); // the fade is still in flight
    expect(view.hold).toBeNull();
  });
});

describe("a new scene during the hold replaces the video that never drew, not the picture (A2)", () => {
  test("another video: the image is still what leaves, and the hold waits for the new video", () => {
    goImage(1);
    const view = stage();
    goVideo(2, 70);
    const image = view.push().layers[0];
    goVideo(4, 71);
    const neverDrawn = document.createElement("canvas");
    const step = view.push(neverDrawn);
    expect(step.kind).toBe("transition");
    expect(step.layers[0]).toBe(image);
    expect(step.layers[0].frozenFrame).not.toBe(neverDrawn);
    expect(step.layers[1]!.output.videoUnderlay?.epoch).toBe(71);
    expect(view.hold).toEqual({ epoch: 71, seq: image.seq, durationMs: 300 });
  });

  test("an image: the held image fades into it, nothing held", () => {
    goImage(1);
    const view = stage();
    goVideo(2, 72);
    const image = view.push().layers[0];
    goImage(3);
    const step = view.push();
    expect(step.layers[0]).toBe(image);
    expect(kinds(step)).toEqual(["image", "image"]);
    expect(view.hold).toBeNull();
  });

  test("BLACK: the image fades to black and the video stays under it, no longer waited for", () => {
    goImage(1);
    const view = stage();
    goVideo(2, 73);
    const image = view.push().layers[0];
    overlay("black");
    const step = view.push();
    expect(step.layers[0]).toBe(image);
    expect(kinds(step)).toEqual(["image", "black"]);
    expect(step.layers[1]!.output.videoUnderlay?.epoch).toBe(73);
    expect(view.hold).toBeNull();
  });
});

describe("a fade in flight", () => {
  test("a same-scene push keeps it running instead of cutting it (A2)", () => {
    goImage(1);
    const view = stage();
    goImage(3);
    const fading = view.push();
    store().setLiveMeters(true);
    const step = view.push();
    expect(step.kind).toBe("patch");
    expect(step.layers[0]).toBe(fading.layers[0]);
    expect(step.layers[1]!.seq).toBe(fading.layers[1]!.seq);
  });

  test("a second new scene replaces the pair: what was entering is what leaves now", () => {
    goImage(1);
    const view = stage();
    goImage(3);
    const first = view.push();
    goImage(4);
    const step = view.push();
    expect(step.kind).toBe("transition");
    expect(step.layers[0].seq).toBe(first.layers[1]!.seq);
    expect(step.layers[1]!.seq).toBe(first.layers[1]!.seq + 1);
  });

  test("leaving a video hangs its last frame on the layer that leaves", () => {
    goVideo(2, 80);
    const view = stage();
    view.firstFrame(80);
    goImage(1);
    const frame = document.createElement("canvas");
    const step = view.push(frame);
    expect(step.layers[0].frozenFrame).toBe(frame);
  });
});

describe("a push that moves the picture mid-fade is the cut it always was", () => {
  const THROUGH_BLACK = { style: "fade-through-black" as const, durationMs: 800 };
  function liveDeck(): void {
    const slides: DeckSlide[] = [1, 2, 3].map((index) => ({
      index,
      url: slideUrl(500, index),
      thumbUrl: `${slideUrl(500, index)}/thumb`,
      modelUrl: null,
      advanceAfterMs: null,
      transition: THROUGH_BLACK,
    }));
    const deck: LiveDeck = {
      assetId: 9,
      deckId: 500,
      slides,
      soundtrack: null,
      sounds: [],
      videos: [],
      cumulativeMs: buildCumulativeMs(slides),
      autoAdvance: false,
    };
    store().beginScene();
    store().setLiveDeck(deck);
    store().setBase({ kind: "deck", assetId: 9, slideIndex: 2 });
    store().setOverlay("none");
  }

  test("back a slide while the next one fades in through black: a cut, not a dip into black (owner, 2026-10-26)", () => {
    liveDeck();
    const view = stage();
    store().setSlideIndex(3);
    expect(view.push().kind).toBe("transition");
    store().setSlideIndex(2);
    const step = view.push();
    expect(step.kind).toBe("steady");
    expect(step.layers[0].output.kind === "slide" && step.layers[0].output.url).toBe(slideUrl(500, 2));
  });

  test("a plate mid-fade lets the same slide's fade run", () => {
    liveDeck();
    const view = stage();
    store().setSlideIndex(3);
    view.push();
    store().showPlate(PLATE);
    expect(view.push().kind).toBe("patch");
  });
});

describe("one layer, nothing in flight", () => {
  test("a plate alone over a steady image is not a scene", () => {
    goImage(1);
    const view = stage();
    store().showPlate(PLATE);
    const step = view.push();
    expect(step.kind).toBe("steady");
    expect(step.layers[0].seq).toBe(0);
  });

  test("BLACK → LOGO over a video: a fade between the two covers, nothing held", () => {
    goVideo(2, 90);
    const view = stage();
    view.firstFrame(90);
    overlay("black");
    view.push();
    overlay("logo");
    const step = view.push();
    expect(kinds(step)).toEqual(["black", "logo"]);
    expect(view.hold).toBeNull();
  });

  test("a push that begins a scene without changing the picture does not fade into a copy of itself", () => {
    goImage(1);
    const view = stage();
    store().beginScene();
    const step = view.push();
    expect(step.kind).toBe("steady");
  });

  test("PREVIEW never stacks, not even over a video that has no frame", () => {
    goImage(1);
    const view = stage({ animate: false });
    goVideo(2, 91);
    expect(view.push().kind).toBe("steady");
    expect(view.hold).toBeNull();
  });
});
