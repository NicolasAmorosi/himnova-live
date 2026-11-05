import { and, eq, max } from "drizzle-orm";
import type Database from "better-sqlite3";
import type { Db } from "../client";
import { toFtsQuery } from "../fts-query";
import { bibleBooks, bibleVersions, bibleVerses } from "../schema";
import type {
  BibleBookDTO,
  BibleSearchHit,
  BibleVerseDTO,
  BibleVersionDTO,
} from "@shared/types/bible";

/** One mapper, so `listVersions` and `getVersion` can never describe the same
 *  row differently. */
function toVersionDTO(row: typeof bibleVersions.$inferSelect): BibleVersionDTO {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    language: row.language,
    isBuiltin: row.isBuiltin === 1,
    verseCount: row.verseCount,
  };
}

export class BibleRepo {
  constructor(
    private readonly db: Db,
    private readonly sqlite: Database.Database,
  ) {}

  /** The operator's own arrangement, not the order the versions happened to be
   *  installed in. `installedAt` stays as the tie-breaker so two rows that
   *  share a `sortOrder` — which only happens before the first `reorder()`
   *  renormalizes them — still come out in a stable order rather than in
   *  whatever SQLite feels like. Same scheme as `ProgramsRepo.list`. */
  listVersions(): BibleVersionDTO[] {
    return this.db
      .select()
      .from(bibleVersions)
      .orderBy(bibleVersions.sortOrder, bibleVersions.installedAt)
      .all()
      .map(toVersionDTO);
  }

  /** Sort key for a newly imported version: one slot past the current maximum,
   *  so it lands at the BOTTOM of the list. The mirror image of
   *  `ProgramsRepo.topSortOrder`, and deliberately so — a saved program is
   *  created because it is about to be used, while an imported bible is one
   *  more option beside the one the church actually reads from. Putting it on
   *  top would push RV1909 down the picker without anybody asking. */
  nextSortOrder(): number {
    const highest = this.db.select({ value: max(bibleVersions.sortOrder) }).from(bibleVersions).get()?.value ?? null;
    return highest === null ? 0 : highest + 1;
  }

  /**
   * Applies a manual order: `ids` is the full list in the order it should
   * appear, and each row's `sortOrder` becomes its index.
   *
   * One statement for the whole drag, exactly like `ProgramsRepo.reorder` and
   * `UtilityRepo.reorder`: `json_each` turns the array into a `(key, value)`
   * table whose `key` IS the 0-based position being assigned. `installedAt` is
   * deliberately untouched — dragging a row is not a re-installation.
   */
  reorderVersions(ids: number[]): BibleVersionDTO[] {
    if (ids.length > 0) {
      this.sqlite
        .prepare(
          `UPDATE bible_versions
              SET sort_order = (SELECT key FROM json_each(?) WHERE value = bible_versions.id)
            WHERE id IN (SELECT value FROM json_each(?))`,
        )
        .run(JSON.stringify(ids), JSON.stringify(ids));
    }
    return this.listVersions();
  }

  getVersion(id: number): BibleVersionDTO | null {
    const row = this.db.select().from(bibleVersions).where(eq(bibleVersions.id, id)).get();
    return row ? toVersionDTO(row) : null;
  }

  /**
   * Renames a version.
   *
   * The only editable field a version has, and it earns its place: the name is
   * what the projector prints when `BibleStyle.versionDisplay` asks for it,
   * and «Reina-Valera 1909» under a verse on a three-metre screen is not what
   * anybody wants there. It is also what an import gets from a file NAME,
   * which for a downloaded module is regularly something like
   * `spaRV1909_vpl`.
   *
   * `code` is deliberately NOT editable: it is the identity the seed re-imports
   * against (`sourceHash` comparison) and the key `bible_favorites` rows point
   * at. Letting it be edited would silently orphan favorites and turn the next
   * launch's re-seed into a duplicate version.
   */
  renameVersion(id: number, name: string): BibleVersionDTO | null {
    this.db.update(bibleVersions).set({ name }).where(eq(bibleVersions.id, id)).run();
    return this.getVersion(id);
  }

  /**
   * Deletes a version, with its books and verses.
   *
   * `ON DELETE CASCADE` takes `bible_books` and `bible_verses` (and the FTS5
   * rows with them, via the sync triggers). Two things it deliberately does
   * NOT take:
   *
   * - `program_items` rows, whose FK is `set null`: a saved program keeps the
   *   verse it cited — text and reference are denormalized into the row — and
   *   loses only the version link, and with it the projected label. Deleting
   *   a version must never delete somebody's order of service.
   * - `bible_favorites` rows, which are keyed by version CODE rather than by
   *   the FK, exactly so this survives. Re-importing the same bible brings
   *   its favorites back; clearing them here would make a delete-and-reimport
   *   — the ordinary way to replace a file — quietly destructive.
   */
  deleteVersion(id: number): void {
    this.db.delete(bibleVersions).where(eq(bibleVersions.id, id)).run();
  }

  listBooks(versionId: number): BibleBookDTO[] {
    return this.db
      .select()
      .from(bibleBooks)
      .where(eq(bibleBooks.versionId, versionId))
      .orderBy(bibleBooks.position)
      .all()
      .map((b) => ({
        id: b.id,
        versionId: b.versionId,
        position: b.position,
        abbrev: b.abbrev,
        name: b.name,
        testament: b.testament,
        chapterCount: b.chapterCount,
      }));
  }

  getChapter(bookId: number, chapter: number): BibleVerseDTO[] {
    const book = this.db.select().from(bibleBooks).where(eq(bibleBooks.id, bookId)).get();
    if (!book) return [];
    return this.db
      .select()
      .from(bibleVerses)
      .where(and(eq(bibleVerses.bookId, bookId), eq(bibleVerses.chapter, chapter)))
      .orderBy(bibleVerses.verse)
      .all()
      .map((v) => ({
        id: v.id,
        bookId: v.bookId,
        bookName: book.name,
        chapter: v.chapter,
        verse: v.verse,
        text: v.text,
      }));
  }

  search(versionId: number, query: string, limit = 100): BibleSearchHit[] {
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return [];

    // The delimiters are control characters, not `<mark>` tags: a snippet
    // carries the verse's own text, a verse can come from any JSON the
    // operator imports, and the renderer used to hand this straight to
    // `dangerouslySetInnerHTML`. See `SNIPPET_MARK_START` in
    // `shared/types/bible.ts` for the full reasoning.
    const stmt = this.sqlite.prepare(`
      SELECT v.id AS id, v.book_id AS bookId, b.name AS bookName, v.chapter AS chapter,
             v.verse AS verse, v.text AS text,
             snippet(bible_verses_fts, 0, char(1), char(2), '…', 12) AS snippet
      FROM bible_verses_fts f
      JOIN bible_verses v ON v.id = f.rowid
      JOIN bible_books b ON b.id = v.book_id
      WHERE bible_verses_fts MATCH ? AND v.version_id = ?
      ORDER BY bm25(bible_verses_fts)
      LIMIT ?
    `);

    try {
      return stmt.all(ftsQuery, versionId, limit) as BibleSearchHit[];
    } catch {
      // A pathological query (bare operator, etc.) that still slipped through toFtsQuery.
      return [];
    }
  }
}
