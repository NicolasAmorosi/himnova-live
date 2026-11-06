/**
 * A song on the projector: what `selectOutput` sends, moving between slides
 * as a cut, saving it while it is live re-dressed in place on the same slide,
 * and the editor's draft — the order that follows the text until the operator
 * makes it theirs.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { selectOutput, selectOutputMemo, useProjectionStore } from "@renderer/stores/projection.store";
import { resolveSong, sortSongs, themeForSong } from "@renderer/stores/song.store";
import { sameSlideIn } from "@renderer/lib/actions/songs";
import { measureAspect } from "@renderer/lib/song-fit";
import {
  emptySongDraft,
  isSongDraftSavable,
  parseDraft,
  shownOrder,
  songDraftProblem,
  toSongDraft,
  toSongUpsert,
  withHeadersWritten,
  type SongDraft,
} from "@renderer/components/pages/songs/song-draft";
import { parseLyrics, songDeckSlides } from "@shared/song-text";
import { DEFAULT_SONG_THEME, type Song, type SongSection, type SongUpsert } from "@shared/types/song";

const initialState = useProjectionStore.getState();

function song(lyrics: string, order: string[] = [], id = 7): Song {
  return {
    id,
    title: "Sublime gracia",
    number: null,
    authors: null,
    copyright: null,
    ccliNumber: null,
    notes: null,
    sections: parseLyrics(lyrics, "es").sections,
    order,
    themeId: null,
    sourceFolder: null,
    file: null,
    updatedAt: 1,
  };
}

const LYRICS = "[Estrofa 1]\nuno\n\ndos\n\n[Coro]\ncoro\n\n[Estrofa 2]\ntres";

function goLive(s: Song, slideIndex = 1) {
  const store = useProjectionStore.getState();
  store.beginScene();
  store.setBase({
    kind: "song",
    songId: s.id,
    song: resolveSong(s, DEFAULT_SONG_THEME, null),
    slideIndex,
    detour: null,
    lyricsHidden: false,
    enterSeq: 0,
    theme: DEFAULT_SONG_THEME,
    sizeCqw: 4.2,
    backgroundVideo: null,
    language: "both",
  });
}

beforeEach(() => {
  useProjectionStore.setState(initialState, true);
});

describe("a live song", () => {
  test("sends its slide, dressed, at its one size", () => {
    goLive(song(LYRICS, ["v1", "c1", "v2", "c1"]), 3);
    expect(selectOutput(useProjectionStore.getState())).toMatchObject({
      kind: "song",
      songId: 7,
      title: "Sublime gracia",
      lines: ["coro"],
      theme: DEFAULT_SONG_THEME,
      backgroundUrl: null,
      sizeCqw: 4.2,
    });
  });

  test("moving between its slides is a cut, clamped to the song", () => {
    goLive(song(LYRICS));
    const epoch = selectOutput(useProjectionStore.getState()).transition.epoch;
    useProjectionStore.getState().setSongPosition({ slideIndex: 2, detour: null });
    expect(selectOutput(useProjectionStore.getState())).toMatchObject({ lines: ["dos"] });
    useProjectionStore.getState().setSongPosition({ slideIndex: 99, detour: null });
    expect(selectOutput(useProjectionStore.getState())).toMatchObject({ lines: ["tres"] });
    expect(selectOutput(useProjectionStore.getState()).transition.epoch).toBe(epoch);
  });

  test("saved while live: in place, no new scene, the same slide when it still exists", () => {
    const before = song(LYRICS, ["v1", "c1", "v2", "c1"]);
    goLive(before, 3); // the chorus
    const epoch = selectOutput(useProjectionStore.getState()).transition.epoch;

    // A word fixed in the chorus.
    const after = song("[Estrofa 1]\nuno\n\ndos\n\n[Coro]\ncoro corregido\n\n[Estrofa 2]\ntres", ["v1", "c1", "v2", "c1"]);
    const resolved = resolveSong(after, DEFAULT_SONG_THEME, null);
    const base = useProjectionStore.getState().base;
    if (base?.kind !== "song") throw new Error("unreachable");
    useProjectionStore
      .getState()
      .setLiveSong(resolved, DEFAULT_SONG_THEME, 3.9, sameSlideIn(base.song, base.slideIndex, resolved));

    const out = selectOutput(useProjectionStore.getState());
    expect(out).toMatchObject({ kind: "song", lines: ["coro corregido"], sizeCqw: 3.9 });
    expect(out.transition.epoch).toBe(epoch);
  });

  test("saving another song changes nothing on the projector", () => {
    goLive(song(LYRICS));
    const before = selectOutputMemo(useProjectionStore.getState());
    const other = resolveSong(song("[Coro]\notra", [], 8), DEFAULT_SONG_THEME, null);
    useProjectionStore.getState().setLiveSong(other, DEFAULT_SONG_THEME, 5, 1);
    expect(selectOutputMemo(useProjectionStore.getState())).toBe(before);
  });
});

describe("jumps and hidden lyrics on the projector", () => {
  test("T leaves only the background, and moving shows the lyrics again — never a new scene", () => {
    goLive(song(LYRICS));
    const epoch = selectOutput(useProjectionStore.getState()).transition.epoch;
    useProjectionStore.getState().setLyricsHidden(true);
    expect(selectOutput(useProjectionStore.getState())).toMatchObject({ kind: "song", lines: [] });
    useProjectionStore.getState().setSongPosition({ slideIndex: 2, detour: null });
    expect(selectOutput(useProjectionStore.getState())).toMatchObject({ lines: ["dos"] });
    expect(selectOutput(useProjectionStore.getState()).transition.epoch).toBe(epoch);
  });

  test("a detour projects its section, and saving keeps it while the section exists", () => {
    goLive(song(LYRICS, ["v1", "c1"]));
    useProjectionStore.getState().setSongPosition({ slideIndex: 2, detour: { sectionKey: "v2", slideIndex: 1, returnTo: 2 } });
    expect(selectOutput(useProjectionStore.getState())).toMatchObject({ lines: ["tres"] });

    const edited = resolveSong(song(LYRICS.replace("tres", "tres bis"), ["v1", "c1"]), DEFAULT_SONG_THEME, null);
    useProjectionStore.getState().setLiveSong(edited, DEFAULT_SONG_THEME, 4.2, 2);
    expect(selectOutput(useProjectionStore.getState())).toMatchObject({ lines: ["tres bis"] });

    const without = resolveSong(song("[Estrofa 1]\nuno\n\ndos\n\n[Coro]\ncoro", ["v1", "c1"]), DEFAULT_SONG_THEME, null);
    useProjectionStore.getState().setLiveSong(without, DEFAULT_SONG_THEME, 4.2, 2);
    expect(selectOutput(useProjectionStore.getState())).toMatchObject({ lines: ["dos"] });
  });
});

describe("the theme on the projector (F3)", () => {
  test("the footer is on the slides the theme says, and a move fades with the theme", () => {
    const s = song(LYRICS);
    const store = useProjectionStore.getState();
    store.beginScene();
    store.setBase({
      kind: "song",
      songId: s.id,
      song: resolveSong(s, DEFAULT_SONG_THEME, "999"),
      slideIndex: 1,
      detour: null,
      lyricsHidden: false,
      enterSeq: 0,
      theme: DEFAULT_SONG_THEME,
      sizeCqw: 4,
      backgroundVideo: null,
      language: "both",
    });
    // The first slide: no footer (it is on the last), and the scene's own way in.
    expect(selectOutput(useProjectionStore.getState())).toMatchObject({ footer: null, enter: null });
    useProjectionStore.getState().setSongPosition({ slideIndex: 4, detour: null });
    const last = selectOutput(useProjectionStore.getState());
    if (last.kind !== "song") throw new Error("unreachable");
    expect(last.footer?.[0]).toBe("Sublime gracia");
    expect(last.footer?.[1]).toContain("999");
    expect(last.enter).toEqual({ style: "crossfade", durationMs: 300, seq: 1 });
  });

  test("lines per slide come from the theme, and the default theme from Settings", () => {
    const s = song("[Coro]\nuno\ndos\ntres");
    expect(resolveSong(s, { ...DEFAULT_SONG_THEME, maxLines: 2 }, null).slides.map((slide) => slide.lines)).toEqual([
      ["uno", "dos"],
      ["tres"],
    ]);
    const a = { ...DEFAULT_SONG_THEME, lineHeight: 1 };
    const b = { ...DEFAULT_SONG_THEME, lineHeight: 2 };
    const rows = [
      { id: 1, name: "A", style: a },
      { id: 2, name: "B", style: b },
    ];
    expect(themeForSong({ themeId: null }, rows, 2)).toBe(b);
    expect(themeForSong({ themeId: 1 }, rows, 2)).toBe(a);
    expect(themeForSong({ themeId: null }, rows, null)).toBe(a);
  });
});

describe("where the operator lands after an edit", () => {
  const was = resolveSong(song(LYRICS, ["v1", "c1", "v2", "c1"]), DEFAULT_SONG_THEME, null);

  test("the same time its section is sung and the same slide, clamped, else the pass, else the number", () => {
    expect(sameSlideIn(was, 2, resolveSong(song(LYRICS, ["v1", "c1", "v2", "c1"]), DEFAULT_SONG_THEME, null))).toBe(2);
    // The chorus's second pass, after the order lost a verse.
    expect(sameSlideIn(was, 5, resolveSong(song(LYRICS, ["v1", "c1", "c1"]), DEFAULT_SONG_THEME, null))).toBe(4);
    // …and after an intro came in front: still the second chorus, not the first.
    const intro = song(`${LYRICS}\n\n[Intro]\nintro`, ["i1", "v1", "c1", "v2", "c1"]);
    expect(sameSlideIn(was, 5, resolveSong(intro, DEFAULT_SONG_THEME, null))).toBe(6);
    // Sung fewer times now: its last time.
    expect(sameSlideIn(was, 5, resolveSong(song(LYRICS, ["v1", "c1", "v2"]), DEFAULT_SONG_THEME, null))).toBe(3);
    // The second slide of verse 1 is gone: the last one it has.
    expect(sameSlideIn(was, 2, resolveSong(song("[Estrofa 1]\nuno\n\n[Coro]\ncoro", ["v1", "c1"]), DEFAULT_SONG_THEME, null))).toBe(1);
  });
});

describe("the editor's draft", () => {
  test("an opened song round-trips without being dirty", () => {
    const stored = song(LYRICS, ["v1", "c1", "v2", "c1"]);
    const draft = toSongDraft(stored, "es");
    const upsert = toSongUpsert(draft, parseDraft(draft, "es"), stored.id);
    expect(upsert.sections).toEqual(stored.sections);
    expect(upsert.order).toEqual(stored.order);
  });

  test("the order follows the text until it is the operator's", () => {
    const pasted = { ...emptySongDraft(), title: "Pegada", lyrics: "A\n\nB\n\nC\n\nB" };
    const parsed = parseDraft(pasted, "es");
    expect(shownOrder(pasted, parsed)).toEqual(["v1", "c1", "v2", "c1"]);
    // Pasted text that repeats its chorus stores that order…
    expect(toSongUpsert(pasted, parsed, null).order).toEqual(["v1", "c1", "v2", "c1"]);
    // …and text written in order stores none.
    const plain = { ...pasted, lyrics: "[Estrofa 1]\na\n\n[Coro]\nb" };
    expect(toSongUpsert(plain, parseDraft(plain, "es"), null).order).toEqual([]);
    // Once the operator sets it, a word changed in the lyrics leaves it alone.
    const custom = { ...plain, order: ["c1", "v1", "c1"], lyrics: "[Estrofa 1]\nA\n\n[Coro]\nb" };
    expect(toSongUpsert(custom, parseDraft(custom, "es"), null).order).toEqual(["c1", "v1", "c1"]);
  });

  test("savable is main's own predicate", () => {
    const draft = { ...emptySongDraft(), lyrics: "a" };
    expect(isSongDraftSavable(draft, parseDraft(draft, "es"))).toBe(false);
    const titled = { ...draft, title: "Algo" };
    expect(isSongDraftSavable(titled, parseDraft(titled, "es"))).toBe(true);
  });
});

/** QA 2026-11-06: the editor's draft, each case a bug found in the app. */
describe("the editor's draft keeps what it is given", () => {
  const draftOf = (patch: Partial<SongDraft>): SongDraft => ({ ...emptySongDraft(), title: "Prueba", ...patch });
  const REPEATED = "[Estrofa 1]\nuno\n\n[Coro]\nel coro\n\n[Estrofa 2]\ndos\n\n[Coro]";
  /** What «Guardar» stores after opening `stored` and touching nothing in its lyrics. */
  const resaved = (stored: Omit<SongUpsert, "id">): SongUpsert => {
    const draft = toSongDraft({ ...stored, id: 1, updatedAt: 0, sourceFolder: null, file: null }, "es");
    return toSongUpsert(draft, parseDraft(draft, "es"), 1);
  };
  const stored = (sections: SongSection[], order: string[] = []): Omit<SongUpsert, "id"> => ({
    title: "t",
    number: null,
    authors: null,
    copyright: null,
    ccliNumber: null,
    notes: null,
    sections,
    order,
    themeId: null,
  });

  test("«Escribir encabezados» keeps the chorus repeats of an order that follows the text", () => {
    for (const lyrics of [REPEATED, "primera\n\nvuelve\n\nsegunda\n\nvuelve"]) {
      const draft = draftOf({ lyrics });
      const parsed = parseDraft(draft, "es");
      const rewritten = withHeadersWritten(draft, parsed, "es");
      expect(rewritten.order).toBeNull();
      expect(toSongUpsert(rewritten, parseDraft(rewritten, "es"), null).order).toEqual(["v1", "c1", "v2", "c1"]);
    }
    // An order of the operator's stays, and still projects the same.
    const custom = draftOf({ lyrics: REPEATED, order: ["c1", "v1", "v2"] });
    const rewritten = withHeadersWritten(custom, parseDraft(custom, "es"), "es");
    expect(rewritten.order).toEqual(["c1", "v1", "v2"]);
    expect(rewritten.lyrics).toContain("[Coro 1]");
  });

  test("a song saved with an order that follows its text is reopened still following it", () => {
    const saved = toSongUpsert(draftOf({ lyrics: REPEATED }), parseDraft(draftOf({ lyrics: REPEATED }), "es"), null);
    const reopened = toSongDraft({ ...saved, id: 1, updatedAt: 0, sourceFolder: null, file: null }, "es");
    expect(reopened.order).toBeNull();
    expect(reopened.lyrics).toBe(REPEATED);
  });

  test("an instrumental intro of chords only, and 41 lines pasted with no blank line, can be saved (owner)", () => {
    const intro = draftOf({ lyrics: "[Intro]\n[G] [D] [Em] [C]\n\n[Estrofa 1]\n[G]Sublime gracia del [C]Señor" });
    expect(isSongDraftSavable(intro, parseDraft(intro, "es"))).toBe(true);
    const long = draftOf({ lyrics: Array.from({ length: 41 }, (_, i) => `Línea número ${i + 1}`).join("\n") });
    expect(isSongDraftSavable(long, parseDraft(long, "es"))).toBe(true);
  });

  test.each([
    ["201 lines in one slide", `[Estrofa 1]\n${Array.from({ length: 201 }, (_, i) => `l${i}`).join("\n")}`, "lines"],
    ["61 sections", Array.from({ length: 61 }, (_, i) => `[Estrofa ${i + 1}]\nv${i}`).join("\n\n"), "sections"],
    ["a 501-character line", `[Estrofa 1]\n${"a".repeat(501)}`, "lineLength"],
    ["41 slides in one section", `[Coro]\n${Array.from({ length: 41 }, (_, i) => `l${i}`).join("\n\n")}`, "slides"],
  ])("%s has a title and lyrics, yet cannot be saved — and the editor says why", (_label, lyrics, kind) => {
    const draft = draftOf({ lyrics });
    expect(songDraftProblem(draft, parseDraft(draft, "es"))?.kind).toBe(kind);
  });

  test("a translation pasted without headers pairs block by block (owner)", () => {
    const draft = draftOf({ lyrics: "[Estrofa 1]\nUno\n\n[Coro]\nGloria\n\n[Estrofa 2]\nDos", translation: "One\n\nGlory\n\nTwo" });
    const byKey = Object.fromEntries(parseDraft(draft, "es").sections.map((s) => [s.key, s.slides[0]?.translation?.[0] ?? null]));
    expect(byKey).toEqual({ v1: "One", c1: "Glory", v2: "Two" });
  });

  // The HASD hymnal's 13.xml and 16.xml: a «Coro» slide inside v1, a «[Repeat x2]» line.
  const hymn: SongSection[] = [
    {
      key: "v1",
      type: "verse",
      number: 1,
      slides: [{ lines: ["Primera línea", "segunda línea"] }, { lines: ["Coro", "Aleluya aleluya"] }],
    },
    { key: "c1", type: "chorus", number: 1, slides: [{ lines: ["Gloria a Dios", "[Repeat x2]"] }] },
  ];

  test("an imported song opened and saved untouched is the same song, its order singing the same words", () => {
    expect(resaved(stored(hymn)).sections).toEqual(hymn);
    const saved = resaved(stored(hymn, ["v1", "c1", "v1", "c1"]));
    expect(songDeckSlides(saved.sections, saved.order).find((slide) => slide.type === "chorus")?.lines[0]).toBe("Gloria a Dios");
    const chordFirst: SongSection[] = [
      { key: "v1", type: "verse", number: 1, slides: [{ lines: ["", "Sublime gracia"], chords: [[{ at: 0, name: "D" }], []] }] },
    ];
    expect(resaved(stored(chordFirst)).sections).toEqual(chordFirst);
  });

  test("lyrics left untouched are never read again: the stored sections are saved as they are", () => {
    // A line with spaces at its end: the text cannot carry them, the save keeps them.
    const odd: SongSection[] = [{ key: "v1", type: "verse", number: 1, slides: [{ lines: ["uno  "] }] }];
    const draft = toSongDraft({ ...stored(odd), id: 1, updatedAt: 0, sourceFolder: null, file: null }, "es");
    expect(toSongUpsert({ ...draft, title: "otro" }, parseDraft({ ...draft, title: "otro" }, "es"), 1).sections).toBe(odd);
  });
});

describe("measuring", () => {
  test("at the projector's proportion, unless the 16:9 monitors are shorter", () => {
    const display = (width: number, height: number) => ({
      id: 1,
      label: "",
      primary: false,
      bounds: { x: 0, y: 0, width, height },
      scaleFactor: 1,
    });
    expect(measureAspect([display(1920, 1080)], 1)).toBeCloseTo(16 / 9);
    expect(measureAspect([display(2560, 1080)], 1)).toBeCloseTo(2560 / 1080);
    // A 4:3 projector is taller than the monitors: measured at 16:9.
    expect(measureAspect([display(1024, 768)], 1)).toBeCloseTo(16 / 9);
    expect(measureAspect([], null)).toBeCloseTo(16 / 9);
  });

  test("a song without a theme of its own takes the first, else the built-in look", () => {
    expect(themeForSong({ themeId: null }, [])).toBe(DEFAULT_SONG_THEME);
    const theme = { ...DEFAULT_SONG_THEME, lineHeight: 1 };
    expect(themeForSong({ themeId: 99 }, [{ id: 1, name: "A", style: theme }])).toBe(theme);
  });
});

describe("the Songs tab's orders (owner, 2026-11-05)", () => {
  const named = (id: number, title: string, number: string | null = null) => ({ ...song("x", [], id), title, number });
  const library = [named(1, "Himno 10", "10"), named(2, "Himno 9", "9"), named(3, "Amén"), named(4, "Ábside", "2a")];
  const titles = (order: Parameters<typeof sortSongs>[1]) => sortSongs(library, order, "es").map((s) => s.title);

  test("titles read numbers as numbers and ignore accents", () => {
    expect(titles("title-asc")).toEqual(["Ábside", "Amén", "Himno 9", "Himno 10"]);
    expect(titles("title-desc")).toEqual(["Himno 10", "Himno 9", "Amén", "Ábside"]);
  });

  test("by number, the songs without one go last; by date, the order they came in", () => {
    expect(titles("number-asc")).toEqual(["Ábside", "Himno 9", "Himno 10", "Amén"]);
    expect(titles("date-desc")).toEqual(["Ábside", "Amén", "Himno 9", "Himno 10"]);
    expect(titles("date-asc")).toEqual(["Himno 10", "Himno 9", "Amén", "Ábside"]);
  });
});
