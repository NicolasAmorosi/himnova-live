import { api } from "@renderer/lib/api";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import { currentMeasureAspect, fitSongSize } from "@renderer/lib/song-fit";
import { findSong, resolveSong, themeForSong, useSongStore } from "@renderer/stores/song.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProgramStore } from "@renderer/stores/program.store";
import type {
  ResolvedSong,
  Song,
  SongLanguage,
  SongSortOrder,
  SongTheme,
  SongThemeRow,
  SongThemeUpsert,
  SongUpsert,
  SongUsage,
} from "@shared/types/song";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { IpcError } from "@shared/ipc/result";

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
  language: SongLanguage = "both",
): Promise<{ resolved: ResolvedSong; theme: SongTheme; sizeCqw: number } | null> {
  const { songs, themes } = useSongStore.getState();
  const song = findSong(songs, songId);
  if (!song) return null;
  const theme = themeForSong(song, themes);
  const resolved = resolveSong(song, theme, undefined, language);
  const fit = await fitSongSize(resolved, theme, currentMeasureAspect());
  return { resolved, theme, sizeCqw: fit.sizeCqw };
}

/** Where the operator was, in the song as it is now — after an edit, or in
 *  another language, cut into other slides: the same slide of the same pass,
 *  clamped to the slides that pass has now, else the start of the pass at the
 *  same place in the order, else the same number. 1-based. The same pass is
 *  the same time its section is sung (the second chorus stays the second when
 *  an intro is added before it), else its last time. */
export function sameSlideIn(previous: ResolvedSong, slideIndex: number, next: ResolvedSong): number {
  const was = previous.slides[slideIndex - 1];
  if (!was) return slideIndex;
  const passesOf = (song: ResolvedSong) => [
    ...new Set(song.slides.filter((s) => s.sectionKey === was.sectionKey).map((s) => s.pass)),
  ];
  const passes = passesOf(next);
  const pass = passes[Math.min(passesOf(previous).indexOf(was.pass), passes.length - 1)];
  // That pass's slides, in order: its section's, one by one.
  const ofPass = next.slides.flatMap((s, i) => (s.pass === pass ? [i + 1] : []));
  return (
    ofPass[Math.min(was.indexInSection, ofPass.length - 1)] ??
    (next.slides.findIndex((s) => s.pass === was.pass) + 1 || slideIndex)
  );
}

/** Re-dresses the live song in place when it is `songId` (or any song, when
 *  `null`: the projector's proportion changed). Never a new scene. */
export async function refreshLiveSong(songId: number | null = null): Promise<void> {
  const base = useProjectionStore.getState().base;
  if (base?.kind !== "song" || (songId !== null && base.songId !== songId)) return;
  const prepared = await prepareSong(base.songId, base.language);
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

/** The LIVE row's «Original · Ambos · Traducción»: the live song re-resolved
 *  in `language` and measured again — each language has its own one size —,
 *  on the same slide. Never a new scene. */
export async function setLiveSongLanguage(language: SongLanguage): Promise<void> {
  const base = useProjectionStore.getState().base;
  if (base?.kind !== "song" || base.language === language) return;
  const prepared = await prepareSong(base.songId, language);
  const now = useProjectionStore.getState().base;
  if (!prepared || now?.kind !== "song" || now.songId !== base.songId) return;
  // A language can cut a section into more slides or fewer: the same slide,
  // never the same number.
  useProjectionStore
    .getState()
    .setLiveSong(
      prepared.resolved,
      prepared.theme,
      prepared.sizeCqw,
      sameSlideIn(now.song, now.slideIndex, prepared.resolved),
      language,
    );
}

export async function saveSong(input: SongUpsert): Promise<Song | null> {
  const before = findSong(useSongStore.getState().songs, input.id ?? null);
  try {
    const song =
      input.id === undefined ? await api.songs.create(input) : await api.songs.update({ ...input, id: input.id });
    await loadSongs();
    await refreshLiveSong(song.id);
    // A library song whose file is gone was saved in the app and untied.
    if (before?.file && song.file === null) toast.warning(t("songs.fileUntied", { file: before.file }));
    return song;
  } catch (error) {
    console.warn("[songs] could not save the song", error);
    // A song tied to a file that is gone, read-only or changed outside the
    // app: main says which, in the operator's language — and has read a
    // changed library song's file again; a linked folder's is re-listed.
    const fileError = error instanceof IpcError && error.code.startsWith("SONG_FILE_");
    toast.danger(fileError ? error.message : t("songs.saveError"));
    if (fileError) void (before?.sourceFolder ? refreshSongFolder(before.sourceFolder) : loadSongs());
    return null;
  }
}

/** What «Eliminar» asks about a song (`DeleteSongConfirm`). `inSchedule`: the
 *  order of service being built sings it, and `deleteSong` takes it out. */
export type SongDeleteTarget = {
  songId: number;
  live: boolean;
  usages: SongUsage[];
  file: string | null;
  inSchedule: boolean;
};

export async function songDeleteTarget(id: number): Promise<SongDeleteTarget> {
  const file = findSong(useSongStore.getState().songs, id)?.file ?? null;
  const inSchedule = useProgramStore.getState().items.some((item) => item.kind === "song" && item.songId === id);
  return { songId: id, live: isSongLive(id), usages: await songUsages(id), file, inSchedule };
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

/**
 * Another program's songs: EasyWorship 6/7's database (a folder), OpenLP's
 * `songs.sqlite`, OpenLyrics, SongSelect or ChordPro files. Says what it did — written, already
 * there, without a title or lyrics — and, when main refuses (no song database
 * there, or one that will not open), main's own reason, which says what to
 * pick.
 */
/** The view the Songs tab shows: «library», or a linked folder while it is linked. */
export function songView(): string {
  const { settings } = useSettingsStore.getState();
  const saved = settings["songs.activeView"];
  return settings["songs.linkedFolders"].includes(saved) ? saved : "library";
}

export function selectSongView(view: string): void {
  void useSettingsStore.getState().update({ "songs.activeView": view });
}

export function setSongSort(order: SongSortOrder): void {
  void useSettingsStore.getState().update({ "songs.sort": order });
}

/** A linked folder read again from disk (owner, 2026-11-05: the computer's
 *  folders, like Media's). Gone is `"missing"`, never an empty folder. */
export async function refreshSongFolder(folder: string): Promise<void> {
  try {
    useSongStore.getState().setFolderListing(folder, await api.songs.listFolder(folder));
  } catch (error) {
    if (error instanceof IpcError && error.code === "FOLDER_MISSING") {
      useSongStore.getState().setFolderListing(folder, "missing");
      return;
    }
    console.warn("[songs] could not read the folder", folder, error);
    toast.danger(t("songs.loadError"));
  }
}

/** Links a folder of song files and opens it. */
export async function linkSongFolder(): Promise<void> {
  const chosen = await api.files.pickFolder();
  if (chosen === null) return;
  const linked = useSettingsStore.getState().settings["songs.linkedFolders"];
  if (!linked.includes(chosen)) await useSettingsStore.getState().update({ "songs.linkedFolders": [...linked, chosen] });
  selectSongView(chosen);
  await refreshSongFolder(chosen);
}

/** Stops showing a folder; its files are not touched. */
export async function unlinkSongFolder(folder: string): Promise<void> {
  const linked = useSettingsStore.getState().settings["songs.linkedFolders"];
  await useSettingsStore.getState().update({ "songs.linkedFolders": linked.filter((path) => path !== folder) });
  if (songView() === "library") selectSongView("library");
}

/** Any supported format, in one picker, into the library (owner, 2026-11-05). */
export async function importSongs(): Promise<void> {
  try {
    const result = await api.songs.import();
    if (!result) return;
    await loadSongs();
    toast.success(t("songs.importDone", result));
  } catch (error) {
    console.warn("[songs] import failed", error);
    const message = error instanceof Error ? error.message.trim() : "";
    toast.danger(message || t("songs.importError"));
  }
}

/**
 * The CCLI usage report between two local dates (`YYYY-MM-DD`, both days
 * included), saved as CSV where the operator says. Nothing used in those
 * dates says so instead of saving an empty file: `"empty"`, for the dialog to
 * say in place. `"written"` once a report is on disk; `"none"` when nothing
 * was written for another reason (the save dialog cancelled, an error already
 * toasted).
 */
export async function exportSongUsage(fromDate: string, toDate: string): Promise<"written" | "empty" | "none"> {
  const from = new Date(`${fromDate}T00:00:00`);
  const to = new Date(`${toDate}T00:00:00`);
  to.setDate(to.getDate() + 1);
  try {
    const result = await api.songs.usageReport({ from: from.getTime(), to: to.getTime() });
    if (!result) return "none";
    if (result.songs === 0) return "empty";
    toast.success(t("settings.songs.usageDone", { songs: result.songs }));
    return "written";
  } catch (error) {
    console.warn("[songs] usage report failed", error);
    toast.danger(t("settings.songs.usageError"));
    return "none";
  }
}
