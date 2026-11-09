import { and, desc, eq, gte, lte, max, sql } from "drizzle-orm";
import type Database from "better-sqlite3";
import type { Db } from "../client";
import { toFtsQuery } from "../fts-query";
import { bibleBooks, bibleFavorites, bibleRecents, bibleVersions, bibleVerses } from "../schema";
import { canonByAbbrev } from "../seed/bible-formats/canon";
import { CANON_ABBREVS, canonIndex } from "@shared/bible-canon";
import {
  BIBLE_RECENTS_MAX,
  passageReference,
  passageText,
  type BibleBookDTO,
  type BibleBookmark,
  type BibleSearchHit,
  type BibleVerseDTO,
  type BibleVersionDTO,
} from "@shared/types/bible";

function toBookmark(row: typeof bibleFavorites.$inferSelect | typeof bibleRecents.$inferSelect): BibleBookmark {
  return {
    id: row.id,
    bookAbbrev: row.bookAbbrev,
    chapter: row.chapter,
    verseFrom: row.verseFrom,
    verseTo: row.verseTo,
    reference: row.reference,
  };
}

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

  /** The version made from a file with these bytes (`bibleFileHash`), if any. */
  findVersionBySourceHash(sourceHash: string): BibleVersionDTO | null {
    const row = this.db.select().from(bibleVersions).where(eq(bibleVersions.sourceHash, sourceHash)).get();
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

  /** An imported file that does not say its language is stored as `"es"`: the operator corrects it here.
   *  `language` is already validated (`isBibleLanguage`). */
  setLanguage(id: number, language: string): BibleVersionDTO | null {
    this.db.update(bibleVersions).set({ language }).where(eq(bibleVersions.id, id)).run();
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

  /**
   * A passage in `versionId`, its book found by the app's own abbrev — what a
   * book is in every version (`canonIndex`), with the version's own spelling
   * as the fallback a partial canon may need. The reference is in that
   * version's book name; `null` when it has none of the verses.
   */
  getPassage(
    versionId: number,
    bookAbbrev: string,
    chapter: number,
    verseFrom: number,
    verseTo: number,
  ): { text: string; reference: string } | null {
    const books = this.listBooks(versionId);
    const index = CANON_ABBREVS.indexOf(bookAbbrev.toLowerCase());
    const book = books.find((b) => (index >= 0 ? canonIndex(b, books.length) === index : b.abbrev === bookAbbrev));
    if (!book) return null;
    const verses = this.getChapter(book.id, chapter).filter((v) => v.verse >= verseFrom && v.verse <= verseTo);
    if (verses.length === 0) return null;
    return { text: passageText(verses), reference: passageReference(book.name, chapter, verseFrom, verseTo) };
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

  /** What a bookmark is keyed by: the book's abbrev and its version's code,
   *  never the row ids a re-import renumbers. */
  private bookKey(bookId: number) {
    return this.db
      .select({ abbrev: bibleBooks.abbrev, name: bibleBooks.name, versionCode: bibleVersions.code })
      .from(bibleBooks)
      .innerJoin(bibleVersions, eq(bibleVersions.id, bibleBooks.versionId))
      .where(eq(bibleBooks.id, bookId))
      .get();
  }

  /** In Bible order, Genesis first — a list to scan from the booth, not a log. */
  listFavorites(): BibleBookmark[] {
    const position = (abbrev: string) => canonByAbbrev(abbrev)?.index ?? Number.MAX_SAFE_INTEGER;
    return this.db
      .select()
      .from(bibleFavorites)
      .all()
      .map(toBookmark)
      .sort(
        (a, b) =>
          position(a.bookAbbrev) - position(b.bookAbbrev) || a.chapter - b.chapter || a.verseFrom - b.verseFrom,
      );
  }

  /** Stars or unstars one verse. Unstarring removes every favorite that
   *  contains it, so a range saved by an older build can be cleared too. */
  setFavorite(bookId: number, chapter: number, verse: number, favorite: boolean): BibleBookmark[] {
    const key = this.bookKey(bookId);
    if (!key) return this.listFavorites();
    this.sqlite.transaction(() => {
      this.db
        .delete(bibleFavorites)
        .where(
          and(
            eq(bibleFavorites.bookAbbrev, key.abbrev),
            eq(bibleFavorites.chapter, chapter),
            lte(bibleFavorites.verseFrom, verse),
            gte(bibleFavorites.verseTo, verse),
          ),
        )
        .run();
      if (!favorite) return;
      this.db
        .insert(bibleFavorites)
        .values({
          versionCode: key.versionCode,
          bookAbbrev: key.abbrev,
          chapter,
          verseFrom: verse,
          verseTo: verse,
          reference: passageReference(key.name, chapter, verse, verse),
          label: null,
          createdAt: Date.now(),
        })
        .run();
    })();
    return this.listFavorites();
  }

  listRecents(): BibleBookmark[] {
    return this.db
      .select()
      .from(bibleRecents)
      .orderBy(desc(bibleRecents.projectedAt), desc(bibleRecents.id))
      .limit(BIBLE_RECENTS_MAX)
      .all()
      .map(toBookmark);
  }

  /**
   * A passage went live. One row per chapter: reading on through the chapter
   * that is already at the top widens its range; any other chapter moves to
   * the top on its own, replacing an older row of that same chapter.
   */
  recordRecent(bookId: number, chapter: number, verseFrom: number, verseTo: number): BibleBookmark[] {
    const key = this.bookKey(bookId);
    if (!key) return this.listRecents();
    const now = Date.now();
    this.sqlite.transaction(() => {
      const newest = this.db
        .select()
        .from(bibleRecents)
        .orderBy(desc(bibleRecents.projectedAt), desc(bibleRecents.id))
        .limit(1)
        .get();
      if (newest && newest.bookAbbrev === key.abbrev && newest.chapter === chapter) {
        const from = Math.min(newest.verseFrom, verseFrom);
        const to = Math.max(newest.verseTo, verseTo);
        this.db
          .update(bibleRecents)
          .set({
            verseFrom: from,
            verseTo: to,
            reference: passageReference(key.name, chapter, from, to),
            projectedAt: now,
          })
          .where(eq(bibleRecents.id, newest.id))
          .run();
        return;
      }
      this.db
        .delete(bibleRecents)
        .where(and(eq(bibleRecents.bookAbbrev, key.abbrev), eq(bibleRecents.chapter, chapter)))
        .run();
      this.db
        .insert(bibleRecents)
        .values({
          versionCode: key.versionCode,
          bookAbbrev: key.abbrev,
          chapter,
          verseFrom,
          verseTo,
          reference: passageReference(key.name, chapter, verseFrom, verseTo),
          projectedAt: now,
        })
        .run();
      this.db
        .delete(bibleRecents)
        .where(
          sql`${bibleRecents.id} NOT IN (
            SELECT ${bibleRecents.id} FROM ${bibleRecents}
            ORDER BY ${bibleRecents.projectedAt} DESC, ${bibleRecents.id} DESC LIMIT ${BIBLE_RECENTS_MAX}
          )`,
        )
        .run();
    })();
    return this.listRecents();
  }
}
