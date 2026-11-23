/**
 * A control page that starts again (its renderer died, or «Recargar») puts back what is live from the copy main kept,
 * before anything listens: the same output and the same sound as the room has, the verse's cursor, the live row, the
 * stage's message, LIVE's mute, and counters that never hand out a number still on the air (2026-11-15 audit, A30).
 * The copy crosses IPC, so it is cloned here as IPC clones it: an action left in it would throw.
 */
import { beforeEach, expect, test, vi } from "vitest";
import { recoverLiveState, restoreLiveCopy, startLiveCopy, takeLiveCopy } from "@renderer/effects/live-copy";
import { operatorClosedProjector } from "@renderer/stores/display.store";
import { startStageSync } from "@renderer/effects/stage-sync";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { DEFAULT_SETTINGS } from "@shared/types/settings";
import type { StageOutput } from "@shared/types/projection";
import { toAudioTrackPush } from "@renderer/effects/projection-sync";
import { goLive } from "@renderer/lib/actions/playback";
import { previewAsset, previewVerse } from "@renderer/lib/actions/preview";
import { counters } from "@renderer/lib/counters";
import { useAudioStore } from "@renderer/stores/audio.store";
import { useBibleStore } from "@renderer/stores/bible.store";
import { useDisplayStore } from "@renderer/stores/display.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { selectOutput, useProjectionStore } from "@renderer/stores/projection.store";
import { useStageStore } from "@renderer/stores/stage.store";
import { useUiStore } from "@renderer/stores/ui.store";
import type { BibleVerseDTO } from "@shared/types/bible";
import type { MediaAsset } from "@shared/types/media";

const audioAsset: MediaAsset = {
  id: 4,
  kind: "audio",
  name: "Preludio",
  ext: "mp3",
  path: "/media/4",
  sizeBytes: 1,
  mtimeMs: 1,
  durationMs: null,
  linkedAudioPath: null,
  inLibrary: true,
  missingSince: null,
  createdAt: 0,
  updatedAt: 0,
};

const verse = (n: number): BibleVerseDTO => ({ id: 300 + n, bookId: 43, bookName: "Juan", chapter: 3, verse: n, text: `Juan 3:${n}` });

const stores = [useProjectionStore, useAudioStore, useBibleStore, useProgramStore, useStageStore, useUiStore, usePreviewStore] as const;
const initial = stores.map((store) => store.getState());
const zero = { ...counters };

/** A page that just started: every store and counter as the module left it. */
function freshPage(): void {
  stores.forEach((store, i) => (store as { setState: (s: unknown, replace: true) => void }).setState(initial[i], true));
  Object.assign(counters, zero);
}

const roomSees = () => {
  const projection = useProjectionStore.getState();
  return {
    output: selectOutput(projection),
    sound: useAudioStore.getState().tracks.map((track) => toAudioTrackPush(track, projection.overlay !== "none", false, projection.liveMasterVolume)),
  };
};

beforeEach(() => {
  (window as unknown as { worship: unknown }).worship = {
    invoke: vi.fn((channel: string, req: { id?: number }) =>
      Promise.resolve({
        ok: true,
        data: channel === "library:get" ? (req.id === 4 ? audioAsset : null) : channel === "bible:chapter" ? [16, 17, 18].map(verse) : [],
      }),
    ),
    on: () => () => {},
  };
  freshPage();
  useDisplayStore.setState({ openIfNeeded: async () => {} });
});

test("a copy taken, cloned as IPC clones it and put back into a fresh page gives the room what it had", async () => {
  useProgramStore.setState({ items: [{ id: -1, position: 0, kind: "media", mediaAssetId: 4, title: null }] });
  counters.provisionalRow = 1;
  await useBibleStore.getState().setBookAndChapter(43, 3);
  previewVerse(0);
  await goLive();
  previewAsset(4, "audio");
  await goLive();
  useProjectionStore.getState().setOverlay("black");
  useProjectionStore.getState().setLiveMasterVolume(0);
  useStageStore.getState().showMessage("Último coro");
  useProgramStore.setState({ activeIndex: 0, selectedIndex: 0 });
  const before = roomSees();
  const issued = { ...counters };

  const copy = structuredClone(takeLiveCopy());
  freshPage();
  restoreLiveCopy(copy, true);

  expect(roomSees()).toEqual(before);
  expect(useProjectionStore.getState().presentationOpen).toBe(true);
  expect(useBibleStore.getState()).toMatchObject({ chapter: 3, currentVerseIndex: 0 });
  expect(useBibleStore.getState().verses).toHaveLength(3);
  expect(useProgramStore.getState()).toMatchObject({ activeIndex: 0, items: [{ id: -1 }] });
  expect(useStageStore.getState().message).toMatchObject({ text: "Último coro" });
  expect(counters).toEqual(issued);
  // PREVIEW is not carried: a page starts with it empty, its row unselected.
  expect(useProgramStore.getState().selectedIndex).toBeNull();
  expect(usePreviewStore.getState().target).toBeNull();
});

test("after a restore, a new sound gets an epoch the room has not heard, and a new row an id not in the schedule", async () => {
  previewAsset(4, "audio");
  await goLive();
  const playing = useAudioStore.getState().tracks[0]!;
  useProgramStore.getState().addItem({ kind: "media", mediaAssetId: 4, title: null });
  const row = useProgramStore.getState().items[0]!;

  const copy = structuredClone(takeLiveCopy());
  freshPage();
  restoreLiveCopy(copy, true);

  useAudioStore.getState().removeTrack(playing.trackId);
  previewAsset(4, "audio");
  await goLive();
  // Restarted from 0 the counter handed out the same epoch: the projector kept the element and never started over.
  expect(useAudioStore.getState().tracks[0]!.epoch).toBeGreaterThan(playing.epoch);
  useProgramStore.getState().addItem({ kind: "media", mediaAssetId: 4, title: null });
  expect(useProgramStore.getState().items[1]!.id).not.toBe(row.id);
});

test("a projector closed while no page listened is not taken for open", () => {
  useProjectionStore.setState({ presentationOpen: true });
  const copy = structuredClone(takeLiveCopy());
  freshPage();
  restoreLiveCopy(copy, false);
  expect(useProjectionStore.getState().presentationOpen).toBe(false);
});

test("the stage keeps a live video's still through a page that starts again", async () => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, "stage.displayId": 1 } });
  useProjectionStore.getState().setBase({ kind: "video", assetId: 4, url: "worship://asset/4", epoch: 1, startAtSeconds: 0 });
  useStageStore.setState({
    output: { videoStill: { posterUrl: "worship://thumb/4?v=1", videoUrl: "worship://asset/4" } } as StageOutput,
  });
  const invoke = (window as unknown as { worship: { invoke: ReturnType<typeof vi.fn> } }).worship.invoke;
  const stop = startStageSync();
  try {
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("stage:show", expect.anything()));
    // Fetched anew, the first picture had no still: black on the stage until `library:get` answered.
    expect(invoke.mock.calls.find(([channel]) => channel === "stage:show")![1]).toMatchObject({
      videoStill: { posterUrl: "worship://thumb/4?v=1" },
    });
  } finally {
    stop();
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  }
});

test("a projector the operator closed stays closed for the page that starts again", () => {
  operatorClosedProjector.set(true);
  const copy = structuredClone(takeLiveCopy());
  operatorClosedProjector.set(false);
  restoreLiveCopy(copy, false);
  // Back at `false`, the page's launch-time «open by itself» put it back up in front of the room.
  expect(operatorClosedProjector.get()).toBe(true);
  operatorClosedProjector.set(false);
});

test("a launch starts as a launch, a copy restores, and one that cannot be put back leaves the page inert", async () => {
  const answer = (copy: unknown) => {
    (window as unknown as { worship: unknown }).worship = {
      invoke: vi.fn((channel: string) =>
        Promise.resolve({
          ok: true,
          data: channel === "window:liveCopy" ? { copy, projectorOpen: true, mediaStatus: [] } : channel === "settings:get" ? DEFAULT_SETTINGS : null,
        }),
      ),
      on: () => () => {},
    };
  };
  answer(null);
  expect(await recoverLiveState()).toBe("launch");
  // A copy some other build wrote: started blind, the page reached the room, which is what this exists to prevent.
  answer({ v: 2 });
  expect(await recoverLiveState()).toBe("failed");
  answer(structuredClone(takeLiveCopy()));
  expect(await recoverLiveState()).toBe("recovered");
});

test("a playing file's position reaches main's copy once a second at most; anything else goes at once (RR-02)", async () => {
  vi.useFakeTimers();
  const invoke = (window as unknown as { worship: { invoke: ReturnType<typeof vi.fn> } }).worship.invoke;
  const sends = () => invoke.mock.calls.filter(([channel]) => channel === "window:keepLiveCopy").length;
  const stop = startLiveCopy();
  await vi.advanceTimersByTimeAsync(0);
  expect(sends()).toBe(1);

  for (let tick = 1; tick <= 8; tick++) {
    useProjectionStore.getState().setMediaStatus({
      target: { kind: "video" },
      epoch: 1,
      currentTimeSeconds: tick / 4,
      durationSeconds: 60,
      paused: false,
      ended: false,
    });
    await vi.advanceTimersByTimeAsync(250);
  }
  expect(sends()).toBeLessThanOrEqual(3);
  expect(sends()).toBeGreaterThanOrEqual(2);

  const before = sends();
  useProjectionStore.getState().setOverlay("black");
  await vi.advanceTimersByTimeAsync(0);
  expect(sends()).toBe(before + 1);

  stop();
  vi.useRealTimers();
});
