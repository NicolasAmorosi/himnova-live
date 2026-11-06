import { create } from "zustand";
import { sectionsIn, songDeckSlides, splitSection } from "@shared/song-text";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { useSettingsStore } from "@renderer/stores/settings.store";
import {
  DEFAULT_SONG_THEME,
  songFooterLines,
  type ResolvedSong,
  type Song,
  type SongLanguage,
  type SongSortOrder,
  type SongTheme,
  type SongThemeRow,
} from "@shared/types/song";

/** What a linked folder holds as last read: its songs' ids, or `"missing"`
 *  when the folder is gone (unplugged, moved) — never shown as empty. */
export type FolderListing = number[] | "missing";

/**
 * The mirror of `songs` and `song_themes`. Which song is selected is the
 * preview target's; what is live is `projection.store.base`. `songs` holds the
 * library and every song read from a linked folder (`sourceFolder`); which of
 * a folder's are there now is its listing.
 */
type SongStoreState = {
  songs: Song[];
  themes: SongThemeRow[];
  folderListings: Record<string, FolderListing>;
  setSongs: (songs: Song[]) => void;
  setThemes: (themes: SongThemeRow[]) => void;
  /** A folder read: its songs replace their rows (or join), and its listing is them. */
  setFolderListing: (folder: string, songs: Song[] | "missing") => void;
};

export const useSongStore = create<SongStoreState>()((set) => ({
  songs: [],
  themes: [],
  folderListings: {},
  setSongs: (songs) => set({ songs }),
  setThemes: (themes) => set({ themes }),
  setFolderListing: (folder, read) =>
    set((state) => {
      if (read === "missing") return { folderListings: { ...state.folderListings, [folder]: "missing" } };
      const byId = new Map(read.map((song) => [song.id, song]));
      const kept = state.songs.map((song) => byId.get(song.id) ?? song);
      const known = new Set(state.songs.map((song) => song.id));
      return {
        songs: [...kept, ...read.filter((song) => !known.has(song.id))],
        folderListings: { ...state.folderListings, [folder]: read.map((song) => song.id) },
      };
    }),
}));

/** The library as the Songs tab lists it with nothing searched. A song
 *  without a number goes after every numbered one, by title. */
export function sortSongs(songs: readonly Song[], order: SongSortOrder, locale: string): Song[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const byTitle = (a: Song, b: Song) => collator.compare(a.title, b.title) || a.id - b.id;
  const compare: Record<SongSortOrder, (a: Song, b: Song) => number> = {
    "title-asc": byTitle,
    "title-desc": (a, b) => byTitle(b, a),
    "number-asc": (a, b) =>
      a.number && b.number ? collator.compare(a.number, b.number) || byTitle(a, b) : a.number ? -1 : b.number ? 1 : byTitle(a, b),
    // The row id is the order songs came in.
    "date-desc": (a, b) => b.id - a.id,
    "date-asc": (a, b) => a.id - b.id,
  };
  return [...songs].sort(compare[order]);
}

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
export function resolveSong(
  song: Song,
  theme: SongTheme,
  license: string | null = churchLicense(),
  language: SongLanguage = "both",
): ResolvedSong {
  const key = JSON.stringify([theme.maxLines, theme.footer.fields, license, language]);
  let byKey = resolved.get(song);
  if (!byKey) {
    byKey = new Map();
    resolved.set(song, byKey);
  }
  let value = byKey.get(key);
  if (!value) {
    const sections = sectionsIn(song.sections, language).map((section) => splitSection(section, theme.maxLines));
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
