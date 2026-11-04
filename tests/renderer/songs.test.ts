/**
 * A song on the projector: what `selectOutput` sends, moving between slides
 * as a cut, saving it while it is live re-dressed in place on the same slide,
 * and the editor's draft — the order that follows the text until the operator
 * makes it theirs.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { selectOutput, selectOutputMemo, useProjectionStore } from "@renderer/stores/projection.store";
import { resolveSong, themeForSong } from "@renderer/stores/song.store";
import { sameSlideIn } from "@renderer/lib/actions/songs";
import { measureAspect } from "@renderer/lib/song-fit";
import {
  emptySongDraft,
  isSongDraftSavable,
  parseDraft,
  shownOrder,
  toSongDraft,
  toSongUpsert,
} from "@renderer/components/pages/songs/song-draft";
import { parseLyrics } from "@shared/song-text";
import { DEFAULT_SONG_THEME, type Song } from "@shared/types/song";

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
    song: resolveSong(s),
    slideIndex,
    theme: DEFAULT_SONG_THEME,
    sizeCqw: 4.2,
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
    useProjectionStore.getState().setSongSlide(2);
    expect(selectOutput(useProjectionStore.getState())).toMatchObject({ lines: ["dos"] });
    useProjectionStore.getState().setSongSlide(99);
    expect(selectOutput(useProjectionStore.getState())).toMatchObject({ lines: ["tres"] });
    expect(selectOutput(useProjectionStore.getState()).transition.epoch).toBe(epoch);
  });

  test("saved while live: in place, no new scene, the same slide when it still exists", () => {
    const before = song(LYRICS, ["v1", "c1", "v2", "c1"]);
    goLive(before, 3); // the chorus
    const epoch = selectOutput(useProjectionStore.getState()).transition.epoch;

    // A word fixed in the chorus.
    const after = song("[Estrofa 1]\nuno\n\ndos\n\n[Coro]\ncoro corregido\n\n[Estrofa 2]\ntres", ["v1", "c1", "v2", "c1"]);
    const resolved = resolveSong(after);
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
    const other = resolveSong(song("[Coro]\notra", [], 8));
    useProjectionStore.getState().setLiveSong(other, DEFAULT_SONG_THEME, 5, 1);
    expect(selectOutputMemo(useProjectionStore.getState())).toBe(before);
  });
});

describe("where the operator lands after an edit", () => {
  const was = resolveSong(song(LYRICS, ["v1", "c1", "v2", "c1"]));

  test("the same pass and slide, else the same section, else the pass, else the number", () => {
    expect(sameSlideIn(was, 2, resolveSong(song(LYRICS, ["v1", "c1", "v2", "c1"])))).toBe(2);
    // The chorus's second pass, after the order lost a verse.
    expect(sameSlideIn(was, 5, resolveSong(song(LYRICS, ["v1", "c1", "c1"])))).toBe(3);
    // The second slide of verse 1 is gone: its pass.
    expect(sameSlideIn(was, 2, resolveSong(song("[Estrofa 1]\nuno\n\n[Coro]\ncoro", ["v1", "c1"])))).toBe(1);
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
