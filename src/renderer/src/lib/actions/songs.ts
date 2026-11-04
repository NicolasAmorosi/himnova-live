import { api } from "@renderer/lib/api";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import { currentMeasureAspect, fitSongSize } from "@renderer/lib/song-fit";
import { findSong, resolveSong, themeForSong, useSongStore } from "@renderer/stores/song.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProgramStore } from "@renderer/stores/program.store";
import type { ResolvedSong, Song, SongTheme, SongThemeRow, SongThemeUpsert, SongUpsert, SongUsage } from "@shared/types/song";
import { useSettingsStore } from "@renderer/stores/settings.store";

/**
 * The song library's writes, and keeping a live song in step with them.
 *
 * Every write re-reads the list main answers (`lib/actions/overlays.ts`'s
 * rule). Projecting is `goLive()`'s (`goLiveWithSong`).
 */

export async function loadSongs(): Promise<void> {
  try {
    const [songs, themes] = await Promise.all([api.songs.list(), api.songs.themes()]);
    useSongStore.getState().setThemes(themes);
    useSongStore.getState().setSongs(songs);
  } catch (error) {
    console.warn("[songs] could not load the library", error);
    toast.danger(t("songs.loadError"));
  }
}

/** A song as it goes live: its slides, its theme, and its one size at the
 *  projector's proportion. `null` when the song is gone. */
export async function prepareSong(
  songId: number,
): Promise<{ resolved: ResolvedSong; theme: SongTheme; sizeCqw: number } | null> {
  const { songs, themes } = useSongStore.getState();
  const song = findSong(songs, songId);
  if (!song) return null;
  const theme = themeForSong(song, themes);
  const resolved = resolveSong(song, theme);
  const fit = await fitSongSize(resolved, theme, currentMeasureAspect());
  return { resolved, theme, sizeCqw: fit.sizeCqw };
}

/** Where the operator was, in the song as it is now: the same slide of the
 *  same pass when it still exists, else that section's slide, else the
 *  start of that pass, else the same number. 1-based. */
export function sameSlideIn(previous: ResolvedSong, slideIndex: number, next: ResolvedSong): number {
  const was = previous.slides[slideIndex - 1];
  if (!was) return slideIndex;
  const at = (predicate: (slide: ResolvedSong["slides"][number]) => boolean) =>
    next.slides.findIndex(predicate) + 1;
  return (
    at((s) => s.pass === was.pass && s.sectionKey === was.sectionKey && s.indexInSection === was.indexInSection) ||
    at((s) => s.sectionKey === was.sectionKey && s.indexInSection === was.indexInSection) ||
    at((s) => s.pass === was.pass) ||
    slideIndex
  );
}

/** Re-dresses the live song in place when it is `songId` (or any song, when
 *  `null`: the projector's proportion changed). Never a new scene. */
export async function refreshLiveSong(songId: number | null = null): Promise<void> {
  const base = useProjectionStore.getState().base;
  if (base?.kind !== "song" || (songId !== null && base.songId !== songId)) return;
  const prepared = await prepareSong(base.songId);
  // The operator may have moved on while it was measured.
  const now = useProjectionStore.getState().base;
  if (!prepared || now?.kind !== "song" || now.songId !== base.songId) return;
  useProjectionStore
    .getState()
    .setLiveSong(
      prepared.resolved,
      prepared.theme,
      prepared.sizeCqw,
      sameSlideIn(now.song, now.slideIndex, prepared.resolved),
    );
}

export async function saveSong(input: SongUpsert): Promise<Song | null> {
  try {
    const song =
      input.id === undefined ? await api.songs.create(input) : await api.songs.update({ ...input, id: input.id });
    await loadSongs();
    await refreshLiveSong(song.id);
    return song;
  } catch (error) {
    console.warn("[songs] could not save the song", error);
    toast.danger(t("songs.saveError"));
    return null;
  }
}

export async function duplicateSong(id: number, title: string): Promise<Song | null> {
  try {
    const song = await api.songs.duplicate(id, title);
    await loadSongs();
    return song;
  } catch (error) {
    console.warn("[songs] could not duplicate the song", error);
    toast.danger(t("songs.saveError"));
    return null;
  }
}

/** `force` = the operator read which saved programs sing it and said yes.
 *  A live song stays on the projector — it travels resolved, like a time
 *  scene — until the operator moves on. The unsaved schedule and the preview
 *  are cleaned here, since no FK reaches them. */
export async function deleteSong(id: number, force = false): Promise<boolean> {
  try {
    await api.songs.remove(id, force);
    await loadSongs();
    useProgramStore.getState().removeBySong(id);
    const target = usePreviewStore.getState().target;
    if (target?.kind === "song" && target.songId === id) usePreviewStore.getState().clear();
    return true;
  } catch (error) {
    console.warn("[songs] could not delete the song", error);
    toast.danger(t("songs.deleteError"));
    return false;
  }
}

/** Never throws — `plateUsages`' contract. */
export async function songUsages(id: number): Promise<SongUsage[]> {
  try {
    return await api.songs.usages(id);
  } catch (error) {
    console.warn("[songs] could not read the song's usages", error);
    return [];
  }
}

export function isSongLive(id: number): boolean {
  const base = useProjectionStore.getState().base;
  return base?.kind === "song" && base.songId === id;
}

/** Creates or updates a theme; a live song dressed by it is re-dressed in
 *  place, re-measured — its size depends on the theme. */
export async function saveSongTheme(input: SongThemeUpsert): Promise<SongThemeRow | null> {
  try {
    const theme =
      input.id === undefined
        ? await api.songs.createTheme(input)
        : await api.songs.updateTheme({ ...input, id: input.id });
    await loadSongs();
    await refreshLiveSong();
    return theme;
  } catch (error) {
    console.warn("[songs] could not save the theme", error);
    toast.danger(t("songThemes.saveError"));
    return null;
  }
}

/** Its songs go back to the default theme; a default that named it, to the
 *  first (main resets the setting, mirrored here). */
export async function deleteSongTheme(id: number): Promise<boolean> {
  try {
    await api.songs.removeTheme(id);
    const settings = useSettingsStore.getState();
    if (settings.settings["songs.defaultThemeId"] === id) await settings.update({ "songs.defaultThemeId": null });
    await loadSongs();
    await refreshLiveSong();
    return true;
  } catch (error) {
    console.warn("[songs] could not delete the theme", error);
    toast.danger(t("songThemes.deleteError"));
    return false;
  }
}
