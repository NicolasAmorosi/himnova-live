import fs from "node:fs";
import path from "node:path";
import { IpcError } from "@shared/ipc/result";
import { SONG_FILE_LIMITS, songFileFormat, type SongFileFormat } from "@shared/song-file-limits";
import { SONG_FILE_EXTENSIONS, type Song, type SongSection, type SongUpsert } from "@shared/types/song";
import { matchRows, type FileSong } from "../db/repositories/songs.repo";
import { encodeText, readText } from "../decode-text";
import { mt } from "../i18n";
import { isOpenLyrics, readOpenLyrics } from "../songs/openlp";
import { chordProSongs, isChordPro, isSongText, readSongTextBlocks } from "../songs/text-files";
import { rewriteChordPro, rewriteOpenLyrics, rewriteSongSelect, withXmlEncoding } from "../songs/song-writers";
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
const fallbackTitle = (file: string) => path.basename(file, path.extname(file));

/** The songs a file holds — one for OpenLyrics and SongSelect, one or more
 *  for ChordPro —, each with which song of the file it is, and the file's
 *  format; `null` when it is no song file this app reads (another program's
 *  XML or text: never overwritten). A song with no title or no words is left
 *  out. Throws on a broken XML. */
function readSongFile(file: string, text: string): { songs: FileSong[]; format: SongFileFormat } | null {
  if (isXml(file)) {
    if (!isOpenLyrics(text)) return null;
    const song = readOpenLyrics(text);
    return { songs: song ? [{ song, index: 0 }] : [], format: "openlyrics" };
  }
  if (!isSongText(text)) return null;
  const blocks = readSongTextBlocks(text, fallbackTitle(file), getSettingsRepo().get("ui.locale"));
  return {
    songs: blocks.flatMap(({ song, index }) => (song ? [{ song, index }] : [])),
    format: isChordPro(text) ? "chordpro" : "songselect",
  };
}

/**
 * The songs of `folder`'s files (its top level, like Media's folders; a
 * symbolic link to a song file is that file): a file unchanged since it was
 * last read keeps its rows as they are, one that changed is read again. A
 * file that reads as no song for a moment (an editor that empties it before
 * writing, a broken XML) keeps its rows until it reads again; the rows of a
 * file no longer there go (`forgetFiles`). Asynchronous for the same reason
 * as `library:listFolder` — a USB stick or a network share can take seconds,
 * and main frozen is the projector frozen. A folder that is gone throws
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
  const present = new Set<string>();
  for (const entry of entries) {
    if (!isSongFile(entry.name)) continue;
    // There, whatever reading it says: a share that fails a moment keeps its rows.
    present.add(entry.name);
    const file = path.join(folder, entry.name);
    try {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile()) continue;
      const mtime = mtimeOf(stat);
      const rows = known.get(entry.name);
      if (rows && rows.length > 0 && rows.every((row) => row.mtime === mtime)) {
        songs.push(...rows.map((row) => row.song));
        continue;
      }
      const read = readSongFile(file, readText(await fs.promises.readFile(file)).text);
      if (!read || read.songs.length === 0) continue;
      songs.push(...repo.syncFile(folder, entry.name, mtime, read.songs, read.format));
    } catch (error) {
      console.warn("[songs] song file unreadable", file, error);
    }
  }
  repo.forgetFiles(folder, present);
  return songs;
}

/** What `format`'s file holds of a song's words: what the song can lose
 *  there (`SONG_FILE_LIMITS`) left out. */
function heldSections(sections: readonly SongSection[], cannot: ReadonlySet<string>): unknown {
  return sections.map((section) => ({
    key: section.key,
    slides: cannot.has("slides")
      ? [section.slides.flatMap((slide) => slide.lines)]
      : section.slides.map((slide) => ({
          lines: slide.lines,
          chords: cannot.has("chords") ? null : (slide.chords ?? null),
          translation: cannot.has("translation") ? null : (slide.translation ?? null),
        })),
  }));
}

/** Whether `song` changes something a file of `format` holds against what the
 *  app holds now — any format's, with `null`. */
function changesFile(before: Song, song: ReadSong, format: SongFileFormat | null): boolean {
  const cannot = new Set<string>(format ? SONG_FILE_LIMITS[format] : []);
  const text = (value: string | null) => value?.trim() || null;
  const fields = (s: Pick<Song, "title" | "number" | "authors" | "copyright" | "ccliNumber" | "notes" | "order" | "sections">) => [
    s.title.trim(),
    text(s.authors),
    text(s.copyright),
    text(s.ccliNumber),
    cannot.has("number") ? null : text(s.number),
    cannot.has("notes") ? null : text(s.notes),
    cannot.has("order") ? null : s.order,
    heldSections(s.sections, cannot),
  ];
  return JSON.stringify(fields(before)) !== JSON.stringify(fields(song));
}

/** A song file's format by its words: a `.txt` may be SongSelect or ChordPro. */
const formatOf = (file: string, text: string): SongFileFormat =>
  isXml(file) ? "openlyrics" : isChordPro(text) ? "chordpro" : "songselect";

/**
 * Saving a song tied to a file writes that file first, in its own format
 * (owner, 2026-11-05: «se edita en Lumina y se edita el archivo real, siempre
 * así»): a linked folder's song, or a library song imported from a song file.
 * Only when the edit changes something the file holds (owner, 2026-11-06): a
 * theme, or notes a ChordPro file has no place for, never touch it — asked of
 * the file's real format (a `.txt` may be either kind) BEFORE anything below
 * can refuse, so an edit that never reaches the file never fails because of
 * it. The file is rewritten in place (`rewrite…`: its other songs and what the
 * app never read stay), in the encoding it was read in — untouched text stays
 * the same bytes, and a wrong guess (a Windows-1251 file read as Windows-1252)
 * never breaks it —, UTF-8 only when the edit has a character that encoding
 * cannot hold (with a byte-order mark, or a declaration that says so). Nothing
 * for a song that lives only in the app.
 *
 * A file changed outside the app since it was read is not overwritten
 * (`SONG_FILE_CHANGED`) but read again — a linked folder's by the caller, a
 * library song's here —, so saving once more replaces it, as the message says.
 * A read-only file is refused (`SONG_FILE_UNWRITABLE`): the rename below would
 * replace it anyway. A library song whose file is gone is untied and saved in
 * the app; a linked folder's song IS its file, so that one is refused. Written
 * to a sibling of the file a symbolic link points at (the link stays a link),
 * with the file's permissions where its file system keeps any, and renamed
 * over it, so a crash halfway never leaves half a song on disk.
 */
export function writeSongFile(id: number, song: ReadSong): void {
  const repo = getSongsRepo();
  const source = repo.source(id);
  const before = repo.get(id);
  if (!source || !before) return;
  const file = source.path;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    // Gone: its format by its name — a `.txt` as SongSelect's, the one that
    // holds the least, so only an edit that surely reached it is refused.
    if (!changesFile(before, song, songFileFormat(file))) return;
    if (source.folder === null) {
      repo.untieFile(id);
      return;
    }
    throw new IpcError({ code: "SONG_FILE_MISSING", message: mt("songs.fileMissing") });
  }
  const unwritable = () => new IpcError({ code: "SONG_FILE_UNWRITABLE", message: mt("songs.fileUnwritable") });
  let read: ReturnType<typeof readText> | null = null;
  try {
    read = readText(fs.readFileSync(file));
  } catch (error) {
    // Unreadable: its format by its name, and refused below if the edit reaches it.
    console.warn("[songs] song file unreadable", file, error);
  }
  const format = read ? formatOf(file, read.text) : songFileFormat(file);
  if (!changesFile(before, song, format)) return;
  if (mtimeOf(stat) !== source.mtime) {
    if (source.folder === null) {
      const again = readSongFileSafely(file);
      if (again) repo.syncLibraryFile(file, mtimeOf(stat), again.songs, again.format);
    }
    throw new IpcError({ code: "SONG_FILE_CHANGED", message: mt("songs.fileChanged") });
  }
  let real: string;
  try {
    real = fs.realpathSync(file);
    fs.accessSync(real, fs.constants.W_OK);
  } catch {
    throw unwritable();
  }
  if (!read || !format) throw unwritable();
  const locale = getSettingsRepo().get("ui.locale");
  // Which song of the file it is: by its title, then its place (`matchRows`) —
  // a place counted another way by an older build must never write over
  // another song. Not found at all: added at the end as a block of its own,
  // whose place is the count of the blocks there (`chordProSongs`, an empty
  // one counted), nothing overwritten.
  const songs = readSongFile(file, read.text)?.songs ?? [];
  const found = matchRows([{ id, title: before.title, sourceIndex: source.index }], songs).indexOf(id);
  const index =
    format === "chordpro" ? (songs[found]?.index ?? chordProSongs(read.text, fallbackTitle(file), locale).length) : 0;
  let text =
    format === "openlyrics"
      ? rewriteOpenLyrics(read.text, song)
      : format === "chordpro"
        ? rewriteChordPro(read.text, index, song, fallbackTitle(file), locale)
        : rewriteSongSelect(read.text, song);
  let { encoding, bom } = read;
  if (encodeText(text, encoding, bom) === null) {
    encoding = "utf-8";
    bom = format !== "openlyrics";
  }
  if (format === "openlyrics") text = withXmlEncoding(text, encoding);
  const temporary = `${real}.lumina-tmp`;
  try {
    fs.writeFileSync(temporary, encodeText(text, encoding, bom)!);
    try {
      fs.chmodSync(temporary, stat.mode & 0o7777);
    } catch (error) {
      // Best-effort: a network share or an exFAT stick keeps no Unix
      // permissions, and the song is written all the same.
      console.warn("[songs] could not keep the song file's permissions", file, error);
    }
    fs.renameSync(temporary, real);
  } catch (error) {
    console.warn("[songs] could not write the song file", file, error);
    fs.rmSync(temporary, { force: true });
    throw unwritable();
  }
  // Tied to the block just written — never to another song of the file, even
  // when this one does not read back.
  const written = readSongFile(file, text)?.songs.find((entry) => entry.index === index)?.song ?? null;
  repo.wroteFile(
    [...new Set([file, real])],
    { id, title: before.title, index, readAt: source.mtime },
    mtimeOf(fs.statSync(real)),
    written,
    format,
  );
}

/** What a file holds now, or nothing when it no longer reads. */
function readSongFileSafely(file: string): ReturnType<typeof readSongFile> {
  try {
    return readSongFile(file, readText(fs.readFileSync(file)).text);
  } catch (error) {
    console.warn("[songs] song file unreadable", file, error);
    return null;
  }
}
