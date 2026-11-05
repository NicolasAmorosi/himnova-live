import { IpcError } from "@shared/ipc/result";
import type { SongImportResult } from "@shared/types/song";
import { mt } from "../i18n";
import { findEasyWorshipData, readEasyWorship, songIdentity, type SongsRead } from "../songs/easyworship";
import { readOpenLpDatabase, readOpenLyricsFiles } from "../songs/openlp";
import { readSongTextFiles } from "../songs/text-files";
import { getDbHandle, getSettingsRepo, getSongsRepo } from "./repos";

/** Imports EasyWorship's songs from `folder` (its `Databases/Data`, or a
 *  folder above it). */
export function importEasyWorshipFolder(folder: string): SongImportResult {
  const data = findEasyWorshipData(folder);
  if (!data) throw new IpcError({ code: "EW_NOT_FOUND", message: mt("songs.ewNotFound") });
  let read: SongsRead;
  try {
    read = readEasyWorship(data, getSettingsRepo().get("ui.locale"));
  } catch (error) {
    console.warn("[songs] EasyWorship database unreadable", error);
    throw new IpcError({ code: "EW_UNREADABLE", message: mt("songs.ewUnreadable") });
  }
  return writeSongs(read);
}

/** OpenLP's `songs.sqlite`. */
export function importOpenLpDatabase(file: string): SongImportResult {
  let read: SongsRead;
  try {
    read = readOpenLpDatabase(file);
  } catch (error) {
    console.warn("[songs] OpenLP database unreadable", error);
    throw new IpcError({ code: "OPENLP_UNREADABLE", message: mt("songs.openLpUnreadable") });
  }
  return writeSongs(read);
}

/** OpenLyrics files, one song each: a file that is not one is a problem. */
export function importOpenLyricsFiles(files: readonly string[]): SongImportResult {
  return writeSongs(readOpenLyricsFiles(files));
}

/** SongSelect (`.txt`) and ChordPro files, told apart by their words. */
export function importSongTextFiles(files: readonly string[]): SongImportResult {
  return writeSongs(readSongTextFiles(files, getSettingsRepo().get("ui.locale")));
}

/**
 * Writes what a reader found. A song already in the library — same title, same
 * words — is skipped and counted, and so is a second copy inside the same
 * import; one with the same title and other words comes in as a song of its
 * own (owner, 2026-11-04: it may be another version). One transaction: an
 * import that fails halfway leaves the library as it was.
 */
function writeSongs(read: SongsRead): SongImportResult {
  const repo = getSongsRepo();
  const known = new Set(repo.list().map(songIdentity));
  let imported = 0;
  let repeated = 0;
  getDbHandle().sqlite.transaction(() => {
    for (const song of read.songs) {
      const identity = songIdentity(song);
      if (known.has(identity)) {
        repeated += 1;
        continue;
      }
      known.add(identity);
      repo.create(song);
      imported += 1;
    }
  })();
  return { imported, repeated, problems: read.problems };
}
