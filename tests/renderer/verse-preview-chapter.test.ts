/**
 * A verse in PREVIEW is an index into the chapter the Bible tab has loaded, so
 * loading another chapter must drop it — otherwise PREVIEW, and the Enter that
 * follows, silently become whatever verse sits at that index in the new one.
 */
import { beforeEach, expect, test, vi } from "vitest";
import { useBibleStore } from "@renderer/stores/bible.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useDisplayStore } from "@renderer/stores/display.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { goLive, goLiveWithNextScheduleItem } from "@renderer/lib/actions/playback";
import { advanceVerse } from "@renderer/lib/actions/bible";
import { previewScheduleItem } from "@renderer/lib/actions/preview";
import type { BibleBookDTO, BibleVerseDTO } from "@shared/types/bible";

const verse = (bookId: number, chapter: number, n: number): BibleVerseDTO => ({
  id: bookId * 1000 + chapter * 100 + n,
  bookId,
  bookName: bookId === 43 ? "Juan" : bookId === 143 ? "John" : "Romanos",
  chapter,
  verse: n,
  text: `${bookId}:${chapter}:${n}`,
});

/** Version 1 has Juan as book 43 (20 verses a chapter), version 2 John as 143 (only 17). */
const book = (id: number, versionId: number, name: string): BibleBookDTO => ({
  id,
  versionId,
  position: 1,
  abbrev: "jo",
  name,
  testament: "NT",
  chapterCount: 21,
});

beforeEach(() => {
  (window as unknown as { worship: unknown }).worship = {
    invoke: vi.fn((channel: string, req: { bookId: number; chapter: number; versionId: number }) =>
      Promise.resolve(
        channel === "bible:chapter"
          ? {
              ok: true,
              data: Array.from({ length: req.bookId === 143 ? 17 : 20 }, (_, i) => verse(req.bookId, req.chapter, i + 1)),
            }
          : channel === "bible:books"
            ? { ok: true, data: [req.versionId === 2 ? book(143, 2, "John") : book(43, 1, "Juan")] }
            : { ok: true, data: [] },
      ),
    ),
    on: () => () => {},
  };
  usePreviewStore.getState().clear();
  useDisplayStore.setState({ openIfNeeded: async () => {} });
});

test("browsing to another chapter drops the verse in PREVIEW", async () => {
  await useBibleStore.getState().setBookAndChapter(43, 3);
  usePreviewStore.getState().setTarget({ kind: "verse", verseIndex: 15 });

  await useBibleStore.getState().setBookAndChapter(45, 8);
  expect(usePreviewStore.getState().target).toBeNull();
});

test("reloading the same chapter keeps it", async () => {
  await useBibleStore.getState().setBookAndChapter(43, 3);
  usePreviewStore.getState().setTarget({ kind: "verse", verseIndex: 15 });

  await useBibleStore.getState().setBookAndChapter(43, 3);
  expect(usePreviewStore.getState().target).toEqual({ kind: "verse", verseIndex: 15 });
});

test("any other PREVIEW target is left alone", async () => {
  usePreviewStore.getState().setTarget({ kind: "asset", assetId: 4, assetKind: "image" });
  await useBibleStore.getState().setBookAndChapter(45, 8);
  expect(usePreviewStore.getState().target).toMatchObject({ kind: "asset", assetId: 4 });
});

test("a program's verse going live hands its chapter to the tab: → walks on at once", async () => {
  await useBibleStore.getState().setVersion(1);
  await useBibleStore.getState().setBookAndChapter(45, 8);
  useProgramStore.getState().newProgram();
  useProgramStore.getState().addItem({
    kind: "bible",
    bibleVersionId: 1,
    bibleBookId: 43,
    chapter: 3,
    verseFrom: 16,
    verseTo: null,
    reference: "Juan 3:16",
    text: "43:3:16",
  });
  previewScheduleItem(0);
  await goLive();
  await vi.waitFor(() => expect(useBibleStore.getState().currentVerseIndex).toBe(15));
  expect(useBibleStore.getState()).toMatchObject({ bookId: 43, chapter: 3 });
  advanceVerse(1);
  expect(useProjectionStore.getState().base).toMatchObject({ kind: "bible", text: "43:3:17" });
});

test("another version keeps the passage, PREVIEW's verse and the live verse's ←/→", async () => {
  await useBibleStore.getState().setVersion(1);
  await useBibleStore.getState().setBookAndChapter(43, 3);
  usePreviewStore.getState().setTarget({ kind: "verse", verseIndex: 15 });
  useBibleStore.getState().setCurrentVerseIndex(16);

  await useBibleStore.getState().setVersion(2);
  expect(useBibleStore.getState()).toMatchObject({ versionId: 2, bookId: 143, chapter: 3, currentVerseIndex: 16 });
  expect(usePreviewStore.getState().target).toEqual({ kind: "verse", verseIndex: 15 });
  expect(useBibleStore.getState().verses[15]?.text).toBe("143:3:16");

  // A verse this version lacks: PREVIEW lets go of it, the live cursor too.
  await useBibleStore.getState().setVersion(1);
  usePreviewStore.getState().setTarget({ kind: "verse", verseIndex: 19 });
  useBibleStore.getState().setCurrentVerseIndex(19);
  await useBibleStore.getState().setVersion(2);
  expect(usePreviewStore.getState().target).toBeNull();
  expect(useBibleStore.getState().currentVerseIndex).toBeNull();
});

test("a video's «next» onto a Bible row leaves the tab's verse waiting in PREVIEW alone", async () => {
  await useBibleStore.getState().setVersion(1);
  await useBibleStore.getState().setBookAndChapter(43, 3);
  // The operator prepared Juan 3:16 from the Bible tab for later.
  usePreviewStore.getState().setTarget({ kind: "verse", verseIndex: 15 });
  const program = useProgramStore.getState();
  program.newProgram();
  program.addItem({ kind: "media", mediaAssetId: 1, title: "clip" }); // the live video
  program.addItem({
    kind: "bible",
    bibleVersionId: 1,
    bibleBookId: 43,
    chapter: 5,
    verseFrom: 1,
    verseTo: null,
    reference: "Juan 5:1",
    text: "43:5:1",
  });
  program.setActive(0);

  expect(await goLiveWithNextScheduleItem()).toBe(true);
  expect(useProjectionStore.getState().base).toMatchObject({ kind: "bible", reference: "Juan 5:1" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(useBibleStore.getState().chapter).toBe(3);
  expect(usePreviewStore.getState().target).toEqual({ kind: "verse", verseIndex: 15 });
});
