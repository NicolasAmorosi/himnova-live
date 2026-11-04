import { create } from "zustand";
import { songDeckSlides } from "@shared/song-text";
import { DEFAULT_SONG_THEME, type ResolvedSong, type Song, type SongTheme, type SongThemeRow } from "@shared/types/song";

/**
 * The mirror of `songs` and `song_themes`. Which song is selected is the
 * preview target's; what is live is `projection.store.base`.
 */
type SongStoreState = {
  songs: Song[];
  themes: SongThemeRow[];
  setSongs: (songs: Song[]) => void;
  setThemes: (themes: SongThemeRow[]) => void;
};

export const useSongStore = create<SongStoreState>()((set) => ({
  songs: [],
  themes: [],
  setSongs: (songs) => set({ songs }),
  setThemes: (themes) => set({ themes }),
}));

export function findSong(songs: readonly Song[], id: number | null): Song | null {
  return id === null ? null : (songs.find((song) => song.id === id) ?? null);
}

/** The song's own theme, else the default — the first one until Settings
 *  can choose (F3) — else the built-in look, so a song always projects. */
export function themeForSong(song: Pick<Song, "themeId">, themes: readonly SongThemeRow[]): SongTheme {
  return (themes.find((theme) => theme.id === song.themeId) ?? themes[0])?.style ?? DEFAULT_SONG_THEME;
}

const resolved = new WeakMap<Song, ResolvedSong>();

/** The order expanded into slides. One object per stored song, so hooks and
 *  memos keyed on it do not run again for a song that did not change. */
export function resolveSong(song: Song): ResolvedSong {
  let value = resolved.get(song);
  if (!value) {
    value = { id: song.id, title: song.title, slides: songDeckSlides(song.sections, song.order) };
    resolved.set(song, value);
  }
  return value;
}
