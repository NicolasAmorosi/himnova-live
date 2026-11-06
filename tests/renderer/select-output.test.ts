/**
 * `selectOutput` — the single source of what the projector shows.
 *
 * Everything the congregation sees is this function's return value, so its
 * invariants are the app's: the overlay wins over the base, a deck that is not
 * ready is black rather than a broken tile, and — the one that cost a
 * hardware-decoder crash to learn — a video keeps its element alive UNDER
 * BLACK instead of being torn down and rebuilt on every toggle.
 *
 * `selectOutputMemo` gets its own block because its whole reason for existing
 * is a negative: the busiest writer in the store (`setMediaStatus`, ~4 Hz per
 * playing element) must not produce a new output object.
 */
import { beforeEach, describe, expect, test } from "vitest";
import {
  buildCumulativeMs,
  selectOutput,
  selectOutputMemo,
  useProjectionStore,
  type LiveDeck,
} from "@renderer/stores/projection.store";
import { LOGO_URL, assetUrl, slideUrl } from "@shared/urls";
import type { DeckSlide, DeckSlideVideo } from "@shared/types/deck";
import { DEFAULT_BIBLE_STYLE } from "@shared/types/bible-style";
import { DEFAULT_SCENE_STYLE } from "@shared/types/scene-style";
import { DEFAULT_SETTINGS, logoLook } from "@shared/types/settings";
import { DEFAULT_TIMER_FORMAT } from "@shared/types/timer";
import type { UtilityScene } from "@shared/types/utility";

const initialState = useProjectionStore.getState();

function output() {
  return selectOutput(useProjectionStore.getState());
}

function slide(
  index: number,
  advanceAfterMs: number | null = null,
  transition: DeckSlide["transition"] = null,
): DeckSlide {
  return {
    index,
    url: slideUrl(500, index),
    thumbUrl: `${slideUrl(500, index)}/thumb`,
    modelUrl: null,
    advanceAfterMs,
    transition,
  };
}

function deckOf(assetId: number, slideCount: number, videos: DeckSlideVideo[] = []): LiveDeck {
  const slides = Array.from({ length: slideCount }, (_, i) => slide(i + 1));
  return {
    assetId,
    deckId: 500,
    slides,
    soundtrack: null,
    sounds: [],
    videos,
    cumulativeMs: buildCumulativeMs(slides),
    autoAdvance: false,
  };
}

function slideVideoOn(slideIndex: number, overrides: Partial<DeckSlideVideo> = {}): DeckSlideVideo {
  return {
    slideIndex,
    url: `worship://deck-video/${slideIndex}`,
    rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    aspectRatio: 16 / 9,
    loop: false,
    volume: 0.8,
    name: "1.mp4",
    ...overrides,
  };
}

function scene(overrides: Partial<UtilityScene> = {}): UtilityScene {
  return {
    id: 1,
    name: "Cuenta 10 minutos",
    tool: "countdown",
    config: { durationMs: 600_000, targetMinuteOfDay: 600, endMessage: null, format: DEFAULT_TIMER_FORMAT },
    style: DEFAULT_SCENE_STYLE,
    title: "El culto comienza en",
    message: null,
    ...overrides,
  };
}

beforeEach(() => {
  useProjectionStore.setState(initialState, true);
});

describe("the overlay wins over the base", () => {
  test("BLACK is black whatever is selected", () => {
    useProjectionStore.getState().setBase({ kind: "image", assetId: 3 });
    useProjectionStore.getState().setOverlay("black");
    expect(output().kind).toBe("black");
  });

  test("LOGO with no logo chosen is a null url, never a url that 404s", () => {
    // The bare `worship://logo` this used to fall back to is answered with a
    // 404 whenever `logo.path` is unset, so the projector painted the
    // browser's broken-image icon and reported a media error for a file
    // nobody had ever picked. A null url paints the layer's own black.
    useProjectionStore.getState().setOverlay("logo");
    expect(output()).toMatchObject({ kind: "logo", url: null });

    useProjectionStore.getState().setLogoUrl("worship://asset/77");
    expect(output()).toMatchObject({ kind: "logo", url: "worship://asset/77" });
  });

  test("LOGO without an image carries its scene — the name, and its background's url", () => {
    useProjectionStore.getState().setLogoScene({ name: "Iglesia Central", background: { kind: "image", assetId: 9, fit: "cover" } });
    expect(output()).toMatchObject({
      kind: "logo",
      url: null,
      scene: { name: "Iglesia Central" },
      backgroundUrl: assetUrl(9),
    });
  });

  test("logoLook: the chosen mode decides, and an install that never chose shows its image when it has one", () => {
    const base = {
      "logo.path": "/logo.png",
      "logo.mode": null,
      "logo.name": "Iglesia Central",
      "logo.background": { kind: "solid", color: "#123456" },
    } as const;
    const bare = { name: null, background: DEFAULT_SETTINGS["logo.background"] };
    expect(logoLook(base)).toEqual({ url: `${LOGO_URL}?p=%2Flogo.png`, scene: bare });
    expect(logoLook({ ...base, "logo.path": null }).scene.name).toBe("Iglesia Central");
    // «Nombre sobre fondo» with an image loaded: the image is not shown.
    expect(logoLook({ ...base, "logo.mode": "name" })).toEqual({
      url: null,
      scene: { name: "Iglesia Central", background: base["logo.background"] },
    });
    // «Imagen» with no image yet: a bare black LOGO, never the name.
    expect(logoLook({ ...base, "logo.mode": "image", "logo.path": null })).toEqual({ url: null, scene: bare });
  });

  test("turning «loop» on with a video live rebuilds the memoized output; another end action does not", () => {
    const store = useProjectionStore.getState();
    store.setBase({ kind: "video", assetId: 5, url: assetUrl(5), epoch: 2, startAtSeconds: 0 });
    const before = selectOutputMemo(useProjectionStore.getState());
    store.setVideoEnd("black");
    expect(selectOutputMemo(useProjectionStore.getState())).toBe(before);
    store.setVideoEnd("loop");
    expect(selectOutputMemo(useProjectionStore.getState()).videoUnderlay?.loop).toBe(true);
  });

  test("nothing selected at all is the logo, never a black screen", () => {
    // What the projector shows between items of a service: the church's logo
    // is the resting state, and "no signal" is not a thing the congregation
    // should ever see.
    useProjectionStore.getState().setLogoUrl(`${LOGO_URL}?p=%2Flogo.png`);
    expect(output()).toMatchObject({ kind: "logo", url: `${LOGO_URL}?p=%2Flogo.png` });
  });
});

describe("each kind of base content", () => {
  test("an image", () => {
    useProjectionStore.getState().setBase({ kind: "image", assetId: 12 });
    expect(output()).toMatchObject({ kind: "image", url: assetUrl(12) });
  });

  test("a verse carries its text, reference and version label, not an id", () => {
    useProjectionStore.getState().setBase({
      kind: "bible",
      text: "En el principio…",
      reference: "Génesis 1:1",
      versionLabel: "RV1960",
    });
    expect(output()).toMatchObject({
      kind: "bible",
      text: "En el principio…",
      reference: "Génesis 1:1",
      versionLabel: "RV1960",
    });
  });

  test("a verse is dressed by the mirrored style, background url resolved", () => {
    const store = useProjectionStore.getState();
    store.setBase({ kind: "bible", text: "Jesús lloró.", reference: "Juan 11:35", versionLabel: null });

    // The default style has no image background, so nothing to resolve.
    expect(output()).toMatchObject({ kind: "bible", style: DEFAULT_BIBLE_STYLE, backgroundUrl: null });

    store.setBibleStyle({ ...DEFAULT_BIBLE_STYLE, background: { kind: "image", assetId: 7, fit: "cover" } });
    expect(output()).toMatchObject({ kind: "bible", backgroundUrl: assetUrl(7) });
  });

  test("an image background with no file yet resolves to no url at all", () => {
    const store = useProjectionStore.getState();
    store.setBase({ kind: "bible", text: "Jesús lloró.", reference: "Juan 11:35", versionLabel: null });
    // `assetId: 0` is the sentinel the editor writes before a picture is
    // picked. A url for it would 404 and paint a broken-image glyph over the
    // verse — the same rule `timerOutputFor` follows.
    store.setBibleStyle({ ...DEFAULT_BIBLE_STYLE, background: { kind: "image", assetId: 0, fit: "cover" } });
    expect(output()).toMatchObject({ kind: "bible", backgroundUrl: null });
  });

  test("restyling a live verse never begins a new scene", () => {
    const store = useProjectionStore.getState();
    store.setBase({ kind: "bible", text: "Jesús lloró.", reference: "Juan 11:35", versionLabel: null });
    const epoch = output().transition.epoch;

    // Editing the look of what is ALREADY live patches it in place, exactly
    // like `setLiveScene` does for a time scene: a bumped epoch would fade the
    // verse into a near-identical copy of itself in the middle of a service.
    store.setBibleStyle({ ...DEFAULT_BIBLE_STYLE, textAlign: "left" });
    expect(output()).toMatchObject({ kind: "bible", style: { textAlign: "left" } });
    expect(output().transition.epoch).toBe(epoch);
  });

  test("a video, with its epoch", () => {
    useProjectionStore.getState().setBase({ kind: "video", assetId: 5, url: assetUrl(5), epoch: 2, startAtSeconds: 0 });
    expect(output()).toMatchObject({ kind: "video", url: assetUrl(5), epoch: 2 });
  });

  test("a deck slide carries its position and warms its neighbours", () => {
    const store = useProjectionStore.getState();
    store.setLiveDeck(deckOf(9, 5));
    store.setBase({ kind: "deck", assetId: 9, slideIndex: 3 });

    expect(output()).toMatchObject({
      kind: "slide",
      deckAssetId: 9,
      url: slideUrl(500, 3),
      index: 3,
      total: 5,
      // The next slide first: a slide change must never wait on a decode.
      preload: [slideUrl(500, 4), slideUrl(500, 2)],
    });
  });

  test("a deck slide carries the fallback face and the interface language; changing them is no new scene", () => {
    const store = useProjectionStore.getState();
    store.setLiveDeck(deckOf(9, 5));
    store.setBase({ kind: "deck", assetId: 9, slideIndex: 2 });
    const epoch = useProjectionStore.getState().sceneEpoch;
    store.setSlideText({ fallbackFont: "Carlito", locale: "it" });
    expect(output()).toMatchObject({ kind: "slide", index: 2, text: { fallbackFont: "Carlito", locale: "it" } });
    // Restyled in place, like the verse: no fade into a copy of itself.
    expect(useProjectionStore.getState().sceneEpoch).toBe(epoch);
  });

  test("the slide index is clamped to the deck", () => {
    const store = useProjectionStore.getState();
    store.setLiveDeck(deckOf(9, 3));
    store.setBase({ kind: "deck", assetId: 9, slideIndex: 99 });
    expect(output()).toMatchObject({ index: 3, total: 3 });
  });
});

describe("a deck that is not ready is black, never a broken tile", () => {
  test("no deck loaded yet", () => {
    useProjectionStore.getState().setBase({ kind: "deck", assetId: 9, slideIndex: 1 });
    expect(output().kind).toBe("black");
  });

  test("the loaded deck belongs to another asset", () => {
    const store = useProjectionStore.getState();
    store.setLiveDeck(deckOf(4, 2));
    store.setBase({ kind: "deck", assetId: 9, slideIndex: 1 });
    expect(output().kind).toBe("black");
  });

  test("a deck with no slides", () => {
    const store = useProjectionStore.getState();
    store.setLiveDeck(deckOf(9, 0));
    store.setBase({ kind: "deck", assetId: 9, slideIndex: 1 });
    expect(output().kind).toBe("black");
  });
});

describe("the video underlay survives the overlay", () => {
  // The element is kept mounted under BLACK/LOGO instead of being destroyed
  // and recreated: repeatedly tearing down a `<video>` is what produced
  // `PIPELINE_ERROR_DECODE` in Chromium's hardware decoder after a few cycles.
  test("a video under BLACK is still described, so its element stays alive", () => {
    const store = useProjectionStore.getState();
    store.setBase({ kind: "video", assetId: 5, url: assetUrl(5), epoch: 2, startAtSeconds: 12 });
    store.setOverlay("black");

    const out = output();
    expect(out.kind).toBe("black");
    expect(out.videoUnderlay).toMatchObject({ url: assetUrl(5), epoch: 2, startAtSeconds: 12 });
  });

  test("pause and volume travel as state, not as a command", () => {
    const store = useProjectionStore.getState();
    store.setBase({ kind: "video", assetId: 5, url: assetUrl(5), epoch: 1, startAtSeconds: 0 });
    useProjectionStore.getState().setVideoPaused(true);
    useProjectionStore.getState().setVideoVolume(0.4);

    expect(output().videoUnderlay).toMatchObject({ paused: true, volume: 0.4 });
  });

  test("the volume is clamped in the store, never at the call site", () => {
    const store = useProjectionStore.getState();
    store.setBase({ kind: "video", assetId: 5, url: assetUrl(5), epoch: 1, startAtSeconds: 0 });
    useProjectionStore.getState().setVideoVolume(1.4);
    expect(output().videoUnderlay).toMatchObject({ volume: 1 });
    useProjectionStore.getState().setVideoVolume(-0.2);
    expect(output().videoUnderlay).toMatchObject({ volume: 0 });
  });

  test("anything that is not a video has no underlay", () => {
    useProjectionStore.getState().setBase({ kind: "image", assetId: 3 });
    expect(output().videoUnderlay).toBeNull();
  });

  test("sending something new live resets an operator's pause", () => {
    const store = useProjectionStore.getState();
    store.setBase({ kind: "video", assetId: 5, url: assetUrl(5), epoch: 1, startAtSeconds: 0 });
    useProjectionStore.getState().setVideoPaused(true);
    useProjectionStore.getState().setBase({ kind: "video", assetId: 6, url: assetUrl(6), epoch: 2, startAtSeconds: 0 });
    expect(output().videoUnderlay).toMatchObject({ paused: false });
  });

  test("moving the resume point does not remount the element", () => {
    // `setVideoResumeAt` patches `base` in place: a new epoch is what remounts
    // the `<video>`, and nothing about what the projector shows changed here.
    const store = useProjectionStore.getState();
    store.setBase({ kind: "video", assetId: 5, url: assetUrl(5), epoch: 3, startAtSeconds: 0 });
    useProjectionStore.getState().setVideoResumeAt(42);

    expect(output().videoUnderlay).toMatchObject({ epoch: 3, startAtSeconds: 42 });
  });

  test("the resume point is ignored when the base is not a video", () => {
    useProjectionStore.getState().setBase({ kind: "image", assetId: 3 });
    useProjectionStore.getState().setVideoResumeAt(42);
    expect(useProjectionStore.getState().base).toMatchObject({ kind: "image", assetId: 3 });
  });
});

describe("a video embedded in the live slide", () => {
  // The whole reason `slideVideo` is a top-level field of `ProjectionOutput`
  // and not part of the `slide` variant: under BLACK the output kind is
  // "black", and a video that lived inside the variant would vanish from the
  // push — unmounting the element, losing its position and rebuilding the
  // decoder on every single toggle.
  test("it is described only on the slide that carries it", () => {
    const store = useProjectionStore.getState();
    store.setLiveDeck(deckOf(9, 4, [slideVideoOn(2)]));
    store.setBase({ kind: "deck", assetId: 9, slideIndex: 1 });
    expect(output().slideVideo).toBeNull();

    useProjectionStore.getState().setSlideIndex(2);
    expect(output().slideVideo).toMatchObject({
      url: "worship://deck-video/2",
      rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      loop: false,
    });

    useProjectionStore.getState().setSlideIndex(3);
    expect(output().slideVideo).toBeNull();
  });

  test("BLACK covers it without taking it away", () => {
    const store = useProjectionStore.getState();
    store.setLiveDeck(deckOf(9, 4, [slideVideoOn(2)]));
    store.setBase({ kind: "deck", assetId: 9, slideIndex: 2 });
    const epochBefore = output().slideVideo?.epoch;

    useProjectionStore.getState().setOverlay("black");

    const out = output();
    expect(out.kind).toBe("black");
    // Still described, and still the SAME element: an overlay that bumped the
    // epoch would restart the clip every time the operator pressed BLACK.
    expect(out.slideVideo).not.toBeNull();
    expect(out.slideVideo?.epoch).toBe(epochBefore);
  });

  test("a new slide is a new element", () => {
    const store = useProjectionStore.getState();
    store.setLiveDeck(deckOf(9, 4, [slideVideoOn(2), slideVideoOn(3)]));
    store.setBase({ kind: "deck", assetId: 9, slideIndex: 2 });
    const first = output().slideVideo?.epoch;

    useProjectionStore.getState().setSlideIndex(3);
    expect(output().slideVideo?.epoch).not.toBe(first);
  });

  test("pause and volume travel as state, and a new slide resets both", () => {
    const store = useProjectionStore.getState();
    store.setLiveDeck(deckOf(9, 4, [slideVideoOn(2), slideVideoOn(3)]));
    store.setBase({ kind: "deck", assetId: 9, slideIndex: 2 });

    useProjectionStore.getState().setSlideVideoPaused(true);
    useProjectionStore.getState().setSlideVideoVolume(0.3);
    expect(output().slideVideo).toMatchObject({ paused: true, volume: 0.3 });

    useProjectionStore.getState().setSlideIndex(3);
    // Back to playing, and back to the level the FILE asks for — not to the
    // one the operator balanced for the previous clip.
    expect(output().slideVideo).toMatchObject({ paused: false, volume: 0.8 });
  });

  test("the file's own level applies until the operator sets one", () => {
    const store = useProjectionStore.getState();
    store.setLiveDeck(deckOf(9, 2, [slideVideoOn(1, { volume: 0.4 })]));
    store.setBase({ kind: "deck", assetId: 9, slideIndex: 1 });
    expect(output().slideVideo).toMatchObject({ volume: 0.4 });

    useProjectionStore.getState().setSlideVideoVolume(1);
    expect(output().slideVideo).toMatchObject({ volume: 1 });
  });

  test("a deck the store has not loaded yet has no slide video", () => {
    const store = useProjectionStore.getState();
    store.setLiveDeck(deckOf(9, 2, [slideVideoOn(1)]));
    // Another deck's id: the same guard that makes an out-of-sync deck black
    // rather than a broken tile.
    store.setBase({ kind: "deck", assetId: 11, slideIndex: 1 });
    expect(output().slideVideo).toBeNull();
  });

  test("the slide video is an input of the memo", () => {
    const store = useProjectionStore.getState();
    store.setLiveDeck(deckOf(9, 2, [slideVideoOn(1)]));
    store.setBase({ kind: "deck", assetId: 9, slideIndex: 1 });
    const before = selectOutputMemo(useProjectionStore.getState());

    useProjectionStore.getState().setSlideVideoPaused(true);
    expect(selectOutputMemo(useProjectionStore.getState())).not.toBe(before);
  });
});

describe("the scene transition", () => {
  test("navigating within what is live is an instant cut", () => {
    const store = useProjectionStore.getState();
    store.setLiveDeck(deckOf(9, 5));
    store.setBase({ kind: "deck", assetId: 9, slideIndex: 1 });
    const before = output().transition.epoch;

    useProjectionStore.getState().setSlideIndex(2);
    expect(output().transition.epoch).toBe(before);
  });

  test("beginning a scene is what makes the projector fade", () => {
    const before = output().transition.epoch;
    useProjectionStore.getState().beginScene();
    expect(output().transition.epoch).toBe(before + 1);
  });

  test("a new scene retires the scene and video error notices, but not audio's", () => {
    // Re-sending the very same file has to be a real retry; an audio track's
    // notice belongs to the track list's lifecycle instead.
    const store = useProjectionStore.getState();
    store.setMediaError({ target: { kind: "scene" }, url: "worship://asset/1", code: null });
    store.setMediaError({ target: { kind: "video" }, url: "worship://asset/2", code: 4 });
    store.setMediaError({ target: { kind: "audio", trackId: "asset:3:1" }, url: "worship://asset/3", code: 4 });

    useProjectionStore.getState().beginScene();
    expect(Object.keys(useProjectionStore.getState().mediaErrors)).toEqual(["audio:asset:3:1"]);
  });
});

describe("a slide's own way in", () => {
  // Within a deck the file's transitions play, but only FORWARD (decided by
  // the owner, 2026-10-26): back is a cut, and the first slide of a scene keeps
  // the scene's fade.
  const FADE = { style: "crossfade" as const, durationMs: 1000 };
  const BARS = { style: "random-bars-vertical" as const, durationMs: 750 };

  function hymn(): LiveDeck {
    const slides = [slide(1, null, FADE), slide(2, null, BARS), slide(3, null, null)];
    return { ...deckOf(9, 3), slides, cumulativeMs: buildCumulativeMs(slides) };
  }

  function enter() {
    const out = output();
    return out.kind === "slide" ? out.enter : undefined;
  }

  beforeEach(() => {
    const store = useProjectionStore.getState();
    store.setLiveDeck(hymn());
    store.setBase({ kind: "deck", assetId: 9, slideIndex: 1 });
  });

  test("the first slide of a scene enters with the scene, not with its own", () => {
    expect(enter()).toBeNull();
  });

  test("moving forward plays the transition of the slide arriving, as its own move", () => {
    useProjectionStore.getState().setSlideIndex(2);
    const first = enter();
    expect(first).toMatchObject(BARS);
    useProjectionStore.getState().setSlideIndex(3);
    expect(enter()).toBeNull(); // the third slide has none: a cut
  });

  test("going back is a cut, whatever the slide it lands on has", () => {
    useProjectionStore.getState().setSlideIndex(3);
    useProjectionStore.getState().setSlideIndex(2);
    expect(enter()).toBeNull();
  });

  test("a push that re-sends the same slide carries the same move, so nothing replays", () => {
    useProjectionStore.getState().setSlideIndex(2);
    const seq = enter()?.seq;
    useProjectionStore.getState().setSlideVideoVolume(0.3);
    expect(enter()?.seq).toBe(seq);
    useProjectionStore.getState().setSlideIndex(3);
    useProjectionStore.getState().setSlideIndex(2);
    useProjectionStore.getState().setSlideIndex(3);
    useProjectionStore.getState().setSlideIndex(2);
    expect(enter()).toBeNull();
  });

  test("two moves forward onto the same transition are two different moves", () => {
    const store = useProjectionStore.getState();
    store.setLiveDeck({ ...hymn(), slides: [slide(1), slide(2, null, BARS), slide(3, null, BARS)] });
    store.setBase({ kind: "deck", assetId: 9, slideIndex: 1 });
    useProjectionStore.getState().setSlideIndex(2);
    const first = enter()?.seq;
    useProjectionStore.getState().setSlideIndex(3);
    expect(enter()?.seq).not.toBe(first);
  });

  test("a new scene forgets the last move", () => {
    useProjectionStore.getState().setSlideIndex(2);
    useProjectionStore.getState().setBase({ kind: "deck", assetId: 9, slideIndex: 2 });
    expect(enter()).toBeNull();
  });
});

describe("selectOutputMemo", () => {
  test("a media status report does not produce a new output", () => {
    // The whole point: the store's busiest writer touches no field the output
    // reads, and every subscriber uses the default comparator.
    const store = useProjectionStore.getState();
    store.setBase({ kind: "image", assetId: 3 });
    const first = selectOutputMemo(useProjectionStore.getState());

    useProjectionStore.getState().setMediaStatus({
      target: { kind: "video" },
      epoch: 1,
      currentTimeSeconds: 12.5,
      durationSeconds: 300,
      paused: false,
      ended: false,
    });

    expect(selectOutputMemo(useProjectionStore.getState())).toBe(first);
  });

  test("a real change produces a new one", () => {
    const store = useProjectionStore.getState();
    store.setBase({ kind: "image", assetId: 3 });
    const first = selectOutputMemo(useProjectionStore.getState());

    useProjectionStore.getState().setOverlay("black");
    const second = selectOutputMemo(useProjectionStore.getState());

    expect(second).not.toBe(first);
    expect(second.kind).toBe("black");
  });
});

describe("buildCumulativeMs", () => {
  test("slide n hands over at the sum of every advance before it", () => {
    const slides = [slide(1, 1000), slide(2, 2000), slide(3, 500)];
    // Index 0 is unused; `cumulative[1]` is 0, i.e. slide 1 appears at t=0.
    expect(buildCumulativeMs(slides)).toEqual([0, 0, 1000, 3000, 3500]);
  });

  test("a slide with no timing contributes nothing", () => {
    expect(buildCumulativeMs([slide(1, null), slide(2, 1000)])).toEqual([0, 0, 0, 1000]);
  });

  test("an empty deck still yields the two leading zeroes", () => {
    expect(buildCumulativeMs([])).toEqual([0, 0]);
  });
});

/**
 * A utility scene is full-screen base content like any other — and the one
 * whose value changes on its own, which is exactly why none of that change may
 * reach this function. What the projector gets is a fixed mark.
 */
describe("a utility scene on the projector", () => {
  const clock = { mode: "countdown", state: "running", endsAtMs: 1_000 } as const;

  test("the scene reaches the projector resolved, as a mark plus its formatting", () => {
    useProjectionStore.getState().setBase({ kind: "utility", sceneId: 1, scene: scene(), clock });
    const result = output();
    expect(result.kind).toBe("timer");
    if (result.kind !== "timer") throw new Error("unreachable");
    expect(result.clock).toEqual(clock);
    expect(result.title).toBe("El culto comienza en");
    expect(result.format).toEqual(DEFAULT_TIMER_FORMAT);
    // Nothing in the output is a second-by-second value: the projector
    // subtracts against its own clock, and this object never moves.
    expect(JSON.stringify(result)).not.toContain("remaining");
  });

  test("an image background travels as a capability url, never as an id the projector must resolve", () => {
    const withImage = scene({
      style: { ...DEFAULT_SCENE_STYLE, background: { kind: "image", assetId: 42, fit: "cover" } },
    });
    useProjectionStore.getState().setBase({ kind: "utility", sceneId: 1, scene: withImage, clock });
    const result = output();
    expect(result.kind === "timer" && result.backgroundUrl).toBe(assetUrl(42));
  });

  test("a colour background resolves to no url at all", () => {
    useProjectionStore.getState().setBase({ kind: "utility", sceneId: 1, scene: scene(), clock });
    const result = output();
    expect(result.kind === "timer" && result.backgroundUrl).toBeNull();
  });

  test("BLACK covers it and the mark survives underneath, unchanged", () => {
    const store = useProjectionStore.getState();
    store.setBase({ kind: "utility", sceneId: 1, scene: scene(), clock });
    store.setOverlay("black");
    expect(output().kind).toBe("black");

    useProjectionStore.getState().setOverlay("none");
    const result = output();
    // The count is a mark, so being covered costs it nothing: it comes back
    // showing the time that has actually passed, not the time it was covered at.
    expect(result.kind === "timer" && result.clock).toEqual(clock);
  });
});

describe("pausing a timer is not a new scene", () => {
  test("setTimerClock moves the clock without touching the scene epoch", () => {
    const store = useProjectionStore.getState();
    store.beginScene();
    store.setBase({
      kind: "utility",
      sceneId: 1,
      scene: scene(),
      clock: { mode: "countdown", state: "running", endsAtMs: 1_000 },
    });
    const epoch = useProjectionStore.getState().sceneEpoch;

    useProjectionStore.getState().setTimerClock({ mode: "countdown", state: "held", remainingMs: 500 });

    // A bumped epoch here would cross-fade the projector into an almost
    // identical copy of itself, mid-service.
    expect(useProjectionStore.getState().sceneEpoch).toBe(epoch);
    const result = output();
    expect(result.kind === "timer" && result.clock).toEqual({
      mode: "countdown",
      state: "held",
      remainingMs: 500,
    });
  });

  test("it is a no-op when the live content is not this utility", () => {
    const store = useProjectionStore.getState();
    store.setBase({ kind: "image", assetId: 3 });
    const before = selectOutputMemo(useProjectionStore.getState());

    useProjectionStore.getState().setTimerClock({ mode: "countdown", state: "held", remainingMs: 1 });

    // Same object, so nothing is pushed to the projector at all.
    expect(selectOutputMemo(useProjectionStore.getState())).toBe(before);
  });

  test("a running countdown produces no new output as time passes", () => {
    const store = useProjectionStore.getState();
    store.setBase({
      kind: "utility",
      sceneId: 1,
      scene: scene(),
      clock: { mode: "countdown", state: "running", endsAtMs: Date.now() + 600_000 },
    });
    const first = selectOutputMemo(useProjectionStore.getState());
    // The whole design in one assertion: sixty seconds of a running countdown
    // is zero pushes, zero history rows and zero scene transitions.
    expect(selectOutputMemo(useProjectionStore.getState())).toBe(first);
  });
});

/**
 * The F2 gate, as an assertion.
 *
 * Editing a scene that is already on the projector has to change how it looks
 * without being "something new is live": no `beginScene()`, so no transition,
 * and the mark inside `base.clock` untouched, so the count does not restart.
 * Getting this wrong is not a cosmetic bug — it is the projector cross-fading
 * into an almost identical copy of itself, and a countdown jumping back to its
 * full duration, in the middle of a service.
 */
describe("editing the scene that is live", () => {
  const clock = { mode: "countdown", state: "running", endsAtMs: 1_700_000_000_000 } as const;

  test("the new look reaches the projector without a new epoch or a new mark", () => {
    const store = useProjectionStore.getState();
    store.setBase({ kind: "utility", sceneId: 1, scene: scene(), clock });
    const before = output();

    const restyled = scene({
      title: "Empezamos en",
      style: { ...DEFAULT_SCENE_STYLE, verticalAlign: "top" },
    });
    useProjectionStore.getState().setLiveScene(restyled);

    const after = output();
    if (after.kind !== "timer") throw new Error("unreachable");
    expect(after.title).toBe("Empezamos en");
    expect(after.style.verticalAlign).toBe("top");
    // The two things that must NOT have moved.
    expect(after.transition.epoch).toBe(before.transition.epoch);
    expect(after.clock).toEqual(clock);
  });

  test("it is a no-op for a scene that is not the one live", () => {
    const store = useProjectionStore.getState();
    store.setBase({ kind: "utility", sceneId: 1, scene: scene(), clock });
    const before = selectOutputMemo(useProjectionStore.getState());

    // Another scene entirely: editing it must not touch the projector at all,
    // which the memo proves by identity — not one push goes out.
    useProjectionStore.getState().setLiveScene(scene({ id: 2, name: "Otra" }));
    expect(selectOutputMemo(useProjectionStore.getState())).toBe(before);
  });

  test("re-saving an identical scene pushes nothing", () => {
    const store = useProjectionStore.getState();
    const live = scene();
    store.setBase({ kind: "utility", sceneId: 1, scene: live, clock });
    const before = selectOutputMemo(useProjectionStore.getState());

    useProjectionStore.getState().setLiveScene(live);
    expect(selectOutputMemo(useProjectionStore.getState())).toBe(before);
  });
});
