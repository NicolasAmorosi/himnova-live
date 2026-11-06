import path from "node:path";
import { and, eq, gte, inArray, isNotNull, isNull, lt, max, or } from "drizzle-orm";
import Database from "better-sqlite3";
import type { Db } from "../client";
import { songs, songThemes, songUses } from "../schema";
import { DraftRepo } from "./draft.repo";
import { toFtsQuery } from "../fts-query";
import { IpcError } from "@shared/ipc/result";
import { normalizeOrder, normalizeSections, normalizeSongTheme } from "@shared/song-validators";
import { songLyricsText, translationByLine, translationSections, withTranslation } from "@shared/song-text";
import { SONG_FILE_LIMITS, type SongFileFormat } from "@shared/song-file-limits";
import type { Song, SongSearchHit, SongTheme, SongThemeRow, SongUpsert, SongUse } from "@shared/types/song";

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** A row as a `Song`, whatever it holds: a section that is not whole costs
 *  that section, never the song or the boot. */
function toSong(row: typeof songs.$inferSelect): Song {
  return {
    id: row.id,
    title: row.title,
    number: row.number,
    authors: row.authors,
    copyright: row.copyright,
    ccliNumber: row.ccliNumber,
    notes: row.notes,
    sections: normalizeSections(parseJson(row.sectionsJson)),
    order: normalizeOrder(parseJson(row.orderJson)),
    themeId: row.themeId,
    sourceFolder: row.sourceFolder,
    file:
      row.sourceFolder !== null && row.sourceFile !== null ? path.join(row.sourceFolder, row.sourceFile) : row.filePath,
    updatedAt: row.updatedAt,
  };
}

/** A blank field is no field. */
function text(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function toRow(input: Omit<SongUpsert, "id">) {
  return {
    title: input.title.trim(),
    number: text(input.number),
    authors: text(input.authors),
    copyright: text(input.copyright),
    ccliNumber: text(input.ccliNumber),
    notes: text(input.notes),
    sectionsJson: JSON.stringify(input.sections),
    orderJson: JSON.stringify(input.order),
    themeId: input.themeId,
    lyricsText: songLyricsText(input.sections),
  };
}

function toThemeRow(row: typeof songThemes.$inferSelect): SongThemeRow {
  return { id: row.id, name: row.name, style: normalizeSongTheme(parseJson(row.styleJson)) };
}

/** A song file an imported song came from: its whole path, which song of
 *  it (a ChordPro file may hold several: `{new_song}` counted), its mtime when
 *  read, and its format. */
export type SongFileOrigin = { path: string; index: number; mtime: number; format: SongFileFormat };

const fileColumns = (file: SongFileOrigin) => ({ filePath: file.path, sourceIndex: file.index, sourceMtime: file.mtime });

/** A song read from a file, and which song of the file it is. */
export type FileSong = { song: Omit<SongUpsert, "id">; index: number };

/**
 * Which row each song read from a file goes into (`undefined` = a new one):
 * the row with its title AND its place, then its title anywhere — a song
 * removed above it outside the app must not shift the others, nor a saved
 * program's song —, then its place among the rows left (a title edited
 * outside the app).
 */
export function matchRows(
  rows: readonly { id: number; title: string; sourceIndex: number | null }[],
  read: readonly FileSong[],
): (number | undefined)[] {
  const ids: (number | undefined)[] = read.map(() => undefined);
  const taken = new Set<number>();
  const pass = (fits: (row: (typeof rows)[number], song: FileSong) => boolean) =>
    read.forEach((song, i) => {
      if (ids[i] !== undefined) return;
      const row = rows.find((candidate) => !taken.has(candidate.id) && fits(candidate, song));
      if (row) {
        taken.add(row.id);
        ids[i] = row.id;
      }
    });
  const sameTitle = (row: (typeof rows)[number], { song }: FileSong) => row.title === song.title.trim();
  pass((row, song) => sameTitle(row, song) && (row.sourceIndex ?? 0) === song.index);
  pass(sameTitle);
  pass((row, song) => (row.sourceIndex ?? 0) === song.index);
  return ids;
}

/**
 * A song read from its file again, onto the row that holds it: the fields the
 * file holds come from it, the others (`SONG_FILE_LIMITS`: a ChordPro file
 * has no notes, a SongSelect one no chords) stay the app's — reading the file
 * again must never take them away. The theme is always the app's.
 */
export function fromFile(row: Song, file: Omit<SongUpsert, "id">, format: SongFileFormat): Omit<SongUpsert, "id"> {
  const cannot = new Set(SONG_FILE_LIMITS[format]);
  const sameWords = songLyricsText(row.sections) === songLyricsText(file.sections);
  // A SongSelect file has the words only: while they are the same, the
  // app's slides and chords stand.
  const sections = (cannot.has("slides") || cannot.has("chords")) && sameWords ? row.sections : file.sections;
  return {
    ...file,
    number: cannot.has("number") ? row.number : file.number,
    notes: cannot.has("notes") ? row.notes : file.notes,
    order: cannot.has("order") ? row.order : file.order,
    // The same words: the translation line by line, however the file cuts
    // them; words edited outside the app: by section and slide, the best guess.
    sections:
      cannot.has("translation") && sections !== row.sections
        ? sameWords
          ? translationByLine(sections, row.sections)
          : withTranslation(sections, translationSections(row.sections))
        : sections,
    themeId: row.themeId,
  };
}

/** `songs` and `song_themes`. Knows nothing about what is live. */
export class SongsRepo {
  constructor(
    private readonly db: Db,
    private readonly sqlite: Database.Database,
  ) {}

  /** Every song, whole. The renderer sorts and filters: it holds the library
   *  to preview and project without a round trip. */
  // ponytail: the whole library in one answer; page it if a church's library makes boot slow.
  list(): Song[] {
    return this.db.select().from(songs).orderBy(songs.title, songs.id).all().map(toSong);
  }

  get(id: number): Song | null {
    const row = this.db.select().from(songs).where(eq(songs.id, id)).get();
    return row ? toSong(row) : null;
  }

  /** `file`: a song imported from a song file stays tied to it — which file,
   *  which song of it, and its mtime when read. */
  create(input: Omit<SongUpsert, "id">, file?: SongFileOrigin): Song {
    const now = Date.now();
    const id = this.db
      .insert(songs)
      .values({ ...toRow(input), ...(file ? fileColumns(file) : {}), createdAt: now, updatedAt: now })
      .run().lastInsertRowid as number;
    const song = this.get(id);
    if (!song) throw new Error(`Song ${id} vanished right after being created`);
    return song;
  }

  update(id: number, input: Omit<SongUpsert, "id">): Song {
    this.db
      .update(songs)
      .set({ ...toRow(input), updatedAt: Date.now() })
      .where(eq(songs.id, id))
      .run();
    const song = this.get(id);
    if (!song) throw new IpcError({ code: "SONG_NOT_FOUND", message: `Song ${id} not found` });
    return song;
  }

  duplicate(id: number, title: string): Song {
    const source = this.get(id);
    if (!source) throw new IpcError({ code: "SONG_NOT_FOUND", message: `Song ${id} not found` });
    const { id: _id, updatedAt: _updatedAt, ...rest } = source;
    return this.create({ ...rest, title });
  }

  /** A song a saved program still uses is refused as `SONG_IN_USE` — the
   *  question `song:usages` answers, same as `OverlaysRepo.delete`. */
  delete(id: number): void {
    try {
      this.db.delete(songs).where(eq(songs.id, id)).run();
    } catch (error) {
      if (error instanceof Database.SqliteError && error.message.includes("FOREIGN KEY constraint failed")) {
        throw new IpcError({ code: "SONG_IN_USE", message: `Song ${id} is still referenced by a program item` });
      }
      throw error;
    }
  }

  /** `songId` went live at `at`: written once per song per local day — what
   *  the CCLI report counts (owner, 2026-11-05). */
  recordUse(songId: number, at = Date.now()): void {
    const dayStart = new Date(at);
    dayStart.setHours(0, 0, 0, 0);
    const today = this.db
      .select({ id: songUses.id })
      .from(songUses)
      .where(and(eq(songUses.songId, songId), gte(songUses.usedAt, dayStart.getTime())))
      .get();
    if (today) return;
    const song = this.get(songId);
    if (!song) return;
    this.db
      .insert(songUses)
      .values({ songId, usedAt: at, title: song.title, authors: song.authors, ccliNumber: song.ccliNumber })
      .run();
  }

  /** The songs used in `[from, to)`, each with the days it was used — a song
   *  still in the library under its current title, authors and CCLI number. */
  usesBetween(from: number, to: number): SongUse[] {
    const rows = this.db
      .select({
        songId: songUses.songId,
        usedAt: songUses.usedAt,
        title: songUses.title,
        authors: songUses.authors,
        ccliNumber: songUses.ccliNumber,
        currentTitle: songs.title,
        currentAuthors: songs.authors,
        currentCcli: songs.ccliNumber,
      })
      .from(songUses)
      .leftJoin(songs, eq(songs.id, songUses.songId))
      .where(and(gte(songUses.usedAt, from), lt(songUses.usedAt, to)))
      .orderBy(songUses.usedAt)
      .all();
    const byKey = new Map<string, SongUse>();
    for (const row of rows) {
      const current = row.currentTitle !== null;
      const title = current ? row.currentTitle! : row.title;
      const ccliNumber = current ? row.currentCcli : row.ccliNumber;
      const key = row.songId !== null && current ? `song:${row.songId}` : `gone:${title}\n${ccliNumber ?? ""}`;
      const use = byKey.get(key) ?? { title, authors: current ? row.currentAuthors : row.authors, ccliNumber, days: [] };
      use.days.push(row.usedAt);
      byKey.set(key, use);
    }
    return [...byKey.values()];
  }

  /**
   * Title, number, authors and lyrics, without accents. The title weighs the
   * most. `snippet` is the lyrics around the match, marked with the control
   * characters `parseSnippet` reads — never markup; `null` when the lyrics
   * did not match at all.
   */
  search(query: string, limit = 200, folder: string | null = null): SongSearchHit[] {
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return [];
    // Inside what the tab shows (owner, 2026-11-05): the library, or one
    // linked folder — filtered before the LIMIT, so its matches are never
    // crowded out by the rest.
    const stmt = this.sqlite.prepare(`
      SELECT songs_fts.rowid AS songId,
             snippet(songs_fts, 3, char(1), char(2), '…', 10) AS snippet
      FROM songs_fts
      JOIN songs ON songs.id = songs_fts.rowid
       AND ${folder === null ? "songs.source_folder IS NULL" : "songs.source_folder = @folder"}
      WHERE songs_fts MATCH @query
      ORDER BY bm25(songs_fts, 10.0, 8.0, 3.0, 1.0)
      LIMIT @limit
    `);
    try {
      const rows = stmt.all({ query: ftsQuery, limit, ...(folder === null ? {} : { folder }) }) as {
        songId: number;
        snippet: string | null;
      }[];
      return rows.map((row) => ({
        songId: row.songId,
        snippet: row.snippet?.includes("\u0001") ? row.snippet : null,
      }));
    } catch {
      // A pathological query that still slipped through `toFtsQuery`.
      return [];
    }
  }

  /** The library's songs — what an import checks for repeats against. */
  listLibrary(): Song[] {
    return this.db.select().from(songs).where(isNull(songs.sourceFolder)).all().map(toSong);
  }

  /** The file a song is saved into, which song of it, and its mtime when last
   *  read or written; `null` for a song that lives only in the app. `folder`:
   *  a linked folder's song (`null` = a library song tied to its file). */
  source(id: number): { path: string; folder: string | null; index: number; mtime: number } | null {
    const row = this.db.select().from(songs).where(eq(songs.id, id)).get();
    if (!row) return null;
    const where = { index: row.sourceIndex ?? 0, mtime: row.sourceMtime ?? 0 };
    if (row.sourceFolder !== null && row.sourceFile !== null) {
      return { path: path.join(row.sourceFolder, row.sourceFile), folder: row.sourceFolder, ...where };
    }
    return row.filePath === null ? null : { path: row.filePath, folder: null, ...where };
  }

  /** A library song tied to `file` from now on (an import found it already
   *  in the library, same title and words). */
  tieToFile(id: number, file: SongFileOrigin): void {
    this.db.update(songs).set(fileColumns(file)).where(eq(songs.id, id)).run();
  }

  /** A song that lives only in the app from now on: a library song whose file
   *  is gone, or a linked folder's song a saved program holds after its file
   *  let it go (owner, 2026-11-06: it becomes a library song, saveable). */
  untieFile(id: number): void {
    this.db
      .update(songs)
      .set({ sourceFolder: null, sourceFile: null, filePath: null, sourceIndex: null, sourceMtime: null })
      .where(eq(songs.id, id))
      .run();
  }

  /** The songs the unsaved order of service sings (`program_draft`): no
   *  foreign key guards them, as one guards a saved program's. */
  private drafted(): ReadonlySet<number> {
    return new DraftRepo(this.db).songIds();
  }

  /** A linked folder's song its file no longer holds: gone, unless a saved
   *  program or the unsaved order of service (`drafted`) sings it — then a
   *  library song (`untieFile`), never a dangling id in the draft. */
  private release(id: number, drafted: ReadonlySet<number>): void {
    if (drafted.has(id)) {
      this.untieFile(id);
      return;
    }
    try {
      this.delete(id);
    } catch (error) {
      if (!(error instanceof IpcError && error.code === "SONG_IN_USE")) throw error;
      this.untieFile(id);
    }
  }

  /** The library songs tied to `file` take what it holds now (`fromFile`:
   *  their theme, and what the format cannot hold, stay) and its `mtime`: the
   *  file changed outside the app. Each finds its song by title, then by
   *  position (`matchRows`); one the file no longer holds lives on in the app,
   *  untied. */
  syncLibraryFile(file: string, mtime: number, read: readonly FileSong[], format: SongFileFormat): void {
    const now = Date.now();
    this.sqlite.transaction(() => {
      const rows = this.db
        .select()
        .from(songs)
        .where(and(isNull(songs.sourceFolder), eq(songs.filePath, file)))
        .all();
      const ids = matchRows(rows, read);
      read.forEach(({ song, index }, i) => {
        const row = rows.find((candidate) => candidate.id === ids[i]);
        if (!row) return;
        this.db
          .update(songs)
          .set({ ...toRow(fromFile(toSong(row), song, format)), sourceIndex: index, sourceMtime: mtime, updatedAt: now })
          .where(eq(songs.id, row.id))
          .run();
      });
      for (const row of rows) if (!ids.includes(row.id)) this.untieFile(row.id);
    })();
  }

  /** The songs read from `folder`'s files, keyed by file name. */
  fromFolder(folder: string): Map<string, { song: Song; mtime: number }[]> {
    const byFile = new Map<string, { song: Song; mtime: number }[]>();
    const rows = this.db.select().from(songs).where(eq(songs.sourceFolder, folder)).orderBy(songs.sourceIndex).all();
    for (const row of rows) {
      const list = byFile.get(row.sourceFile ?? "") ?? [];
      list.push({ song: toSong(row), mtime: row.sourceMtime ?? 0 });
      byFile.set(row.sourceFile ?? "", list);
    }
    return byFile;
  }

  /**
   * What `file` (in `folder`) holds now, as its songs: each song of the file
   * keeps its row — and with it its id, its theme and the programs that use it
   * — so a file edited outside the app updates in place. A song finds its row
   * by its title first, then by its position (`matchRows`): a song removed
   * above it must not shift the others. A row the file no longer holds goes
   * (`release`).
   */
  syncFile(folder: string, file: string, mtime: number, read: readonly FileSong[], format: SongFileFormat): Song[] {
    const now = Date.now();
    const out: Song[] = [];
    this.sqlite.transaction(() => {
      const rows = this.db
        .select()
        .from(songs)
        .where(and(eq(songs.sourceFolder, folder), eq(songs.sourceFile, file)))
        .all();
      const ids = matchRows(rows, read);
      read.forEach(({ song, index }, i) => {
        const row = rows.find((candidate) => candidate.id === ids[i]);
        const values = {
          ...toRow(row ? fromFile(toSong(row), song, format) : song),
          sourceIndex: index,
          sourceMtime: mtime,
          updatedAt: now,
        };
        let id = row?.id;
        if (id !== undefined) this.db.update(songs).set(values).where(eq(songs.id, id)).run();
        else {
          id = this.db
            .insert(songs)
            .values({ ...values, sourceFolder: folder, sourceFile: file, createdAt: now })
            .run().lastInsertRowid as number;
        }
        out.push(this.get(id)!);
      });
      const drafted = this.drafted();
      for (const row of rows) if (!ids.includes(row.id)) this.release(row.id, drafted);
    })();
    return out;
  }

  /** `folder`'s songs whose file is no longer there (deleted, renamed, no
   *  longer a song file): gone, or library songs (`release`). */
  forgetFiles(folder: string, present: ReadonlySet<string>): void {
    const rows = this.db.select({ id: songs.id, file: songs.sourceFile }).from(songs).where(eq(songs.sourceFolder, folder)).all();
    this.sqlite.transaction(() => {
      const drafted = this.drafted();
      for (const row of rows) if (!present.has(row.file ?? "")) this.release(row.id, drafted);
    })();
  }

  /** The songs of folders no longer linked (the Songs tab let one go): gone,
   *  or library songs (`release`). */
  forgetFolders(linked: readonly string[]): void {
    const rows = this.db.select({ id: songs.id, folder: songs.sourceFolder }).from(songs).where(isNotNull(songs.sourceFolder)).all();
    this.sqlite.transaction(() => {
      const drafted = this.drafted();
      for (const row of rows) if (!linked.includes(row.folder!)) this.release(row.id, drafted);
    })();
  }

  /**
   * `file` (any of `paths`: the path as tied, and the one it resolves to) was
   * written, `saved`'s song in it now at `index` and reading as `written`.
   * Every row tied to it that was read when the saved one was (`readAt`)
   * matches its new `mtime`; one read at another time may hold words the file
   * no longer has, and keeps its own to read the file again. The same song tied
   * the OTHER way — the file imported into the library and in a linked folder —
   * takes its words (`fromFile`), so saving from one side never reads as
   * «changed outside Lumina» on the other: found by its block (`index`), its
   * old title as a check — never by the title alone, two songs of a file may
   * share one (a file's name is the title of every song without `{title}`),
   * nor among the saved row's own file's rows, which are other songs. The
   * saved row's own words are the caller's to write.
   */
  wroteFile(
    paths: readonly string[],
    saved: { id: number; title: string; index: number; readAt: number },
    mtime: number,
    written: Omit<SongUpsert, "id"> | null,
    format: SongFileFormat,
  ): void {
    const tied = or(
      and(isNull(songs.sourceFolder), inArray(songs.filePath, [...paths])),
      ...paths.map((file) => and(eq(songs.sourceFolder, path.dirname(file)), eq(songs.sourceFile, path.basename(file)))),
    );
    this.sqlite.transaction(() => {
      const rows = this.db.select().from(songs).where(tied).all();
      const own = rows.find((row) => row.id === saved.id);
      // No saved row to tell the sides apart by: no twin at all.
      const sameTie = (row: (typeof rows)[number]) =>
        own === undefined ||
        (row.sourceFolder === own.sourceFolder &&
          row.sourceFile === own.sourceFile &&
          row.filePath === own.filePath);
      const isTwin = (row: (typeof rows)[number]) =>
        written !== null && !sameTie(row) && (row.sourceIndex ?? 0) === saved.index && row.title === saved.title;
      for (const row of rows) {
        const values =
          row.id === saved.id
            ? { sourceIndex: saved.index, sourceMtime: mtime }
            : isTwin(row) && written
              ? { ...toRow(fromFile(toSong(row), written, format)), sourceIndex: saved.index, sourceMtime: mtime, updatedAt: Date.now() }
              : row.sourceMtime === saved.readAt
                ? { sourceMtime: mtime }
                : null;
        if (values) this.db.update(songs).set(values).where(eq(songs.id, row.id)).run();
      }
    })();
  }

  listThemes(): SongThemeRow[] {
    return this.db.select().from(songThemes).orderBy(songThemes.sortOrder, songThemes.id).all().map(toThemeRow);
  }

  createTheme(name: string, style: SongTheme): SongThemeRow {
    const now = Date.now();
    // At the bottom, like an imported Bible: until a default is chosen in
    // Settings (F3), the first theme IS the default, and a new one must not
    // take its place behind the operator's back.
    const highest = this.db.select({ value: max(songThemes.sortOrder) }).from(songThemes).get()?.value ?? null;
    const id = this.db
      .insert(songThemes)
      .values({
        name,
        styleJson: JSON.stringify(style),
        sortOrder: highest === null ? 0 : highest + 1,
        createdAt: now,
        updatedAt: now,
      })
      .run().lastInsertRowid as number;
    return toThemeRow(this.db.select().from(songThemes).where(eq(songThemes.id, id)).get()!);
  }

  updateTheme(id: number, name: string, style: SongTheme): SongThemeRow {
    this.db
      .update(songThemes)
      .set({ name, styleJson: JSON.stringify(style), updatedAt: Date.now() })
      .where(eq(songThemes.id, id))
      .run();
    const row = this.db.select().from(songThemes).where(eq(songThemes.id, id)).get();
    if (!row) throw new IpcError({ code: "SONG_THEME_NOT_FOUND", message: `Song theme ${id} not found` });
    return toThemeRow(row);
  }

  /** The last theme is never deleted — a song always has a look to fall back
   *  to. Its songs go back to the default theme (`theme_id` is `set null`). */
  deleteTheme(id: number): void {
    if (this.listThemes().length <= 1) {
      throw new IpcError({ code: "SONG_THEME_LAST", message: "The last song theme cannot be deleted" });
    }
    this.db.delete(songThemes).where(eq(songThemes.id, id)).run();
  }
}
