import fs from "node:fs";
import path from "node:path";
import { IpcError } from "@shared/ipc/result";
import { SONG_FILE_EXTENSIONS, type Song, type SongUpsert } from "@shared/types/song";
import { decodeText } from "../decode-text";
import { mt } from "../i18n";
import { readOpenLyrics } from "../songs/openlp";
import { isChordPro, readSongText } from "../songs/text-files";
import { writeChordPro, writeOpenLyrics, writeSongSelect } from "../songs/song-writers";
import { getSettingsRepo, getSongsRepo } from "./repos";

/**
 * A Songs tab's linked folder (owner, 2026-11-05: «las carpetas de la
 * computadora, así como en Media»): its song files read into rows of `songs`,
 * and a song of it saved back into its own file, in that file's format.
 */

type ReadSong = Omit<SongUpsert, "id">;

const isSongFile = (name: string) =>
  !name.startsWith(".") && (SONG_FILE_EXTENSIONS as readonly string[]).includes(path.extname(name).slice(1).toLowerCase());
const isXml = (file: string) => path.extname(file).toLowerCase() === ".xml";
const mtimeOf = (stat: fs.Stats) => Math.floor(stat.mtimeMs);

/** The songs a file holds: one for OpenLyrics and SongSelect, one or more
 *  for ChordPro. A song with no title or no words is left out. */
function readSongFile(file: string, bytes: Uint8Array): ReadSong[] {
  const text = decodeText(bytes);
  if (isXml(file)) {
    const song = readOpenLyrics(text);
    return song ? [song] : [];
  }
  const read = readSongText(text, path.basename(file, path.extname(file)), getSettingsRepo().get("ui.locale"));
  return read.filter((song): song is ReadSong => song !== null);
}

/**
 * The songs of `folder`'s files (its top level, like Media's folders): a file
 * unchanged since it was last read keeps its rows as they are, one that
 * changed is read again. Asynchronous for the same reason as
 * `library:listFolder` — a USB stick or a network share can take seconds, and
 * main frozen is the projector frozen. A folder that is gone throws
 * `FOLDER_MISSING`, never an empty list.
 */
export async function listSongFolder(folder: string): Promise<Song[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(folder, { withFileTypes: true });
  } catch {
    throw new IpcError({ code: "FOLDER_MISSING", message: mt("library.folderMissing") });
  }
  const repo = getSongsRepo();
  const known = repo.fromFolder(folder);
  const songs: Song[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isSongFile(entry.name)) continue;
    const file = path.join(folder, entry.name);
    try {
      const mtime = mtimeOf(await fs.promises.stat(file));
      const rows = known.get(entry.name);
      if (rows && rows.length > 0 && rows.every((row) => row.mtime === mtime)) {
        songs.push(...rows.map((row) => row.song));
        continue;
      }
      songs.push(...repo.syncFile(folder, entry.name, mtime, readSongFile(file, await fs.promises.readFile(file))));
    } catch (error) {
      console.warn("[songs] song file unreadable", file, error);
    }
  }
  return songs;
}

/**
 * Saving a song tied to a file writes that file first, in its own format
 * (owner, 2026-11-05: «se edita en Lumina y se edita el archivo real, siempre
 * así»): a linked folder's song, or a library song imported from a song file.
 * OpenLyrics as OpenLyrics, ChordPro as ChordPro — with the file's other songs
 * as they are —, SongSelect as SongSelect. Nothing for a song that lives only
 * in the app. A file changed outside the app since it was read is not
 * overwritten (`SONG_FILE_CHANGED`) but read again — a linked folder's by the
 * caller, a library song's here —, so saving once more replaces it, as the
 * message says. A library song whose file is gone is untied and saved in the
 * app; a linked folder's song IS its file, so that one is refused. Written to
 * a sibling and renamed over the file, so a crash halfway never leaves half a
 * song on disk.
 */
export function writeSongFile(id: number, song: ReadSong): void {
  const repo = getSongsRepo();
  const source = repo.source(id);
  if (!source) return;
  const file = source.path;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    if (source.folder === null) {
      repo.untieFile(id);
      return;
    }
    throw new IpcError({ code: "SONG_FILE_MISSING", message: mt("songs.fileMissing") });
  }
  if (mtimeOf(stat) !== source.mtime) {
    if (source.folder === null) repo.syncLibraryFile(file, mtimeOf(stat), readSongFileSafely(file));
    throw new IpcError({ code: "SONG_FILE_CHANGED", message: mt("songs.fileChanged") });
  }
  let content: string;
  if (isXml(file)) {
    content = writeOpenLyrics(song);
  } else {
    const text = decodeText(fs.readFileSync(file));
    if (isChordPro(text)) {
      // ponytail: a song of the file that does not read (no title, no words) is not written back; keep it if it matters.
      const all = readSongFile(file, fs.readFileSync(file));
      all[Math.min(source.index, all.length)] = song;
      content = writeChordPro(all);
    } else {
      content = writeSongSelect(song);
    }
  }
  const temporary = `${file}.lumina-tmp`;
  try {
    fs.writeFileSync(temporary, content, "utf8");
    fs.renameSync(temporary, file);
  } catch (error) {
    console.warn("[songs] could not write the song file", file, error);
    fs.rmSync(temporary, { force: true });
    throw new IpcError({ code: "SONG_FILE_UNWRITABLE", message: mt("songs.fileUnwritable") });
  }
  repo.setFileMtime(file, source.folder, mtimeOf(fs.statSync(file)));
}

/** What a file holds now, or nothing when it no longer reads. */
function readSongFileSafely(file: string): ReadSong[] {
  try {
    return readSongFile(file, fs.readFileSync(file));
  } catch (error) {
    console.warn("[songs] song file unreadable", file, error);
    return [];
  }
}
