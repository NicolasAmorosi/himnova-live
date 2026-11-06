/**
 * Overlay plates in `selectOutput`: one per kind and per edge, covered by BLACK, LOGO and
 * "nothing live", and never a new scene.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { selectOutput, useProjectionStore } from "@renderer/stores/projection.store";
import { emptyPlateDraft, withKind } from "@renderer/components/pages/functions/plate-draft";
import { assetUrl } from "@shared/urls";
import { DEFAULT_BUG_STYLE, DEFAULT_PLATE_STYLE, type Plate } from "@shared/types/overlay";

const initialState = useProjectionStore.getState();

function plate(overrides: Partial<Plate> = {}): Plate {
  return {
    id: 1,
    name: "Pastor",
    kind: "lower-third",
    position: "bottom-left",
    title: "Juan Pérez",
    subtitle: "Pastor",
    imageAssetId: null,
    style: DEFAULT_PLATE_STYLE,
    ...overrides,
  };
}

const bug = plate({ id: 2, kind: "bug", position: "top-right", title: null, subtitle: null, imageAssetId: 9 });

function output() {
  return selectOutput(useProjectionStore.getState());
}

beforeEach(() => {
  useProjectionStore.setState(initialState, true);
  useProjectionStore.getState().setBase({ kind: "image", assetId: 12 });
});

describe("overlay plates", () => {
  test("a plate travels resolved, a bug's image as a url", () => {
    useProjectionStore.getState().showPlate(bug);
    expect(output().plates).toEqual([
      expect.objectContaining({ id: 2, kind: "bug", imageUrl: assetUrl(9), title: null }),
    ]);
  });

  test("one per kind: a second lower third replaces the first, a bug sits beside it", () => {
    const { showPlate } = useProjectionStore.getState();
    showPlate(bug);
    showPlate(plate());
    showPlate(plate({ id: 3, title: "Otro" }));
    // Always in kind order, whichever went up first.
    expect(output().plates.map((p) => p.id)).toEqual([3, 2]);
  });

  test("one per edge: a plate replaces whatever is on its edge, whatever its kind", () => {
    const { showPlate } = useProjectionStore.getState();
    const banner = plate({ id: 4, kind: "banner", position: "bottom-center", title: "Aviso" });
    const bottomBug = plate({ ...bug, id: 5, position: "bottom-right" });
    showPlate(bug);
    showPlate(plate());
    showPlate(banner);
    // The banner took the lower third's edge; the top bug stays.
    expect(output().plates.map((p) => p.id)).toEqual([4, 2]);
    // A bug on the bottom edge takes the banner down AND the top bug (its kind).
    showPlate(bottomBug);
    expect(output().plates.map((p) => p.id)).toEqual([5]);
  });

  test("an edit that moves a live plate onto another's edge takes that one down", () => {
    const store = useProjectionStore.getState();
    store.showPlate(bug);
    store.showPlate(plate());
    store.setLivePlate({ ...bug, position: "bottom-right" });
    expect(output().plates.map((p) => p.id)).toEqual([2]);
  });

  test("BLACK, LOGO and nothing live cover every plate, and uncovering brings them back", () => {
    const store = useProjectionStore.getState();
    store.showPlate(plate());
    store.setOverlay("black");
    expect(output().plates).toEqual([]);
    store.setOverlay("logo");
    expect(output().plates).toEqual([]);
    store.setOverlay("none");
    expect(output().plates).toHaveLength(1);
    store.setBase(null);
    expect(output().plates).toEqual([]);
  });

  test("putting a plate up, editing it and taking it down never begins a scene", () => {
    const store = useProjectionStore.getState();
    const epoch = output().transition.epoch;
    store.showPlate(plate());
    store.setLivePlate(plate({ title: "Editado" }));
    expect(output().plates[0]?.title).toBe("Editado");
    store.hidePlate(1);
    expect(output().plates).toEqual([]);
    expect(output().transition.epoch).toBe(epoch);
  });

  test("editing a plate that is not up changes nothing", () => {
    useProjectionStore.getState().setLivePlate(plate());
    expect(useProjectionStore.getState().livePlates).toEqual([]);
  });
});

describe("a plate that hides itself", () => {
  const timed = plate({ style: { ...DEFAULT_PLATE_STYLE, autoHide: { enabled: true, afterMs: 10_000 } } });
  const clock = () => useProjectionStore.getState().plateHideClocks[1];
  const isUp = () => useProjectionStore.getState().livePlates.some((p) => p.id === 1);

  test("goes up held, runs once ticked, and comes down when its count reaches zero", () => {
    const store = useProjectionStore.getState();
    store.showPlate(timed);
    expect(clock()).toEqual({ mode: "countdown", state: "held", remainingMs: 10_000 });
    store.tickPlateClocks(1_000);
    expect(clock()).toEqual({ mode: "countdown", state: "running", endsAtMs: 11_000 });
    store.tickPlateClocks(10_999);
    expect(isUp()).toBe(true);
    store.tickPlateClocks(11_000);
    expect(isUp()).toBe(false);
    expect(clock()).toBeUndefined();
  });

  test("the count only runs while the room can see the plate", () => {
    const store = useProjectionStore.getState();
    store.showPlate(timed);
    store.tickPlateClocks(0);
    store.setOverlay("black");
    store.tickPlateClocks(4_000);
    expect(clock()).toEqual({ mode: "countdown", state: "held", remainingMs: 6_000 });
    // Long past the original end: still up, because it was covered.
    store.tickPlateClocks(60_000);
    expect(isUp()).toBe(true);
    store.setOverlay("none");
    store.tickPlateClocks(60_000);
    store.tickPlateClocks(66_000);
    expect(isUp()).toBe(false);
  });

  test("a tick with nothing to do does not notify", () => {
    const store = useProjectionStore.getState();
    store.showPlate(timed);
    store.tickPlateClocks(0);
    const before = useProjectionStore.getState();
    store.tickPlateClocks(5_000);
    expect(useProjectionStore.getState()).toBe(before);
  });

  test("an edit keeps the count unless it changes the auto-hide itself", () => {
    const store = useProjectionStore.getState();
    store.showPlate(timed);
    store.tickPlateClocks(0);
    store.setLivePlate({ ...timed, title: "Editado" });
    expect(clock()).toEqual({ mode: "countdown", state: "running", endsAtMs: 10_000 });
    store.setLivePlate({ ...timed, style: { ...timed.style, autoHide: { enabled: true, afterMs: 20_000 } } });
    expect(clock()).toEqual({ mode: "countdown", state: "held", remainingMs: 20_000 });
    store.setLivePlate({ ...timed, style: DEFAULT_PLATE_STYLE });
    expect(clock()).toBeUndefined();
  });

  test("taking it down, or replacing it with another of its kind, drops its count", () => {
    const store = useProjectionStore.getState();
    store.showPlate(timed);
    store.showPlate(plate({ id: 3 }));
    expect(clock()).toBeUndefined();
    store.showPlate(timed);
    store.hidePlate(1);
    expect(useProjectionStore.getState().plateHideClocks).toEqual({});
  });
});

describe("switching a plate's kind in the editor", () => {
  const banded = () => {
    const draft = emptyPlateDraft("Aviso");
    return { ...draft, style: { ...draft.style, backgroundOpacity: 0.3 } };
  };

  test("a lower third and a banner hold the same band, so its opacity stays", () => {
    expect(withKind(banded(), "banner").style.backgroundOpacity).toBe(0.3);
  });

  test("a bug starts without a band, and leaving it brings the default band back", () => {
    const bug = withKind(banded(), "bug");
    expect(bug.style.backgroundOpacity).toBe(DEFAULT_BUG_STYLE.backgroundOpacity);
    expect(withKind(bug, "lower-third").style.backgroundOpacity).toBe(DEFAULT_PLATE_STYLE.backgroundOpacity);
  });
});
