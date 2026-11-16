/**
 * «Locate…» onto a file the library already has a row for merges the two rows in main and deletes the twin
 * (`MediaRepo.relocate`). The open order of service held the twin's id: «Guardar» failed on its foreign key, the
 * draft dropped those rows at the next launch and they showed as «…» (2026-11-15 audit, D4). The renderer moves
 * every reference it holds to the row that stays, except what is on the air: nothing the room sees may move.
 */
import { beforeEach, expect, test, vi } from "vitest";
import { relocateAsset } from "@renderer/lib/actions/relocate-asset";
import { useAudioStore } from "@renderer/stores/audio.store";
import { useLibraryStore } from "@renderer/stores/library.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { assetUrl } from "@shared/urls";

const TWIN = 5;
const KEPT = 9;
const initialProjection = useProjectionStore.getState();

beforeEach(() => {
  (window as unknown as { worship: unknown }).worship = {
    invoke: vi.fn((channel: string) =>
      Promise.resolve(
        channel === "library:relocate"
          ? { ok: true, data: { asset: { id: KEPT, name: "uno.mp4" }, more: 0, merged: [{ from: TWIN, to: KEPT }] } }
          : { ok: true, data: [] },
      ),
    ),
    on: () => () => {},
  };
  useProjectionStore.setState(initialProjection, true);
  useAudioStore.getState().clear();
  const program = useProgramStore.getState();
  program.newProgram();
  program.addItem({ kind: "media", mediaAssetId: TWIN, title: null });
  program.addItem({ kind: "ppt", mediaAssetId: 7, title: null });
  program.addItem({ kind: "ppt", mediaAssetId: TWIN, title: null });
  program.setActive(0);
  program.select(2);
});

const assetIds = () =>
  useProgramStore.getState().items.map((item) => (item.kind === "media" || item.kind === "ppt" ? item.mediaAssetId : null));

test("the open order of service, PREVIEW and the library's selection move to the row that stays", async () => {
  usePreviewStore.getState().setTarget({ kind: "asset", assetId: TWIN, assetKind: "video" });
  useLibraryStore.getState().select(TWIN);

  await relocateAsset(KEPT);

  expect(assetIds()).toEqual([KEPT, 7, KEPT]);
  // The rail and the selection stay on their rows.
  expect(useProgramStore.getState().activeIndex).toBe(0);
  expect(useProgramStore.getState().selectedIndex).toBe(2);
  expect(usePreviewStore.getState().target).toEqual({ kind: "asset", assetId: KEPT, assetKind: "video" });
  expect(useLibraryStore.getState().selectedId).toBe(KEPT);
});

test("what is on the air keeps the id it went out with: the projector and the sound do not move", async () => {
  const projection = useProjectionStore.getState();
  projection.beginScene();
  projection.setBase({ kind: "video", assetId: TWIN, url: assetUrl(TWIN), epoch: 1, startAtSeconds: 0 });
  useAudioStore.getState().addTrack({
    trackId: `a:${TWIN}`,
    source: "asset",
    assetId: TWIN,
    label: "",
    url: assetUrl(TWIN),
    epoch: 1,
    paused: false,
    startAtSeconds: 0,
    volume: 1,
    loop: false,
  });
  const base = useProjectionStore.getState().base;
  const tracks = useAudioStore.getState().tracks;

  await relocateAsset(KEPT);

  expect(assetIds()).toEqual([KEPT, 7, KEPT]);
  expect(useProjectionStore.getState().base).toBe(base);
  expect(useAudioStore.getState().tracks).toBe(tracks);
});
