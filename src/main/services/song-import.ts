import path from "node:path";
import { IpcError } from "@shared/ipc/result";
import type { SongImportResult } from "@shared/types/song";
import { mt } from "../i18n";
import { findEasyWorshipData, readEasyWorship, songIdentity, type SongsRead } from "../songs/easyworship";
import { readOpenLpDatabase, readOpenLyricsFiles } from "../songs/openlp";
import { readSongTextFiles } from "../songs/text-files";
import { getDbHandle, getSettingsRepo, getSongsRepo } from "./repos";

/** EasyWorship's songs from its `Databases/Data` folder (or a folder above it). */
function readEasyWorshipFolder(folder: string): SongsRead {
  const data = findEasyWorshipData(folder);
  if (!data) throw new IpcError({ code: "EW_NOT_FOUND", message: mt("songs.ewNotFound") });
  try {
    return readEasyWorship(data, getSettingsRepo().get("ui.locale"));
  } catch (error) {
    console.warn("[songs] EasyWorship database unreadable", error);
    throw new IpcError({ code: "EW_UNREADABLE", message: mt("songs.ewUnreadable") });
  }
}

/** OpenLP's `songs.sqlite`. */
function readOpenLp(file: string): SongsRead {
  try {
    return readOpenLpDatabase(file);
  } catch (error) {
    console.warn("[songs] OpenLP database unreadable", error);
    throw new IpcError({ code: "OPENLP_UNREADABLE", message: mt("songs.openLpUnreadable") });
  }
}

export const importEasyWorshipFolder = (folder: string): SongImportResult => writeSongs(readEasyWorshipFolder(folder));
export const importOpenLpDatabase = (file: string): SongImportResult => writeSongs(readOpenLp(file));
export const importOpenLyricsFiles = (files: readonly string[]): SongImportResult => writeSongs(readOpenLyricsFiles(files));
export const importSongTextFiles = (files: readonly string[]): SongImportResult =>
  writeSongs(readSongTextFiles(files, getSettingsRepo().get("ui.locale")));

/** EasyWorship's two databases: picking either one means its folder. */
const EASYWORSHIP_FILE = /^songs(words)?\.db$/i;

/**
 * Whatever «Importar» was given, in one pick (owner, 2026-11-05: no menu of
 * programs): each file read by what it is — OpenLyrics `.xml`, OpenLP's
 * database, EasyWorship's `Songs.db` (its folder), and SongSelect or ChordPro
 * text for the rest. A database that cannot be read is a problem among the
 * rest; when nothing at all came in, its own error says why instead.
 */
export function importSongFiles(files: readonly string[]): SongImportResult {
  const reads: SongsRead[] = [];
  let failure: IpcError | null = null;
  const extension = (file: string) => path.extname(file).slice(1).toLowerCase();
  const databases = files.filter((file) => ["sqlite", "db"].includes(extension(file)));
  const easyWorship = new Set(
    databases.filter((file) => EASYWORSHIP_FILE.test(path.basename(file))).map((file) => path.dirname(file)),
  );
  const sources: (() => SongsRead)[] = [
    ...[...easyWorship].map((folder) => () => readEasyWorshipFolder(folder)),
    ...databases.filter((file) => !EASYWORSHIP_FILE.test(path.basename(file))).map((file) => () => readOpenLp(file)),
  ];
  for (const read of sources) {
    try {
      reads.push(read());
    } catch (error) {
      if (error instanceof IpcError) failure ??= error;
      reads.push({ songs: [], problems: 1 });
    }
  }
  reads.push(readOpenLyricsFiles(files.filter((file) => extension(file) === "xml")));
  const texts = files.filter((file) => !databases.includes(file) && extension(file) !== "xml");
  reads.push(readSongTextFiles(texts, getSettingsRepo().get("ui.locale")));
  const read: SongsRead = {
    songs: reads.flatMap((r) => r.songs),
    problems: reads.reduce((sum, r) => sum + r.problems, 0),
  };
  if (failure && read.songs.length === 0) throw failure;
  return writeSongs(read);
}

/**
 * Writes what a reader found into the library. A song already there — same
 * title, same words — is skipped and counted, and so is a second copy inside
 * the same import; one with the same title and other words comes in as a song
 * of its own (owner, 2026-11-04: it may be another version). A song of a
 * linked folder is not the library's: the same song there is no repeat. A
 * song read from a song file stays tied to it (owner, 2026-11-05), and so does
 * the library's repeat of it when that one had no file yet. One transaction:
 * an import that fails halfway leaves the library as it was.
 */
function writeSongs(read: SongsRead): SongImportResult {
  const repo = getSongsRepo();
  const known = new Map(repo.listLibrary().map((song) => [songIdentity(song), song]));
  let imported = 0;
  let repeated = 0;
  getDbHandle().sqlite.transaction(() => {
    for (const song of read.songs) {
      const identity = songIdentity(song);
      const existing = known.get(identity);
      if (existing) {
        if (song.origin && existing.file === null) {
          repo.tieToFile(existing.id, song.origin);
          known.set(identity, { ...existing, file: song.origin.path });
        }
        repeated += 1;
        continue;
      }
      known.set(identity, repo.create(song, song.origin));
      imported += 1;
    }
  })();
  return { imported, repeated, problems: read.problems };
}
