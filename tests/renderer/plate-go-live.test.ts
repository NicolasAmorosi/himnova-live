/**
 * A plate through the two-stage flow: previewed like anything else, put up by
 * `goLive()` — without replacing what is projected, without a new scene,
 * without the schedule's rail, and without superseding a deck in flight.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { selectOutput, useProjectionStore } from "@renderer/stores/projection.store";
import { useDisplayStore } from "@renderer/stores/display.store";
import { useOverlayStore } from "@renderer/stores/overlay.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { goLive } from "@renderer/lib/actions/playback";
import { claimLiveIntent, isCurrentLiveIntent } from "@renderer/lib/actions/live-intent";
import { platePreviewOutput } from "@renderer/lib/plate-output";
import { DEFAULT_PLATE_STYLE, type Plate } from "@shared/types/overlay";
import { assetUrl } from "@shared/urls";

const initialProjection = useProjectionStore.getState();

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

const pastor = plate();
const bug = plate({ id: 2, kind: "bug", position: "top-right", title: "IASD", subtitle: null });

beforeEach(() => {
  useProjectionStore.setState(initialProjection, true);
  // The projector is "open" — `openIfNeeded` would otherwise reach for IPC.
  useDisplayStore.setState({ openIfNeeded: async () => {} });
  useOverlayStore.getState().setPlates([pastor, bug]);
  useProgramStore.getState().newProgram();
  useProjectionStore.getState().setBase({ kind: "image", assetId: 12 });
  useProjectionStore.getState().setOverlay("none");
});

describe("goLive with a plate", () => {
  test("puts the previewed plate up over what is live, without a new scene", async () => {
    const epoch = useProjectionStore.getState().sceneEpoch;
    usePreviewStore.getState().setTarget({ kind: "plate", plateId: pastor.id });
    await goLive();

    const state = useProjectionStore.getState();
    expect(state.livePlates.map((p) => p.id)).toEqual([pastor.id]);
    expect(state.base).toEqual({ kind: "image", assetId: 12 });
    expect(state.sceneEpoch).toBe(epoch);
  });

  test("a plate row of the schedule goes up and leaves the rail on the content row", async () => {
    const { addItem, setActive } = useProgramStore.getState();
    addItem({ kind: "media", mediaAssetId: 12, title: null });
    addItem({ kind: "plate", overlayPlateId: bug.id, title: null });
    setActive(0);
    useProgramStore.getState().select(1);
    usePreviewStore.getState().setTarget({ kind: "scheduleItem" });
    await goLive();

    expect(useProjectionStore.getState().livePlates.map((p) => p.id)).toEqual([bug.id]);
    expect(useProgramStore.getState().activeIndex).toBe(0);
  });

  test("does not lift BLACK: the plate goes up covered", async () => {
    useProjectionStore.getState().setOverlay("black");
    usePreviewStore.getState().setTarget({ kind: "plate", plateId: pastor.id });
    await goLive();

    const state = useProjectionStore.getState();
    expect(state.overlay).toBe("black");
    expect(state.livePlates).toHaveLength(1);
    expect(selectOutput(state).plates).toEqual([]);
  });

  test("does not supersede a deck still converting from an earlier GO LIVE", async () => {
    const deckIntent = claimLiveIntent();
    usePreviewStore.getState().setTarget({ kind: "plate", plateId: pastor.id });
    await goLive();
    expect(isCurrentLiveIntent(deckIntent)).toBe(true);
  });

  test("twice is a no-op: the entrance and the count are not restarted", async () => {
    usePreviewStore.getState().setTarget({ kind: "plate", plateId: pastor.id });
    await goLive();
    const first = useProjectionStore.getState().livePlates;
    // Up, it left PREVIEW; picked again, as the operator would have to.
    expect(usePreviewStore.getState().target).toBeNull();
    usePreviewStore.getState().setTarget({ kind: "plate", plateId: pastor.id });
    await goLive();
    expect(useProjectionStore.getState().livePlates).toBe(first);
  });
});

describe("platePreviewOutput", () => {
  test("keeps the other kinds up, replaces its own, and never decodes the live video", () => {
    useProjectionStore.getState().showPlate(bug);
    useProjectionStore.getState().showPlate(plate({ id: 3, name: "Otro" }));
    useProjectionStore.getState().setBase({ kind: "video", assetId: 7, url: assetUrl(7), epoch: 1, startAtSeconds: 0 });
    const live = selectOutput(useProjectionStore.getState());

    const preview = platePreviewOutput(live, pastor, "worship://thumb/7");
    expect(preview.kind).toBe("image");
    expect(preview.videoUnderlay).toBeNull();
    expect(preview.plates.map((p) => p.id)).toEqual([pastor.id, bug.id]);

    expect(platePreviewOutput(live, pastor, null).kind).toBe("black");
  });
});
