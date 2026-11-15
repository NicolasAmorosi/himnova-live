/**
 * What went live leaves PREVIEW (owner, 2026-11-15): with it still there, an extra Enter sent the hymn again — its
 * first slide and its music from 0:00 in front of the congregation. Only what really went out leaves, and only if
 * PREVIEW still holds it. And `goLive()` sends what PREVIEW named when it was pressed, not what is there after the
 * projector opened (2026-11-15 audit, A5).
 */
import { beforeEach, expect, test, vi } from "vitest";
import { goLive } from "@renderer/lib/actions/playback";
import { advanceVerse } from "@renderer/lib/actions/bible";
import { previewAsset, previewScheduleItem, previewVerse } from "@renderer/lib/actions/preview";
import { useAudioStore } from "@renderer/stores/audio.store";
import { useBibleStore } from "@renderer/stores/bible.store";
import { useDisplayStore } from "@renderer/stores/display.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import type { BibleVerseDTO } from "@shared/types/bible";
import type { MediaAsset } from "@shared/types/media";
import type { ProgramItemDTO } from "@shared/types/program";

const asset = (id: number, kind: MediaAsset["kind"], missingSince: number | null = null): MediaAsset => ({
  id,
  kind,
  name: `asset ${id}`,
  ext: kind === "audio" ? "mp3" : "png",
  path: `/media/${id}`,
  sizeBytes: 1,
  mtimeMs: 1,
  durationMs: null,
  linkedAudioPath: null,
  inLibrary: true,
  missingSince,
  createdAt: 0,
  updatedAt: 0,
});
const ASSETS = [asset(1, "image"), asset(2, "image"), asset(3, "image", 1), asset(4, "audio")];

const verse = (chapter: number, n: number): BibleVerseDTO => ({
  id: chapter * 100 + n,
  bookId: 43,
  bookName: "Juan",
  chapter,
  verse: n,
  text: `Juan ${chapter}:${n}`,
});

const row = (id: number, mediaAssetId: number): ProgramItemDTO => ({ id, position: id, kind: "media", mediaAssetId, title: null });

const initialProjection = useProjectionStore.getState();
const initialProgram = useProgramStore.getState();
const initialAudio = useAudioStore.getState();

/** A projector that opens only when the test says so — the wait the operator keeps working through. */
function coldProjector(): () => void {
  let open: () => void = () => {};
  useDisplayStore.setState({ openIfNeeded: () => new Promise<void>((resolve) => (open = resolve)) });
  return () => open();
}

beforeEach(() => {
  (window as unknown as { worship: unknown }).worship = {
    invoke: vi.fn((channel: string, req: { id?: number; bookId?: number; chapter?: number }) =>
      Promise.resolve({
        ok: true,
        data:
          channel === "library:get"
            ? (ASSETS.find((a) => a.id === req.id) ?? null)
            : channel === "bible:chapter"
              ? Array.from({ length: 20 }, (_, i) => verse(req.chapter ?? 1, i + 1))
              : [],
      }),
    ),
    on: () => () => {},
  };
  useProjectionStore.setState(initialProjection, true);
  useProgramStore.setState(initialProgram, true);
  useAudioStore.setState(initialAudio, true);
  usePreviewStore.getState().clear();
  useDisplayStore.setState({ openIfNeeded: async () => {} });
});

test("a schedule row that went live leaves PREVIEW and its selection, and keeps the on-air rail", async () => {
  useProgramStore.setState({ items: [row(10, 1), row(11, 2)] });
  previewScheduleItem(0);
  await goLive();

  expect(useProjectionStore.getState().base).toMatchObject({ kind: "image", assetId: 1 });
  expect(usePreviewStore.getState().target).toBeNull();
  expect(useProgramStore.getState().selectedIndex).toBeNull();
  expect(useProgramStore.getState().activeIndex).toBe(0);

  // An extra Enter has nothing to send.
  const epoch = useProjectionStore.getState().sceneEpoch;
  await goLive();
  expect(useProjectionStore.getState().sceneEpoch).toBe(epoch);
});

test("a verse that went live leaves PREVIEW, and → still walks on from it", async () => {
  await useBibleStore.getState().setBookAndChapter(43, 3);
  previewVerse(15);
  await goLive();

  expect(useProjectionStore.getState().base).toMatchObject({ kind: "bible", reference: "Juan 3:16" });
  expect(usePreviewStore.getState().target).toBeNull();
  advanceVerse(1);
  expect(useProjectionStore.getState().base).toMatchObject({ kind: "bible", reference: "Juan 3:17" });
});

test("an audio that started leaves PREVIEW too", async () => {
  previewAsset(4, "audio");
  await goLive();
  expect(useAudioStore.getState().tracks.map((t) => t.assetId)).toEqual([4]);
  expect(usePreviewStore.getState().target).toBeNull();
});

test("what did not go out stays in PREVIEW", async () => {
  previewAsset(3, "image");
  await goLive();
  expect(useProjectionStore.getState().base).toBeNull();
  expect(usePreviewStore.getState().target).toMatchObject({ kind: "asset", assetId: 3 });
});

test("the row picked while the projector opens stays in PREVIEW, and the one pressed is what goes out", async () => {
  useProgramStore.setState({ items: [row(10, 1), row(11, 2)] });
  const open = coldProjector();
  previewScheduleItem(0);
  const pressed = goLive();
  previewScheduleItem(1);
  open();
  await pressed;

  expect(useProjectionStore.getState().base).toMatchObject({ kind: "image", assetId: 1 });
  expect(useProgramStore.getState().activeIndex).toBe(0);
  expect(useProgramStore.getState().selectedIndex).toBe(1);
  expect(usePreviewStore.getState().target).toMatchObject({ kind: "scheduleItem" });
});

test("a verse pressed while the projector opens is not sent from a chapter browsed meanwhile", async () => {
  await useBibleStore.getState().setBookAndChapter(43, 3);
  const open = coldProjector();
  previewVerse(15);
  const pressed = goLive();
  await useBibleStore.getState().setBookAndChapter(43, 4);
  open();
  await pressed;
  expect(useProjectionStore.getState().base).toBeNull();
});

test("the deck already on air, picked again, is only uncovered — never back to its first slide", async () => {
  const store = useProjectionStore.getState();
  store.beginScene();
  store.setBase({ kind: "deck", assetId: 7, slideIndex: 3 });
  store.setOverlay("black");
  const { sceneEpoch, soundtrackEpoch } = useProjectionStore.getState();

  previewAsset(7, "ppt");
  await goLive();

  const after = useProjectionStore.getState();
  expect(after.base).toMatchObject({ kind: "deck", assetId: 7, slideIndex: 3 });
  expect(after.overlay).toBe("none");
  expect(after.sceneEpoch).toBe(sceneEpoch);
  expect(after.soundtrackEpoch).toBe(soundtrackEpoch);
  expect(usePreviewStore.getState().target).toBeNull();
});
