import { create } from "zustand";
import { songDeckSlides, splitSection } from "@shared/song-text";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { useSettingsStore } from "@renderer/stores/settings.store";
import {
  DEFAULT_SONG_THEME,
  songFooterLines,
  type ResolvedSong,
  type Song,
  type SongTheme,
  type SongThemeRow,
} from "@shared/types/song";

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

/** The song's own theme, else Settings ▸ Songs' default, else the first,
 *  else the built-in look — a song always projects. */
export function themeForSong(
  song: Pick<Song, "themeId">,
  themes: readonly SongThemeRow[],
  defaultThemeId: number | null = useSettingsStore.getState().settings["songs.defaultThemeId"],
): SongTheme {
  const pick = (id: number | null) => themes.find((theme) => theme.id === id);
  return (pick(song.themeId) ?? pick(defaultThemeId) ?? themes[0])?.style ?? DEFAULT_SONG_THEME;
}

/** The church's licence, from Settings ▸ Songs. */
export function churchLicense(): string | null {
  return useSettingsStore.getState().settings["songs.ccliLicense"];
}

const resolved = new WeakMap<Song, Map<string, ResolvedSong>>();

/** The order expanded into slides, split to the theme's lines per slide, with
 *  its footer composed. One object per stored song, theme and licence, so
 *  hooks and memos keyed on it do not run again for nothing. */
export function resolveSong(song: Song, theme: SongTheme, license: string | null = churchLicense()): ResolvedSong {
  const key = JSON.stringify([theme.maxLines, theme.footer.fields, license]);
  let byKey = resolved.get(song);
  if (!byKey) {
    byKey = new Map();
    resolved.set(song, byKey);
  }
  let value = byKey.get(key);
  if (!value) {
    const sections = song.sections.map((section) => splitSection(section, theme.maxLines));
    value = {
      id: song.id,
      title: song.title,
      slides: songDeckSlides(sections, song.order),
      sections,
      footer: songFooterLines(song, theme.footer.fields, license, {
        ccli: t("songs.footer.ccli"),
        license: t("songs.footer.license"),
      }),
    };
    byKey.set(key, value);
  }
  return value;
}
