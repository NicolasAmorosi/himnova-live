import fs from "node:fs";
import path from "node:path";
import { IpcError } from "@shared/ipc/result";
import type { SongFileFormat } from "@shared/song-file-limits";
import { translationByLine } from "@shared/song-text";
import type { Song, SongImportResult, SongSection, SongUpsert } from "@shared/types/song";
import { mt } from "../i18n";
import { findEasyWorshipData, readEasyWorship, songIdentity, type SongsRead } from "../songs/easyworship";
import { readOpenLpDatabase, readOpenLyricsFiles } from "../songs/openlp";
import { readSongTextFiles } from "../songs/text-files";
import { fromFile } from "../db/repositories/songs.repo";
import { getDbHandle, getSettingsRepo, getSongsRepo } from "./repos";

/** SQLite's own first bytes: EasyWorship 2009 and older kept their songs in
 *  Paradox tables (`Songs.DB` + `Songs.MB`), another format altogether. */
function isSqlite(file: string): boolean {
  try {
    const head = Buffer.alloc(16);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, head, 0, 16, 0);
    } finally {
      fs.closeSync(fd);
    }
    return head.toString("latin1") === "SQLite format 3\0";
  } catch {
    return false;
  }
}

/** EasyWorship's songs from its `Databases/Data` folder (or a folder above
 *  it); `picked`, the database the operator chose in it. */
function readEasyWorshipFolder(folder: string, picked?: string): SongsRead {
  if (picked && !isSqlite(picked)) throw new IpcError({ code: "EW_OLD", message: mt("songs.ewOld") });
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

const WRITE_CHUNK = 100;

export const importEasyWorshipFolder = (folder: string): Promise<SongImportResult> => writeSongs(readEasyWorshipFolder(folder));
export const importOpenLpDatabase = (file: string): Promise<SongImportResult> => writeSongs(readOpenLp(file));
export const importOpenLyricsFiles = (files: readonly string[]): Promise<SongImportResult> => writeSongs(readOpenLyricsFiles(files));
export const importSongTextFiles = (files: readonly string[]): Promise<SongImportResult> =>
  writeSongs(readSongTextFiles(files, getSettingsRepo().get("ui.locale")));

/** EasyWorship's two databases: picking either one means its folder. */
const EASYWORSHIP_FILE = /^song(s|words)\.db$/i;

/**
 * Whatever «Importar» was given, in one pick (owner, 2026-11-05: no menu of
 * programs): each file read by what it is — OpenLyrics `.xml`, OpenLP's
 * database, EasyWorship's `Songs.db` (its folder), and SongSelect or ChordPro
 * text for the rest. A database that cannot be read is a problem among the
 * rest; when nothing at all came in, its own error says why instead.
 */
export function importSongFiles(files: readonly string[]): Promise<SongImportResult> {
  const reads: SongsRead[] = [];
  let failure: IpcError | null = null;
  const extension = (file: string) => path.extname(file).slice(1).toLowerCase();
  const databases = files.filter((file) => ["sqlite", "db"].includes(extension(file)));
  const easyWorship = new Map(
    databases.filter((file) => EASYWORSHIP_FILE.test(path.basename(file))).map((file) => [path.dirname(file), file]),
  );
  const sources: (() => SongsRead)[] = [
    ...[...easyWorship].map(([folder, picked]) => () => readEasyWorshipFolder(folder, picked)),
    ...databases.filter((file) => !EASYWORSHIP_FILE.test(path.basename(file))).map((file) => () => readOpenLp(file)),
  ];
  for (const read of sources) {
    try {
      reads.push(read());
    } catch (error) {
      if (error instanceof IpcError) failure ??= error;
      reads.push({ songs: [], problems: 0, unsupported: 1 });
    }
  }
  reads.push(readOpenLyricsFiles(files.filter((file) => extension(file) === "xml")));
  const texts = files.filter((file) => !databases.includes(file) && extension(file) !== "xml");
  reads.push(readSongTextFiles(texts, getSettingsRepo().get("ui.locale")));
  const read: SongsRead = {
    songs: reads.flatMap((r) => r.songs),
    problems: reads.reduce((sum, r) => sum + r.problems, 0),
    unsupported: reads.reduce((sum, r) => sum + (r.unsupported ?? 0), 0),
  };
  if (failure && read.songs.length === 0) return Promise.reject(failure);
  return writeSongs(read);
}

/**
 * The library's copy of a song refreshed from a file of the same song (an
 * import's repeat: same title, same words line for line): what the file holds
 * wins, and what it does not — its format has no place for it (`fromFile`), or
 * this file simply has none: no number, notes, authors, order, chords or
 * translation — stays the copy's (owner, 2026-11-06: never lose anything). The
 * next save writes them into the file, where its format holds them.
 */
function refreshedFrom(copy: Song, file: Omit<SongUpsert, "id">, format: SongFileFormat): Omit<SongUpsert, "id"> {
  const read = fromFile(copy, file, format);
  const has = (sections: readonly SongSection[], field: "chords" | "translation") =>
    sections.some((section) => section.slides.some((slide) => slide[field] !== undefined));
  let { sections } = read;
  if (!has(sections, "chords") && has(copy.sections, "chords")) {
    // The same lines in the same sequence (`songIdentity`): each line takes
    // the copy's chords, whatever the file's slides and sections.
    const chords = copy.sections.flatMap((section) =>
      section.slides.flatMap((slide) => slide.lines.map((_, index) => slide.chords?.[index] ?? [])),
    );
    let line = 0;
    sections = sections.map((section) => ({
      ...section,
      slides: section.slides.map((slide) => {
        const own = slide.lines.map(() => chords[line++] ?? []);
        return own.some((chord) => chord.length > 0) ? { ...slide, chords: own } : slide;
      }),
    }));
  }
  if (!has(sections, "translation") && has(copy.sections, "translation")) {
    sections = translationByLine(sections, copy.sections);
  }
  const or = (value: string | null, kept: string | null) => (value?.trim() ? value : kept);
  return {
    ...read,
    number: or(read.number, copy.number),
    authors: or(read.authors, copy.authors),
    copyright: or(read.copyright, copy.copyright),
    ccliNumber: or(read.ccliNumber, copy.ccliNumber),
    notes: or(read.notes, copy.notes),
    sections,
    // The copy's own order while every section it sings is still there.
    order:
      read.order.length === 0 && copy.order.every((key) => sections.some((section) => section.key === key))
        ? copy.order
        : read.order,
  };
}

/**
 * Writes what a reader found into the library. A song already there — same
 * title, same words — is skipped and counted, and so is a second copy inside
 * the same import; one with the same title and other words comes in as a song
 * of its own (owner, 2026-11-04: it may be another version). A song of a
 * linked folder is not the library's: the same song there is no repeat. A
 * song read from a song file stays tied to it (owner, 2026-11-05), and so does
 * the library's repeat of it when that one had no file yet — which first
 * takes what the file holds (owner, 2026-11-06: its chords, authors, CCLI
 * number…; `refreshedFrom` keeps its theme and what the file does not hold),
 * or saving it would write them out of the file. One transaction: an import
 * that fails halfway leaves the library as it was.
 */
async function writeSongs(read: SongsRead): Promise<SongImportResult> {
  const repo = getSongsRepo();
  const known = new Map(repo.listLibrary().map((song) => [songIdentity(song), song]));
  let imported = 0;
  let repeated = 0;
  // A hundred songs per transaction, the event loop let go between them: a whole songbook (1 207
  // songs, ~0.3 ms each with the search index) in one held main ~0.33 s, and with it every frame of
  // a media-engine video on air (2026-11-10 review, agent7-02) — the same as `library-import.ts`.
  for (let start = 0; start < read.songs.length; start += WRITE_CHUNK) {
    if (start > 0) await new Promise((resolve) => setImmediate(resolve));
    getDbHandle().sqlite.transaction(() => {
      for (const song of read.songs.slice(start, start + WRITE_CHUNK)) {
        const identity = songIdentity(song);
        const existing = known.get(identity);
        if (existing) {
          if (song.origin && existing.file === null) {
            const refreshed = repo.update(existing.id, refreshedFrom(existing, song, song.origin.format));
            repo.tieToFile(existing.id, song.origin);
            known.set(identity, { ...refreshed, file: song.origin.path });
          }
          repeated += 1;
          continue;
        }
        known.set(identity, repo.create(song, song.origin));
        imported += 1;
      }
    })();
  }
  return { imported, repeated, problems: read.problems, unsupported: read.unsupported ?? 0 };
}
