/**
 * Two languages at once (owner, 2026-11-05): a second text paired with the lyrics by section and
 * slide, resolved per language, stacked on the projector in «both».
 */
import { beforeEach, describe, expect, test } from "vitest";
import { selectOutput, useProjectionStore } from "@renderer/stores/projection.store";
import { resolveSong } from "@renderer/stores/song.store";
import {
  hasTranslation,
  parseLyrics,
  serializeLyrics,
  splitSection,
  translationSections,
  withTranslation,
} from "@shared/song-text";
import { DEFAULT_SONG_THEME, type Song } from "@shared/types/song";

const LYRICS = "[Estrofa 1]\nuno a\nuno b\n\ndos a\n\n[Coro]\ncoro a";
const TRANSLATION = "[Estrofa 1]\none a\none b\n\ntwo a\n\n[Coro]\nchorus a";
const sections = () => withTranslation(parseLyrics(LYRICS, "es").sections, parseLyrics(TRANSLATION, "es").sections);

function song(): Song {
  return {
    id: 3,
    title: "Dos idiomas",
    number: null,
    authors: null,
    copyright: null,
    ccliNumber: null,
    notes: null,
    sections: sections(),
    order: [],
    themeId: null,
    sourceFolder: null,
    file: null,
    updatedAt: 1,
  };
}

beforeEach(() => {
  useProjectionStore.setState(useProjectionStore.getInitialState(), true);
});

describe("the translation text", () => {
  test("pairs by section and slide, and writes back to the same text", () => {
    const paired = sections();
    expect(paired[0]?.slides).toEqual([
      { lines: ["uno a", "uno b"], translation: ["one a", "one b"] },
      { lines: ["dos a"], translation: ["two a"] },
    ]);
    expect(hasTranslation(paired)).toBe(true);
    expect(serializeLyrics(translationSections(paired), "es")).toBe(TRANSLATION);
  });

  test("a translated section the lyrics lack is dropped; an untranslated slide carries none", () => {
    const paired = withTranslation(parseLyrics(LYRICS, "es").sections, parseLyrics("[Puente]\nbridge", "es").sections);
    expect(hasTranslation(paired)).toBe(false);
  });

  test("a slide cut by the theme's lines cuts its translation into as many pieces", () => {
    const [verse] = withTranslation(
      parseLyrics("[Estrofa 1]\na\nb\nc\nd", "es").sections,
      parseLyrics("[Estrofa 1]\nA\nB\nC\nD", "es").sections,
    );
    expect(splitSection(verse!, 2).slides).toEqual([
      { lines: ["a", "b"], translation: ["A", "B"] },
      { lines: ["c", "d"], translation: ["C", "D"] },
    ]);
  });
});

describe("a song in a language", () => {
  test("«original» drops the translation, «translation» puts it in the lines, «both» keeps both", () => {
    const s = song();
    expect(resolveSong(s, DEFAULT_SONG_THEME, null, "original").slides[0]).toMatchObject({ lines: ["uno a", "uno b"] });
    expect(resolveSong(s, DEFAULT_SONG_THEME, null, "original").slides[0]?.translation).toBeUndefined();
    expect(resolveSong(s, DEFAULT_SONG_THEME, null, "translation").slides[2]).toMatchObject({ lines: ["chorus a"] });
    expect(resolveSong(s, DEFAULT_SONG_THEME, null, "both").slides[1]).toMatchObject({ lines: ["dos a"], translation: ["two a"] });
  });

  test("live in «both», the projector gets the slide's translation; switching keeps the slide", () => {
    const s = song();
    const store = useProjectionStore.getState();
    store.beginScene();
    store.setBase({
      kind: "song",
      songId: s.id,
      song: resolveSong(s, DEFAULT_SONG_THEME, null, "both"),
      slideIndex: 2,
      detour: null,
      lyricsHidden: false,
      enterSeq: 0,
      theme: DEFAULT_SONG_THEME,
      sizeCqw: 4,
      backgroundVideo: null,
      language: "both",
    });
    expect(selectOutput(useProjectionStore.getState())).toMatchObject({ lines: ["dos a"], translation: ["two a"] });
    const epoch = useProjectionStore.getState().sceneEpoch;
    useProjectionStore.getState().setSongLanguage("translation", resolveSong(s, DEFAULT_SONG_THEME, null, "translation"), 5);
    expect(selectOutput(useProjectionStore.getState())).toMatchObject({ lines: ["two a"], translation: null, sizeCqw: 5 });
    expect(useProjectionStore.getState().sceneEpoch).toBe(epoch);
  });
});
