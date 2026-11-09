/**
 * A verse in two languages side by side («En paralelo»): the parallel travels
 * dressed in the output like the verse, the Bible tab keeps its twin chapter
 * aligned by verse NUMBER so ←/→ never wait, and a schedule row looks its
 * passage up in main without letting a newer GO LIVE lose to it.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { selectOutput, useProjectionStore } from "@renderer/stores/projection.store";
import { alignByNumber, parallelVersionFor, useBibleStore } from "@renderer/stores/bible.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useDisplayStore } from "@renderer/stores/display.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { bibleOutputFor } from "@renderer/lib/bible-output";
import { stageOutputFor } from "@renderer/lib/stage-output";
import { advanceVerse, projectVerse } from "@renderer/lib/actions/bible";
import { goLive } from "@renderer/lib/actions/playback";
import { previewScheduleItem } from "@renderer/lib/actions/preview";
import { DEFAULT_BIBLE_STYLE } from "@shared/types/bible-style";
import type { BibleBookDTO, BibleVerseDTO, BibleVersionDTO } from "@shared/types/bible";

const initialProjection = useProjectionStore.getState();
const JOHN = { text: "Jesus wept.", reference: "John 11:35", versionLabel: "English" };

const version = (id: number, name: string): BibleVersionDTO => ({
  id,
  code: name,
  name,
  language: id === 1 ? "es" : "en",
  isBuiltin: id === 1,
  verseCount: 0,
});
const VERSIONS = [version(1, "RV1909"), version(2, "English")];

/** Juan is book 43 of version 1 (verses 1-20), John book 143 of version 2 —
 *  which leaves verse 3 out, so position and number part ways from there. */
const book = (id: number, versionId: number, name: string): BibleBookDTO => ({
  id,
  versionId,
  position: 43,
  abbrev: "jo",
  name,
  testament: "NT",
  chapterCount: 21,
});
const verse = (bookId: number, n: number): BibleVerseDTO => ({
  id: bookId * 1000 + n,
  bookId,
  bookName: bookId === 143 ? "John" : "Juan",
  chapter: 3,
  verse: n,
  text: `${bookId}:${n}`,
});

let passageCalls: unknown[] = [];
/** When set, main's answer to `bible:passage` waits for it. */
let passageGate: Promise<void> | null = null;

async function answer(channel: string, req: Record<string, unknown>): Promise<unknown> {
  if (channel === "bible:passage") {
    passageCalls.push(req);
    await passageGate;
  }
  switch (channel) {
    case "bible:books":
      return [req["versionId"] === 2 ? book(143, 2, "John") : book(43, 1, "Juan")];
    case "bible:chapter":
      return Array.from({ length: 20 }, (_, i) => verse(req["bookId"] as number, i + 1)).filter(
        (v) => !(v.bookId === 143 && v.verse === 3),
      );
    case "bible:passage":
      return req["versionId"] === 2 ? { text: "For God so loved the world.", reference: "John 3:16" } : null;
    default:
      return null;
  }
}

beforeEach(() => {
  passageCalls = [];
  passageGate = null;
  (window as unknown as { worship: unknown }).worship = {
    invoke: vi.fn(async (channel: string, req: Record<string, unknown>) => ({ ok: true, data: await answer(channel, req) })),
    on: () => () => {},
  };
  useProjectionStore.setState(initialProjection, true);
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, "bible.parallelVersionId": null } }));
  useBibleStore.setState({ versions: VERSIONS, versionId: 1, books: [book(43, 1, "Juan")] });
  usePreviewStore.getState().clear();
  useDisplayStore.setState({ openIfNeeded: async () => {} });
});

describe("the output", () => {
  test("a verse with no parallel is the one column it always was", () => {
    useProjectionStore.getState().setBase({ kind: "bible", text: "Jesús lloró.", reference: "Juan 11:35", versionLabel: null });
    expect(selectOutput(useProjectionStore.getState())).toMatchObject({
      kind: "bible",
      text: "Jesús lloró.",
      reference: "Juan 11:35",
      versionLabel: null,
      parallel: null,
      style: DEFAULT_BIBLE_STYLE,
    });
  });

  test("a parallel travels inside the output, and PREVIEW's builder gives the same", () => {
    const content = { text: "Jesús lloró.", reference: "Juan 11:35", versionLabel: "RV1909", parallel: JOHN };
    useProjectionStore.getState().setBase({ kind: "bible", ...content });
    const { videoUnderlay, slideVideo, plates, transition, ...live } = selectOutput(useProjectionStore.getState());
    expect(live).toEqual(bibleOutputFor(content, DEFAULT_BIBLE_STYLE));
    expect(live).toMatchObject({ parallel: JOHN });
    expect([videoUnderlay, slideVideo, plates.length, transition.epoch]).toEqual([null, null, 0, 0]);
  });

  test("the musicians' screen shows the verse in its own version only", () => {
    useProjectionStore.getState().setBase({ kind: "bible", text: "Jesús lloró.", reference: "Juan 11:35", versionLabel: null, parallel: JOHN });
    const words = { black: "NEGRO", logo: "LOGO", lyricsHidden: "", next: "" };
    const next = { verses: [verse(43, 35), verse(43, 36)], currentVerseIndex: 0 };
    const stage = stageOutputFor(useProjectionStore.getState(), next, null, words);
    expect(stage.current).toMatchObject({ kind: "bible", text: "Jesús lloró.", parallel: null });
    expect(stage.next).toMatchObject({ kind: "bible", text: "43:36", parallel: null });
  });
});

describe("which version is the parallel", () => {
  test("none, the verse's own version, or one deleted since all mean none", () => {
    expect(parallelVersionFor(null, VERSIONS, 1)).toBeNull();
    expect(parallelVersionFor(1, VERSIONS, 1)).toBeNull();
    expect(parallelVersionFor(9, VERSIONS, 1)).toBeNull();
    expect(parallelVersionFor(2, VERSIONS, 1)).toBe(2);
    expect(parallelVersionFor(2, VERSIONS, null)).toBe(2);
  });

  test("twins are aligned by verse number, a verse the other lacks is null", () => {
    const twins = [verse(143, 1), verse(143, 2), verse(143, 4)];
    expect(alignByNumber([verse(43, 1), verse(43, 3), verse(43, 4)], twins).map((v) => v?.text ?? null)).toEqual([
      "143:1",
      null,
      "143:4",
    ]);
  });
});

describe("the Bible tab", () => {
  test("loads the twin chapter with the chapter, and ←/→ project both at once", async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, "bible.parallelVersionId": 2 } }));
    await useBibleStore.getState().setBookAndChapter(43, 3);
    const { parallelVersionId, parallelVerses, verses } = useBibleStore.getState();
    expect(parallelVersionId).toBe(2);
    // John leaves verse 3 out: from there position and number differ.
    expect(parallelVerses.map((v) => v?.verse ?? null).slice(0, 5)).toEqual([1, 2, null, 4, 5]);
    expect(parallelVerses).toHaveLength(verses.length);

    projectVerse(15);
    expect(useProjectionStore.getState().base).toEqual({
      kind: "bible",
      text: "43:16",
      reference: "Juan 3:16",
      versionLabel: "RV1909",
      parallel: { text: "143:16", reference: "John 3:16", versionLabel: "English" },
    });
    // A verse the parallel lacks goes out alone — and nothing awaited.
    useBibleStore.getState().setCurrentVerseIndex(1);
    advanceVerse(1);
    expect(useProjectionStore.getState().base).toMatchObject({ reference: "Juan 3:3", parallel: null });
  });

  test("choosing the parallel reaches PREVIEW's chapter at once and the NEXT verse, not the live one", async () => {
    await useBibleStore.getState().setBookAndChapter(43, 3);
    projectVerse(15);
    const live = useProjectionStore.getState().base;

    await useBibleStore.getState().setParallelVersion(2);
    expect(useBibleStore.getState().parallelVerses[15]?.text).toBe("143:16");
    expect(useProjectionStore.getState().base).toBe(live);

    await useBibleStore.getState().setParallelVersion(null);
    expect(useBibleStore.getState()).toMatchObject({ parallelVersionId: null, parallelVerses: [] });
  });

  test("the browsed version itself as the parallel is none", async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, "bible.parallelVersionId": 1 } }));
    await useBibleStore.getState().setBookAndChapter(43, 3);
    expect(useBibleStore.getState()).toMatchObject({ parallelVersionId: null, parallelVerses: [] });
  });
});

describe("a schedule row", () => {
  function addRow() {
    useProgramStore.getState().newProgram();
    useProgramStore.getState().addItem({
      kind: "bible",
      bibleVersionId: 1,
      bibleBookId: 43,
      chapter: 3,
      verseFrom: 16,
      verseTo: null,
      reference: "Juan 3:16",
      text: "Porque de tal manera…",
    });
    previewScheduleItem(0);
  }

  test("goes live with its passage in the parallel version, found by the book's abbrev", async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, "bible.parallelVersionId": 2 } }));
    addRow();
    await goLive();
    expect(passageCalls).toEqual([{ versionId: 2, bookAbbrev: "jo", chapter: 3, verseFrom: 16, verseTo: 16 }]);
    expect(useProjectionStore.getState().base).toMatchObject({
      kind: "bible",
      reference: "Juan 3:16",
      parallel: { text: "For God so loved the world.", reference: "John 3:16", versionLabel: "English" },
    });
    expect(useProgramStore.getState().activeIndex).toBe(0);
  });

  test("with no parallel it goes live alone, asking main nothing", async () => {
    addRow();
    await goLive();
    expect(passageCalls).toEqual([]);
    expect(useProjectionStore.getState().base).toMatchObject({ reference: "Juan 3:16", parallel: null });
  });

  test("a verse sent while its parallel is looked up wins", async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, "bible.parallelVersionId": 2 } }));
    await useBibleStore.getState().setBookAndChapter(43, 3);
    addRow();
    let answerPassage = () => {};
    passageGate = new Promise((resolve) => (answerPassage = resolve));
    const row = goLive();
    await vi.waitFor(() => expect(passageCalls).toHaveLength(1));
    // The operator sends a verse of the tab before main answers.
    usePreviewStore.getState().setTarget({ kind: "verse", verseIndex: 0 });
    await goLive();
    answerPassage();
    await row;
    expect(useProjectionStore.getState().base).toMatchObject({
      reference: "Juan 3:1",
      parallel: { reference: "John 3:1" },
    });
    expect(useProgramStore.getState().activeIndex).toBeNull();
  });
});
