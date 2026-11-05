import { and, eq, gte, lt, max } from "drizzle-orm";
import Database from "better-sqlite3";
import type { Db } from "../client";
import { songs, songThemes, songUses } from "../schema";
import { toFtsQuery } from "../fts-query";
import { IpcError } from "@shared/ipc/result";
import { normalizeOrder, normalizeSections, normalizeSongTheme } from "@shared/song-validators";
import { songLyricsText } from "@shared/song-text";
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

  create(input: Omit<SongUpsert, "id">): Song {
    const now = Date.now();
    const id = this.db
      .insert(songs)
      .values({ ...toRow(input), createdAt: now, updatedAt: now })
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
  search(query: string, limit = 200): SongSearchHit[] {
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return [];
    const stmt = this.sqlite.prepare(`
      SELECT rowid AS songId,
             snippet(songs_fts, 3, char(1), char(2), '…', 10) AS snippet
      FROM songs_fts
      WHERE songs_fts MATCH ?
      ORDER BY bm25(songs_fts, 10.0, 8.0, 3.0, 1.0)
      LIMIT ?
    `);
    try {
      const rows = stmt.all(ftsQuery, limit) as { songId: number; snippet: string | null }[];
      return rows.map((row) => ({
        songId: row.songId,
        snippet: row.snippet?.includes("\u0001") ? row.snippet : null,
      }));
    } catch {
      // A pathological query that still slipped through `toFtsQuery`.
      return [];
    }
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
