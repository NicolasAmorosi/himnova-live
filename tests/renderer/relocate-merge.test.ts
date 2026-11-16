/**
 * «Locate…» onto a file the library already has a row for merges the two rows in main and deletes the twin
 * (`MediaRepo.relocate`). The open order of service held the twin's id: «Guardar» failed on its foreign key, the
 * draft dropped those rows at the next launch and they showed as «…» (2026-11-15 audit, D4). The renderer moves
 * every reference it holds to the row that stays, except what is on the air: nothing the room sees may move.
 */
import { beforeEach, expect, test, vi } from "vitest";
import { relocateAsset } from "@renderer/lib/actions/relocate-asset";
import { goLive, goLiveWithNextScheduleAudio } from "@renderer/lib/actions/playback";
import { previewScheduleItem } from "@renderer/lib/actions/preview";
import { rearmLive } from "@renderer/effects/engine-assets-sync";
import { forceRemoveAsset } from "@renderer/lib/actions/remove-asset";
import { startStageSync } from "@renderer/effects/stage-sync";
import { useAudioStore } from "@renderer/stores/audio.store";
import { useDisplayStore } from "@renderer/stores/display.store";
import { useEngineAssetsStore } from "@renderer/stores/engine-assets.store";
import { useLibraryStore } from "@renderer/stores/library.store";
import { useOverlayStore } from "@renderer/stores/overlay.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import type { MediaAsset } from "@shared/types/media";
import type { Plate } from "@shared/types/overlay";
import { DEFAULT_SETTINGS } from "@shared/types/settings";
import { assetUrl, engineAssetUrl } from "@shared/urls";

const TWIN = 5;
const KEPT = 9;
const AUDIO_TWIN = 15;
const AUDIO_KEPT = 19;
const initialProjection = useProjectionStore.getState();

const asset = (id: number, kind: MediaAsset["kind"]): MediaAsset => ({
  id,
  kind,
  name: `asset ${id}`,
  ext: kind === "audio" ? "mp3" : "mp4",
  path: `/media/${id}`,
  sizeBytes: 1,
  mtimeMs: 1,
  durationMs: null,
  linkedAudioPath: null,
  inLibrary: true,
  missingSince: null,
  createdAt: 0,
  updatedAt: 0,
});
const NEXT_AUDIO = 21;
const LIBRARY = [asset(KEPT, "video"), asset(7, "ppt"), asset(AUDIO_KEPT, "audio"), asset(NEXT_AUDIO, "audio")];
const PLATE = { id: 1, name: "Mosca", kind: "bug", imageAssetId: TWIN } as Plate;

beforeEach(() => {
  (window as unknown as { worship: unknown }).worship = {
    invoke: vi.fn((channel: string, req: { id?: number }) =>
      Promise.resolve(
        channel === "library:relocate"
          ? {
              ok: true,
              data: {
                asset: asset(KEPT, "video"),
                more: 0,
                merged: [
                  { from: TWIN, to: KEPT },
                  { from: AUDIO_TWIN, to: AUDIO_KEPT },
                ],
              },
            }
          : channel === "library:get"
            ? { ok: true, data: LIBRARY.find((candidate) => candidate.id === req.id) ?? null }
            : channel === "overlay:list"
              ? { ok: true, data: [{ ...PLATE, imageAssetId: KEPT }] }
              : { ok: true, data: [] },
      ),
    ),
    on: () => () => {},
  };
  useProjectionStore.setState(initialProjection, true);
  useDisplayStore.setState({ openIfNeeded: async () => {} });
  useEngineAssetsStore.getState().reset([]);
  useAudioStore.getState().clear();
  const program = useProgramStore.getState();
  program.newProgram();
  program.addItem({ kind: "media", mediaAssetId: TWIN, title: null });
  program.addItem({ kind: "ppt", mediaAssetId: 7, title: null });
  program.addItem({ kind: "ppt", mediaAssetId: TWIN, title: null });
  program.addItem({ kind: "media", mediaAssetId: AUDIO_TWIN, title: null });
  program.setActive(0);
  program.select(2);
});

const assetIds = () =>
  useProgramStore.getState().items.map((item) => (item.kind === "media" || item.kind === "ppt" ? item.mediaAssetId : null));

test("the open order of service, PREVIEW and the library's selection move to the row that stays", async () => {
  usePreviewStore.getState().setTarget({ kind: "asset", assetId: TWIN, assetKind: "video" });
  useLibraryStore.getState().select(TWIN);

  await relocateAsset(KEPT);

  expect(assetIds()).toEqual([KEPT, 7, KEPT, AUDIO_KEPT]);
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

  expect(assetIds()).toEqual([KEPT, 7, KEPT, AUDIO_KEPT]);
  expect(useProjectionStore.getState().base).toBe(base);
  expect(useAudioStore.getState().tracks).toBe(tracks);
});

test("an extra Enter on the row on air only uncovers it: the video is not sent again from 0:00", async () => {
  const projection = useProjectionStore.getState();
  projection.beginScene();
  projection.setBase({ kind: "video", assetId: TWIN, url: assetUrl(TWIN), epoch: 1, startAtSeconds: 0 });
  projection.setOverlay("black");
  const base = useProjectionStore.getState().base;
  await relocateAsset(KEPT);

  previewScheduleItem(0);
  await goLive();

  expect(useProjectionStore.getState().base).toBe(base);
  expect(useProjectionStore.getState().overlay).toBe("none");
});

test("an extra Enter on the deck on air only uncovers it: never back to its first slide", async () => {
  const projection = useProjectionStore.getState();
  projection.beginScene();
  projection.setBase({ kind: "deck", assetId: TWIN, slideIndex: 3 });
  projection.setOverlay("black");
  const { sceneEpoch } = useProjectionStore.getState();
  await relocateAsset(KEPT);

  previewScheduleItem(2);
  await goLive();

  expect(useProjectionStore.getState()).toMatchObject({ base: { assetId: TWIN, slideIndex: 3 }, overlay: "none", sceneEpoch });
});

test("an extra Enter on a sound on air does not play it a second time over itself", async () => {
  const track = {
    trackId: `a:${AUDIO_TWIN}`,
    source: "asset" as const,
    assetId: AUDIO_TWIN,
    label: "",
    url: assetUrl(AUDIO_TWIN),
    epoch: 1,
    paused: false,
    startAtSeconds: 0,
    volume: 1,
    loop: false,
  };
  useAudioStore.getState().addTrack(track);
  await relocateAsset(KEPT);

  previewScheduleItem(3);
  await goLive();

  expect(useAudioStore.getState().tracks).toEqual([track]);
});

test("the engine letting go of the merged-away id does not re-point the video on air at a <video>", async () => {
  useEngineAssetsStore.getState().reset([TWIN]);
  const projection = useProjectionStore.getState();
  projection.beginScene();
  projection.setBase({ kind: "video", assetId: TWIN, url: engineAssetUrl(TWIN), epoch: 1, startAtSeconds: 0 });
  const base = useProjectionStore.getState().base;
  await relocateAsset(KEPT);

  // What main's next pass says once the row is gone.
  useEngineAssetsStore.getState().apply({ assetId: TWIN, engine: false });
  rearmLive(TWIN);

  expect(useProjectionStore.getState().base).toBe(base);
});

test("removing the row that stays takes its merged-away twin off the air, as it does the file itself", async () => {
  const projection = useProjectionStore.getState();
  projection.beginScene();
  projection.setBase({ kind: "video", assetId: TWIN, url: assetUrl(TWIN), epoch: 1, startAtSeconds: 0 });
  await relocateAsset(KEPT);

  await forceRemoveAsset(KEPT);

  expect(useProjectionStore.getState().base).toBeNull();
});

test("the saved plates are read again: one whose picture was the twin saves under the row that stays", async () => {
  // Main moved `overlay_plates.image_asset_id` in the merge; the list in memory kept the deleted id, and saving that
  // plate failed on its foreign key (review follow-up).
  useOverlayStore.getState().setPlates([PLATE]);

  await relocateAsset(KEPT);

  await vi.waitFor(() => expect(useOverlayStore.getState().plates[0]?.imageAssetId).toBe(KEPT));
});

test("«Al terminar → siguiente» finds the row of a sound on air under the twin, the program saved since", async () => {
  useProgramStore.getState().addItem({ kind: "media", mediaAssetId: NEXT_AUDIO, title: null });
  await relocateAsset(KEPT);
  const ended = {
    trackId: `a:${AUDIO_TWIN}`,
    source: "asset" as const,
    assetId: AUDIO_TWIN,
    // Saving gave every row a new id: the one it was sent from is found by its sound.
    fromItemId: -999,
    label: "",
    url: assetUrl(AUDIO_TWIN),
    epoch: 1,
    paused: false,
    startAtSeconds: 0,
    volume: 0.5,
    loop: false,
  };

  await goLiveWithNextScheduleAudio(ended);

  expect(useAudioStore.getState().tracks.map((track) => [track.assetId, track.volume])).toEqual([[NEXT_AUDIO, 0.5]]);
});

test("a stage screen started after a merge still gets the still of the video on air under the twin", async () => {
  const projection = useProjectionStore.getState();
  projection.beginScene();
  projection.setBase({ kind: "video", assetId: TWIN, url: assetUrl(TWIN), epoch: 1, startAtSeconds: 0 });
  await relocateAsset(KEPT);
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, "stage.displayId": 1 } });
  const invoke = (window as unknown as { worship: { invoke: ReturnType<typeof vi.fn> } }).worship.invoke;

  const stop = startStageSync();
  try {
    // Asked for the twin, main answers nothing: no still on the stage.
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("library:get", { id: KEPT }));
  } finally {
    stop();
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  }
});
