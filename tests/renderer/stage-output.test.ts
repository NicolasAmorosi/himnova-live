/**
 * The musicians' screen (`stageOutputFor`): what is live, uncovered, and what
 * → would bring — and BLACK, LOGO or hidden lyrics named, never shown.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { buildCumulativeMs, selectOutput, useProjectionStore, type LiveDeck } from "@renderer/stores/projection.store";
import { resolveSong } from "@renderer/stores/song.store";
import { stageOutputFor, type StageBibleCursor } from "@renderer/lib/stage-output";
import { parseLyrics } from "@shared/song-text";
import { DEFAULT_SONG_THEME } from "@shared/types/song";
import { slideUrl } from "@shared/urls";
import type { BibleVerseDTO } from "@shared/types/bible";

const initialState = useProjectionStore.getState();
const WORDS = { black: "NEGRO", logo: "LOGO", lyricsHidden: "LETRA OCULTA", next: "Sigue" };
const NO_CURSOR: StageBibleCursor = { verses: [], currentVerseIndex: null };

const stage = (bible: StageBibleCursor = NO_CURSOR, poster: string | null = null) =>
  stageOutputFor(useProjectionStore.getState(), bible, poster, WORDS);

function liveDeck(slideCount: number, slideIndex: number) {
  const slides = Array.from({ length: slideCount }, (_, i) => ({
    index: i + 1,
    url: slideUrl(500, i + 1),
    thumbUrl: `${slideUrl(500, i + 1)}/thumb`,
    modelUrl: null,
    advanceAfterMs: null,
    transition: null,
  }));
  const deck: LiveDeck = {
    assetId: 9,
    deckId: 500,
    slides,
    soundtrack: null,
    sounds: [],
    videos: [],
    cumulativeMs: buildCumulativeMs(slides),
    autoAdvance: false,
  };
  const store = useProjectionStore.getState();
  store.setLiveDeck(deck);
  store.setBase({ kind: "deck", assetId: 9, slideIndex });
}

function liveSong(slideIndex: number, lyricsHidden = false, lyrics = "[Estrofa 1]\nuno\n\ndos\n\n[Coro]\ncoro") {
  const sections = parseLyrics(lyrics, "es").sections;
  const song = {
    id: 7,
    title: "Sublime gracia",
    number: null,
    authors: null,
    copyright: null,
    ccliNumber: null,
    notes: null,
    sections,
    order: ["v1", "c1", "v1"],
    themeId: null,
    sourceFolder: null,
    file: null,
    updatedAt: 1,
  };
  useProjectionStore.getState().setBase({
    kind: "song",
    songId: 7,
    song: resolveSong(song, DEFAULT_SONG_THEME, null),
    slideIndex,
    detour: null,
    lyricsHidden,
    enterSeq: 0,
    theme: DEFAULT_SONG_THEME,
    sizeCqw: 4.2,
    backgroundVideo: null,
    language: "both",
  });
}

function verse(n: number, text: string): BibleVerseDTO {
  return { id: n, bookId: 43, bookName: "Juan", chapter: 3, verse: n, text };
}

beforeEach(() => {
  useProjectionStore.setState(initialState, true);
});

describe("the stage display", () => {
  test("with nothing live: no frames and no notice", () => {
    expect(stage()).toMatchObject({ current: null, next: null, notice: null, nextLabel: "Sigue" });
  });

  test("a deck: the live slide and the next one, none after the last", () => {
    liveDeck(3, 2);
    const { current, next } = stage();
    expect(current).toMatchObject({ kind: "slide", index: 2, plates: [] });
    expect(next).toMatchObject({ kind: "slide", index: 3 });
    liveDeck(3, 3);
    expect(stage().next).toBeNull();
  });

  test("a song: the next slide in its order, across sections", () => {
    liveSong(2);
    expect(stage().current).toMatchObject({ kind: "song", lines: ["dos"] });
    expect(stage().next).toMatchObject({ kind: "song", lines: ["coro"] });
  });

  test("a song's chords reach the stage, over the live slide and the next — never the projector", () => {
    liveSong(1, false, "[Estrofa 1]\n[G]uno [C]más\n\n[D]dos\n\n[Coro]\ncoro");
    const { current, next } = stage();
    expect(current).toMatchObject({ kind: "song", lines: ["uno más"], chords: [[{ at: 0, name: "G" }, { at: 4, name: "C" }]] });
    expect(next).toMatchObject({ kind: "song", lines: ["dos"], chords: [[{ at: 0, name: "D" }]] });
    expect(selectOutput(useProjectionStore.getState())).not.toHaveProperty("chords");
  });

  test("BLACK and LOGO keep the content and name the cover", () => {
    liveSong(1);
    useProjectionStore.getState().setOverlay("black");
    expect(stage()).toMatchObject({ current: { kind: "song", lines: ["uno"] }, notice: "NEGRO" });
    useProjectionStore.getState().setOverlay("logo");
    expect(stage()).toMatchObject({ current: { kind: "song", lines: ["uno"] }, notice: "LOGO" });
  });

  test("hidden lyrics stay on the stage, named", () => {
    liveSong(1, true);
    expect(stage()).toMatchObject({ current: { kind: "song", lines: ["uno"] }, notice: "LETRA OCULTA" });
  });

  test("a verse from the Bible tab: the next verse of its chapter", () => {
    useProjectionStore.getState().setBase({ kind: "bible", text: "dieciséis", reference: "Juan 3:16", versionLabel: null });
    const cursor = { verses: [verse(16, "dieciséis"), verse(17, "diecisiete")], currentVerseIndex: 0 };
    expect(stage(cursor).next).toMatchObject({ kind: "bible", text: "diecisiete", reference: "Juan 3:17" });
    // A program's verse has no cursor: nothing follows it.
    expect(stage(NO_CURSOR).next).toBeNull();
  });

  test("a video is shown as its poster", () => {
    useProjectionStore.getState().setBase({ kind: "video", assetId: 3, url: "worship://asset/3", epoch: 1, startAtSeconds: 0 });
    expect(stage(NO_CURSOR, "worship://thumb/3")).toMatchObject({
      current: { kind: "video" },
      next: null,
      videoStill: { posterUrl: "worship://thumb/3", videoUrl: "worship://asset/3" },
    });
  });
});
