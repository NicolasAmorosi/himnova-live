/**
 * Two languages at once (owner, 2026-11-05): a second text paired with the lyrics by section and
 * slide, resolved per language, stacked on the projector in «both».
 */
import { beforeEach, describe, expect, test } from "vitest";
import { selectOutput, useProjectionStore } from "@renderer/stores/projection.store";
import { resolveSong } from "@renderer/stores/song.store";
import { sameSlideIn } from "@renderer/lib/actions/songs";
import {
  hasTranslation,
  parseLyrics,
  serializeLyrics,
  splitSection,
  translationFor,
  translationSections,
  withTranslation,
} from "@shared/song-text";
import { DEFAULT_SONG_THEME, type Song, type SongLanguage, type SongTheme } from "@shared/types/song";

const LYRICS = "[Estrofa 1]\nuno a\nuno b\n\ndos a\n\n[Coro]\ncoro a";
const TRANSLATION = "[Estrofa 1]\none a\none b\n\ntwo a\n\n[Coro]\nchorus a";
const sections = (lyrics = LYRICS, translation = TRANSLATION) =>
  withTranslation(parseLyrics(lyrics, "es").sections, parseLyrics(translation, "es").sections);

function song(lyrics?: string, translation?: string): Song {
  return {
    id: 3,
    title: "Dos idiomas",
    number: null,
    authors: null,
    copyright: null,
    ccliNumber: null,
    notes: null,
    sections: sections(lyrics, translation),
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

/** What `setLiveSongLanguage` does once the song is measured. */
function switchLanguage(s: Song, theme: SongTheme, language: SongLanguage, sizeCqw = 4) {
  const base = useProjectionStore.getState().base;
  if (base?.kind !== "song") throw new Error("unreachable");
  const resolved = resolveSong(s, theme, null, language);
  useProjectionStore.getState().setLiveSong(resolved, theme, sizeCqw, sameSlideIn(base.song, base.slideIndex, resolved), language);
}

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

  test("pasted without headers, it pairs block by block in order (owner, 2026-11-06); a slide of chords alone takes none", () => {
    // QA 2026-11-06: paired by name, verse 2 got the chorus's translation and «Two» was lost.
    const lyrics = "[Intro]\n[G] [D]\n\n[Estrofa 1]\nUno\n\n[Coro]\nGloria\n\n[Estrofa 2]\nDos\n\n[Coro]";
    const paired = withTranslation(parseLyrics(lyrics, "es").sections, translationFor(lyrics, "One\n\nGlory\n\nTwo", "es"));
    const byKey = Object.fromEntries(paired.map((s) => [s.key, s.slides[0]?.translation ?? null]));
    expect(byKey).toEqual({ i1: null, v1: ["One"], c1: ["Glory"], v2: ["Two"] });
    // Written back, with the lyrics' headers: paired the same way by name.
    const written = serializeLyrics(translationSections(paired), "es");
    expect(withTranslation(paired, translationFor(lyrics, written, "es"))).toEqual(paired);
  });

  test("an untranslated slide before a translated one is written as an empty line, so the pairs survive", () => {
    const paired = withTranslation(
      parseLyrics("[Estrofa 1]\nuno\n\ndos", "es").sections,
      [{ key: "v1", type: "verse", number: 1, slides: [{ lines: [""] }, { lines: ["two"] }] }],
    );
    const written = serializeLyrics(translationSections(paired), "es");
    expect(written).toBe("[Estrofa 1]\n\\\n\ntwo");
    expect(withTranslation(paired, parseLyrics(written, "es").sections)).toEqual(paired);
  });

  test("a translation line by line is cut by the theme's lines where the lyrics are (QA 2026-11-06)", () => {
    const [verse] = withTranslation(
      parseLyrics("[Estrofa 1]\nuno\ndos\ntres\ncuatro", "es").sections,
      parseLyrics("[Estrofa 1]\none\ntwo\nthree\nfour", "es").sections,
    );
    expect(splitSection(verse!, 3).slides.map((slide) => [slide.lines, slide.translation])).toEqual([
      [["uno", "dos", "tres"], ["one", "two", "three"]],
      [["cuatro"], ["four"]],
    ]);
  });

  test("an empty line the lyrics and the translation share stays in both, so lines per slide cut them alike (review 2026-11-06)", () => {
    // Hava Nagila's bridge: «<br/><br/>» in both languages read 5 lines against 4.
    const paired = withTranslation(
      parseLyrics("[Puente]\na\nb\n\\\nc\nd", "es").sections,
      parseLyrics("[Puente]\nA\nB\n\\\nC\nD", "es").sections,
    );
    expect(splitSection(paired[0]!, 2).slides.map((slide) => [slide.lines, slide.translation])).toEqual([
      [["a", "b"], ["A", "B"]],
      [["", "c"], ["", "C"]],
      [["d"], ["D"]],
    ]);
    const written = serializeLyrics(translationSections(paired), "es");
    expect(written).toBe("[Puente]\nA\nB\n\\\nC\nD");
    expect(withTranslation(paired, parseLyrics(written, "es").sections)).toEqual(paired);
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
    switchLanguage(s, DEFAULT_SONG_THEME, "translation", 5);
    expect(selectOutput(useProjectionStore.getState())).toMatchObject({ lines: ["two a"], translation: null, sizeCqw: 5 });
    expect(useProjectionStore.getState().sceneEpoch).toBe(epoch);
  });
});

describe("switching the language live, with lines per slide", () => {
  // Two lines per slide: verse 1 is one slide, its four-line translation two;
  // the chorus has no translation. The languages number their slides apart.
  const theme: SongTheme = { ...DEFAULT_SONG_THEME, maxLines: 2 };
  const s = song("[Estrofa 1]\nuno a\nuno b\n\n[Coro]\ncoro a\ncoro b", "[Estrofa 1]\none a\none b\none c\none d");

  function goLive(slideIndex: number, language: SongLanguage) {
    useProjectionStore.getState().beginScene();
    useProjectionStore.getState().setBase({
      kind: "song",
      songId: s.id,
      song: resolveSong(s, theme, null, language),
      slideIndex,
      detour: null,
      lyricsHidden: false,
      enterSeq: 0,
      theme,
      sizeCqw: 4,
      backgroundVideo: null,
      language,
    });
  }

  test("the same slide, not the same number", () => {
    expect(resolveSong(s, theme, null, "both").slides).toHaveLength(2);
    expect(resolveSong(s, theme, null, "translation").slides).toHaveLength(3);
    goLive(2, "both"); // the chorus
    switchLanguage(s, theme, "translation");
    expect(selectOutput(useProjectionStore.getState())).toMatchObject({ lines: ["coro a", "coro b"] });
    // The chorus is 3 of 3 here; back to «Original», where there is no 3.
    switchLanguage(s, theme, "original");
    expect(selectOutput(useProjectionStore.getState())).toMatchObject({ lines: ["coro a", "coro b"] });
    expect(useProjectionStore.getState().base).toMatchObject({ slideIndex: 2, language: "original" });
  });

  test("a detour stays on its section, on a slide it has", () => {
    goLive(1, "translation");
    useProjectionStore.getState().setSongPosition({ slideIndex: 1, detour: { sectionKey: "v1", slideIndex: 2, returnTo: 1 } });
    expect(selectOutput(useProjectionStore.getState())).toMatchObject({ lines: ["one c", "one d"] });
    switchLanguage(s, theme, "original");
    expect(selectOutput(useProjectionStore.getState())).toMatchObject({ lines: ["uno a", "uno b"] });
  });
});
