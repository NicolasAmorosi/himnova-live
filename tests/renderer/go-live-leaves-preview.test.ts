/**
 * What went live leaves PREVIEW (owner, 2026-11-15): with it still there, an extra Enter sent the hymn again — its
 * first slide and its music from 0:00 in front of the congregation. Only what really went out leaves, and only if
 * PREVIEW still holds it. And `goLive()` sends what PREVIEW named when it was pressed, not what is there after the
 * projector opened (2026-11-15 audit, A5). A schedule row leaves the row under it, whatever it is
 * (`projection.previewNext`, owner 2026-11-21, on by default).
 */
import { beforeEach, expect, test, vi } from "vitest";
import { goLive, goLiveWithNextScheduleAudio, goLiveWithNextScheduleItem } from "@renderer/lib/actions/playback";
import { saveCurrentProgram } from "@renderer/lib/actions/programs";
import { advanceVerse } from "@renderer/lib/actions/bible";
import { advancePreview, previewAsset, previewScheduleItem, previewVerse } from "@renderer/lib/actions/preview";
import { useAudioStore } from "@renderer/stores/audio.store";
import { useBibleStore } from "@renderer/stores/bible.store";
import { useDisplayStore } from "@renderer/stores/display.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import type { BibleVerseDTO } from "@shared/types/bible";
import type { MediaAsset } from "@shared/types/media";
import type { ProgramItemDTO } from "@shared/types/program";
import { mediaErrorKey } from "@shared/types/projection";
import { assetUrl } from "@shared/urls";

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
const ASSETS = [asset(1, "image"), asset(2, "image"), asset(3, "image", 1), asset(4, "audio"), asset(5, "image"), asset(6, "audio"), asset(8, "audio")];

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
const initialSettings = useSettingsStore.getState();

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
  useSettingsStore.setState(initialSettings, true);
  usePreviewStore.getState().clear();
  useDisplayStore.setState({ openIfNeeded: async () => {} });
});

const previewNextOff = () =>
  useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, "projection.previewNext": false } });

test("a schedule row that went live leaves the next row in PREVIEW, and the next Enter sends that one", async () => {
  useProgramStore.setState({ items: [row(10, 1), row(11, 2), row(12, 4)] });
  previewScheduleItem(0);
  await goLive();

  expect(useProjectionStore.getState().base).toMatchObject({ kind: "image", assetId: 1 });
  expect(useProgramStore.getState().activeIndex).toBe(0);
  expect(useProgramStore.getState().selectedIndex).toBe(1);
  expect(usePreviewStore.getState().target).toMatchObject({ kind: "scheduleItem" });

  await goLive();
  expect(useProjectionStore.getState().base).toMatchObject({ kind: "image", assetId: 2 });
  expect(useProgramStore.getState().activeIndex).toBe(1);
  expect(useProgramStore.getState().selectedIndex).toBe(2);

  // Whatever the next row is: an audio, which never claims the rail, still leaves the one under it, here none.
  await goLive();
  expect(useAudioStore.getState().tracks.map((t) => t.assetId)).toEqual([4]);
  expect(useProgramStore.getState().activeIndex).toBe(1);
  expect(useProgramStore.getState().selectedIndex).toBeNull();
  expect(usePreviewStore.getState().target).toBeNull();
});

test("the last row leaves PREVIEW empty, so an extra Enter has nothing to send", async () => {
  useProgramStore.setState({ items: [row(10, 1), row(11, 2)] });
  previewScheduleItem(1);
  await goLive();

  expect(useProjectionStore.getState().base).toMatchObject({ kind: "image", assetId: 2 });
  expect(usePreviewStore.getState().target).toBeNull();
  expect(useProgramStore.getState().selectedIndex).toBeNull();
  const epoch = useProjectionStore.getState().sceneEpoch;
  await goLive();
  expect(useProjectionStore.getState().sceneEpoch).toBe(epoch);
});

test("the next row is found where the edits made during the wait put it", async () => {
  useProgramStore.setState({ items: [row(10, 1), row(11, 2)] });
  const open = coldProjector();
  previewScheduleItem(0);
  const pressed = goLive();
  // A row dropped on top while the projector opens: the pressed row is now the second, its next the third.
  useProgramStore.getState().addItem({ kind: "media", mediaAssetId: 9, title: "x" } as never, 0);
  open();
  await pressed;

  expect(useProgramStore.getState().activeIndex).toBe(1);
  expect(useProgramStore.getState().selectedIndex).toBe(2);
  expect(useProgramStore.getState().items[2]?.id).toBe(11);
});

test("with «Lo que sigue en PREVIEW» off, a schedule row that went live leaves PREVIEW and its selection", async () => {
  previewNextOff();
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
  // Uncovered with a fade, one new scene, as VIVO does (owner, 2026-11-16, audit U17), and its music where it was.
  expect(after.sceneEpoch).toBe(sceneEpoch + 1);
  expect(after.soundtrackEpoch).toBe(soundtrackEpoch);
  expect(usePreviewStore.getState().target).toBeNull();
});

/** Every edit of the schedule copies all of its rows (`reindex`): a row held across an `await` is found by id, or the
 *  rail and the verse cursor were lost (2026-11-15 audit, A16). */
test("a row added while the hymn's deck is read keeps the on-air rail on the hymn", async () => {
  let read: (() => void) | null = null;
  const deck = {
    assetId: 5,
    deckId: 3,
    status: "ready",
    slides: [{ index: 1, url: "worship://deck/3/1", thumbUrl: "t", modelUrl: null, advanceAfterMs: null, transition: null }],
    soundtrack: null,
    sounds: [],
    videos: [],
    autoAdvance: false,
    slideCount: 1,
    error: null,
  };
  (window as unknown as { worship: { invoke: unknown } }).worship.invoke = (channel: string) =>
    channel === "deck:ensure"
      ? new Promise((resolve) => (read = () => resolve({ ok: true, data: deck })))
      : Promise.resolve({ ok: true, data: null });
  useProgramStore.setState({ items: [{ id: 10, position: 0, kind: "ppt", mediaAssetId: 5, title: "Himno" }] });
  previewScheduleItem(0);
  const pressed = goLive();
  await vi.waitFor(() => expect(read).not.toBeNull());
  useProgramStore.getState().addItem({ kind: "media", mediaAssetId: 9, title: "x" } as never);
  read!();
  await pressed;

  expect(useProjectionStore.getState().base).toMatchObject({ kind: "deck", assetId: 5 });
  expect(useProgramStore.getState().activeIndex).toBe(0);
});

test("a row dropped above while the projector opens: the pressed row still goes out, with the rail", async () => {
  useProgramStore.setState({ items: [row(10, 1), row(11, 2)] });
  const open = coldProjector();
  previewScheduleItem(1);
  const pressed = goLive();
  useProgramStore.getState().addItem({ kind: "media", mediaAssetId: 9, title: "x" } as never, 0);
  open();
  await pressed;

  expect(useProjectionStore.getState().base).toMatchObject({ kind: "image", assetId: 2 });
  expect(useProgramStore.getState().activeIndex).toBe(2);
});

test("a verse row edited around while its chapter loads still marks its verse as the live one there", async () => {
  useProgramStore.setState({
    items: [
      {
        id: 20,
        position: 0,
        kind: "bible",
        bibleVersionId: null,
        bibleBookId: 43,
        chapter: 3,
        verseFrom: 16,
        verseTo: null,
        reference: "Juan 3:16",
        text: "A",
      },
    ],
  });
  previewScheduleItem(0);
  await goLive();
  useProgramStore.getState().addItem({ kind: "media", mediaAssetId: 9, title: "x" } as never);
  await vi.waitFor(() => expect(useBibleStore.getState().chapter).toBe(3));

  expect(useProgramStore.getState().activeIndex).toBe(0);
  expect(useBibleStore.getState().currentVerseIndex).toBe(15);
});

test("an image on air that failed to load is sent again by GO LIVE, the operator's retry", async () => {
  useProgramStore.setState({ items: [row(10, 1)] });
  previewScheduleItem(0);
  await goLive();
  useProjectionStore.setState({
    mediaErrors: { [mediaErrorKey({ kind: "scene" })]: { target: { kind: "scene" }, url: assetUrl(1), code: null } },
  });
  const epoch = useProjectionStore.getState().sceneEpoch;
  previewScheduleItem(0);
  await goLive();
  expect(useProjectionStore.getState().sceneEpoch).toBe(epoch + 1);
  expect(useProjectionStore.getState().mediaErrors[mediaErrorKey({ kind: "scene" })]).toBeUndefined();
});

test("the same image sent again from a later row only uncovers it, and that row takes the rail", async () => {
  useProgramStore.setState({ items: [row(10, 1), row(11, 4), row(12, 1), row(13, 2)] });
  previewScheduleItem(0);
  await goLive();
  await goLive(); // the audio
  const epoch = useProjectionStore.getState().sceneEpoch;
  await goLive(); // image 1 again, already on air
  expect(useProjectionStore.getState().sceneEpoch).toBe(epoch);
  expect(useProgramStore.getState().activeIndex).toBe(2);
  expect(useProgramStore.getState().selectedIndex).toBe(3);
});

/** «Guardar» as main answers it: each save gives the schedule's rows new ids (`AUTOINCREMENT`), in the same order. */
function eachSaveGives(...generations: number[][]): void {
  const worship = (window as unknown as { worship: { invoke: (channel: string, req: unknown) => Promise<unknown> } }).worship;
  const answer = worship.invoke;
  const summary = { id: 7, name: "Culto", notes: null, favorite: false, createdAt: 0, updatedAt: 0, lastOpenedAt: null, sortOrder: 0, itemCount: 2 };
  worship.invoke = (channel, req) => {
    if (channel === "programs:save") return Promise.resolve({ ok: true, data: summary });
    if (channel === "programs:load") {
      return Promise.resolve({ ok: true, data: { ...summary, items: generations.shift()!.map((id, i) => row(id, i + 1)) } });
    }
    return answer(channel, req);
  };
  useProgramStore.setState({ currentProgramId: 7, currentProgramName: "Culto" });
}

test("a save landing while the projector opens: the pressed row still goes out, and the next one is in PREVIEW", async () => {
  useProgramStore.setState({ items: [row(10, 1), row(11, 2)] });
  eachSaveGives([20, 21]);
  const open = coldProjector();
  previewScheduleItem(0);
  const pressed = goLive();
  await saveCurrentProgram();
  expect(useProgramStore.getState().items.map((item) => item.id)).toEqual([20, 21]);
  open();
  await pressed;
  expect(useProjectionStore.getState().base).toMatchObject({ kind: "image", assetId: 1 });
  expect(useProgramStore.getState().activeIndex).toBe(0);
  expect(useProgramStore.getState().selectedIndex).toBe(1);
});

test("two saves while the projector opens: the pressed row is found through both", async () => {
  useProgramStore.setState({ items: [row(10, 1), row(11, 2)] });
  eachSaveGives([20, 21], [30, 31]);
  const open = coldProjector();
  previewScheduleItem(0);
  const pressed = goLive();
  await saveCurrentProgram();
  await saveCurrentProgram();
  open();
  await pressed;
  expect(useProjectionStore.getState().base).toMatchObject({ kind: "image", assetId: 1 });
  expect(useProgramStore.getState().activeIndex).toBe(0);
  expect(useProgramStore.getState().selectedIndex).toBe(1);
});

/** «Al terminar: siguiente» chains rows on its own; PREVIEW left at or above the row it sent was sent again by Enter,
 *  over it (owner, 2026-11-22: PREVIEW follows the chain). */
const program = () => useProgramStore.getState();

test("«Al terminar: siguiente» past PREVIEW's row leaves the row under the one it sent in PREVIEW", async () => {
  useProgramStore.setState({ items: [row(10, 1), row(11, 2), row(12, 5), row(13, 1)] });
  previewScheduleItem(0);
  await goLive();
  expect(program().selectedIndex).toBe(1);

  await goLiveWithNextScheduleItem();
  expect(program().activeIndex).toBe(1);
  expect(program().selectedIndex).toBe(2);
  await goLiveWithNextScheduleItem();
  expect(program().activeIndex).toBe(2);
  expect(program().selectedIndex).toBe(3);
  expect(useProjectionStore.getState().base).toMatchObject({ kind: "image", assetId: 5 });
});

test("a row further down that the operator picked, or anything else in PREVIEW, stays there", async () => {
  useProgramStore.setState({ items: [row(10, 1), row(11, 2), row(12, 5), row(13, 1)] });
  previewScheduleItem(0);
  await goLive();
  previewScheduleItem(3);
  await goLiveWithNextScheduleItem();
  expect(program().activeIndex).toBe(1);
  expect(program().selectedIndex).toBe(3);

  previewAsset(2, "image");
  await goLiveWithNextScheduleItem();
  expect(program().activeIndex).toBe(2);
  expect(usePreviewStore.getState().target).toMatchObject({ kind: "asset", assetId: 2 });
});

test("a row above where the chain started, waiting in PREVIEW, stays there: the welcome while the music plays on", async () => {
  useProgramStore.setState({ items: [row(9, 2), row(10, 1), row(11, 5), row(12, 1)] });
  previewScheduleItem(1);
  await goLive();
  previewScheduleItem(0);
  await goLiveWithNextScheduleItem();
  expect(program().activeIndex).toBe(2);
  expect(program().selectedIndex).toBe(0);

  useProgramStore.setState({ items: [row(19, 2), row(20, 4), row(21, 6), row(22, 8)], activeIndex: null, selectedIndex: null });
  previewScheduleItem(1);
  await goLive();
  previewScheduleItem(0);
  await goLiveWithNextScheduleAudio(useAudioStore.getState().tracks.find((t) => t.assetId === 4)!);
  expect(useAudioStore.getState().tracks.map((t) => t.assetId)).toEqual([4, 6]);
  expect(program().selectedIndex).toBe(0);
});

test("the chain reaching PREVIEW's last row leaves PREVIEW empty, and with «Lo que sigue» off it empties too", async () => {
  useProgramStore.setState({ items: [row(10, 1), row(11, 2)] });
  previewScheduleItem(0);
  await goLive();
  await goLiveWithNextScheduleItem();
  expect(program().activeIndex).toBe(1);
  expect(usePreviewStore.getState().target).toBeNull();

  previewNextOff();
  useProgramStore.setState({ items: [row(20, 1), row(21, 2), row(22, 5)], activeIndex: null, selectedIndex: null });
  previewScheduleItem(0);
  await goLive();
  previewScheduleItem(1);
  await goLiveWithNextScheduleItem();
  expect(program().activeIndex).toBe(1);
  expect(usePreviewStore.getState().target).toBeNull();
  expect(program().selectedIndex).toBeNull();
});

test("background music on «siguiente» moves PREVIEW along, so Enter never starts a second song", async () => {
  useProgramStore.setState({ items: [row(10, 4), row(11, 6), row(12, 8)] });
  previewScheduleItem(0);
  await goLive();
  expect(program().selectedIndex).toBe(1);
  const playing = (assetId: number) => useAudioStore.getState().tracks.find((t) => t.assetId === assetId)!;

  await goLiveWithNextScheduleAudio(playing(4));
  expect(program().selectedIndex).toBe(2);
  await goLiveWithNextScheduleAudio(playing(6));
  expect(usePreviewStore.getState().target).toBeNull();
  await goLive();
  expect(useAudioStore.getState().tracks.map((t) => t.assetId)).toEqual([4, 6, 8]);
});

test("a verse walked out of a Bible row with ↓ is still that row's: it takes the rail and leaves the next row", async () => {
  useProgramStore.setState({
    items: [
      {
        id: 20,
        position: 0,
        kind: "bible",
        bibleVersionId: null,
        bibleBookId: 43,
        chapter: 3,
        verseFrom: 16,
        verseTo: null,
        reference: "Juan 3:16",
        text: "A",
      },
      row(21, 1),
    ],
  });
  previewScheduleItem(0);
  advancePreview(1);
  await vi.waitFor(() => expect(usePreviewStore.getState().target).toMatchObject({ kind: "verse", verseIndex: 16 }));
  // ↓ again walks on, still the row's.
  advancePreview(1);
  expect(usePreviewStore.getState().target).toMatchObject({ kind: "verse", verseIndex: 17, row: { id: 20 } });

  await goLive();
  expect(useProjectionStore.getState().base).toMatchObject({ kind: "bible", reference: "Juan 3:18" });
  expect(program().activeIndex).toBe(0);
  expect(program().selectedIndex).toBe(1);
  expect(usePreviewStore.getState().target).toMatchObject({ kind: "scheduleItem" });
});
