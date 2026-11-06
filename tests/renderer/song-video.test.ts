/**
 * A song theme's video background on the projector (plan 2026-11-05-video-de-fondo): it travels at
 * the top of the output, survives BLACK, and is the same video across the song's slides and re-dresses.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { selectOutput, useProjectionStore } from "@renderer/stores/projection.store";
import { resolveSong } from "@renderer/stores/song.store";
import { songBackgroundUrl, songBackgroundVideo } from "@renderer/lib/song-output";
import { parseLyrics } from "@shared/song-text";
import { DEFAULT_SONG_THEME, type SongTheme } from "@shared/types/song";

const initialState = useProjectionStore.getState();
const VIDEO_THEME: SongTheme = { ...DEFAULT_SONG_THEME, background: { kind: "video", assetId: 5, fit: "contain" } };

function liveSong(theme: SongTheme) {
  const song = {
    id: 7,
    title: "Sublime gracia",
    number: null,
    authors: null,
    copyright: null,
    ccliNumber: null,
    notes: null,
    sections: parseLyrics("[Estrofa 1]\nuno\n\ndos", "es").sections,
    order: [],
    themeId: null,
    sourceFolder: null,
    file: null,
    updatedAt: 1,
  };
  const store = useProjectionStore.getState();
  store.beginScene();
  store.setBase({
    kind: "song",
    songId: 7,
    song: resolveSong(song, theme, null),
    slideIndex: 1,
    detour: null,
    lyricsHidden: false,
    enterSeq: 0,
    theme,
    sizeCqw: 4,
    backgroundVideo: songBackgroundVideo(theme, null),
    language: "both",
  });
}

const output = () => selectOutput(useProjectionStore.getState());

beforeEach(() => {
  useProjectionStore.setState(initialState, true);
});

describe("a song's video background", () => {
  test("travels at the top of the output with its fit and its still", () => {
    liveSong(VIDEO_THEME);
    expect(output().songVideo).toMatchObject({ url: "worship://asset/5", fit: "contain", posterUrl: songBackgroundUrl(VIDEO_THEME) });
    // Its still is the background every tile draws.
    expect(output()).toMatchObject({ kind: "song", backgroundUrl: songBackgroundUrl(VIDEO_THEME) });
  });

  test("is kept under BLACK, so the projector only covers and pauses it", () => {
    liveSong(VIDEO_THEME);
    const before = output().songVideo;
    useProjectionStore.getState().setOverlay("black");
    expect(output()).toMatchObject({ kind: "black", songVideo: before });
  });

  test("is the same video across the song's slides and a re-dress with the same file", () => {
    liveSong(VIDEO_THEME);
    const first = output().songVideo;
    useProjectionStore.getState().setSongPosition({ slideIndex: 2, detour: null });
    expect(output().songVideo).toEqual(first);
    const base = useProjectionStore.getState().base;
    if (base?.kind !== "song") throw new Error("unreachable");
    useProjectionStore.getState().setLiveSong(base.song, { ...VIDEO_THEME, lineHeight: 1.4 }, 4, 2);
    expect(output().songVideo?.epoch).toBe(first?.epoch);
  });

  test("a theme without one sends none", () => {
    liveSong(DEFAULT_SONG_THEME);
    expect(output().songVideo).toBeUndefined();
  });
});
