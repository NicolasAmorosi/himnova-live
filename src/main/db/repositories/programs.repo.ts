import { eq, count, desc, min } from "drizzle-orm";
import type Database from "better-sqlite3";
import type { Db } from "../client";
import { programItems, programs } from "../schema";
import { withLiveBibleIds } from "./draft.repo";
import { IpcError } from "@shared/ipc/result";
import type {
  ProgramDTO,
  ProgramDuplicateInput,
  ProgramItemDTO,
  ProgramItemUpsert,
  ProgramMetaUpsert,
  ProgramSummary,
  ProgramUpsert,
} from "@shared/types/program";
import type { BibleVersionUsage } from "@shared/types/bible";
import type { AssetLookUsage, MediaAssetUsages } from "@shared/types/media";
import type { UtilitySceneUsage } from "@shared/types/utility";
import type { PlateUsage } from "@shared/types/overlay";
import type { SongUsage } from "@shared/types/song";
import { mt } from "../../i18n";

function toItemDTO(row: typeof programItems.$inferSelect): ProgramItemDTO {
  const base = { id: row.id, position: row.position, title: row.title };
  switch (row.kind) {
    case "media":
      return { ...base, kind: "media", mediaAssetId: row.mediaAssetId! };
    case "ppt":
      return { ...base, kind: "ppt", mediaAssetId: row.mediaAssetId! };
    case "utility":
      return { ...base, kind: "utility", utilitySceneId: row.utilitySceneId! };
    case "plate":
      return { ...base, kind: "plate", overlayPlateId: row.overlayPlateId! };
    case "song":
      return { ...base, kind: "song", songId: row.songId! };
    case "bible":
    default:
      return {
        id: row.id,
        position: row.position,
        kind: "bible",
        bibleVersionId: row.bibleVersionId,
        bibleBookId: row.bibleBookId,
        chapter: row.bibleChapter,
        verseFrom: row.bibleVerseFrom,
        verseTo: row.bibleVerseTo,
        reference: row.bibleReference ?? "",
        text: row.bibleText ?? "",
      };
  }
}

function toSummary(row: typeof programs.$inferSelect, itemCount: number): ProgramSummary {
  return {
    id: row.id,
    name: row.name,
    notes: row.notes,
    favorite: row.favorite,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastOpenedAt: row.lastOpenedAt,
    sortOrder: row.sortOrder,
    itemCount,
  };
}

export class ProgramsRepo {
  constructor(
    private readonly db: Db,
    private readonly sqlite: Database.Database,
  ) {}

  /** In the operator's own manual order (`ix_programs_order`), never by
   *  recency: opening a program must not move it in the list. `updatedAt`
   *  only breaks ties between rows that share a `sortOrder`, which can only
   *  happen before the first `reorder()` renormalizes them. */
  list(): ProgramSummary[] {
    // One statement, not one per row. This used to run a `SELECT count(*)`
    // inside the map — 41 queries for 40 programs — and it is not a rarely
    // taken path: the modal calls it on open, after every save, delete and
    // favourite toggle, and `reorder()` calls it after every single drag.
    // `count(programItems.id)` (a column, not `*`) is what keeps a program
    // with no items at 0 instead of the 1 that the LEFT JOIN's null row
    // would otherwise count.
    const rows = this.db
      .select({ program: programs, itemCount: count(programItems.id) })
      .from(programs)
      .leftJoin(programItems, eq(programItems.programId, programs.id))
      .groupBy(programs.id)
      .orderBy(programs.sortOrder, desc(programs.updatedAt))
      .all();
    return rows.map((row) => toSummary(row.program, row.itemCount));
  }

  /** Opening a program for real: stamps `lastOpenedAt`. */
  load(id: number): ProgramDTO {
    const now = Date.now();
    this.db.update(programs).set({ lastOpenedAt: now }).where(eq(programs.id, id)).run();
    return { ...this.peek(id), lastOpenedAt: now };
  }

  /** Reading a program without opening it — the programs modal's preview panel.
   *  Writes nothing at all, which is the whole point: `lastOpenedAt` is what
   *  the list means by "last opened", and a glance is not an opening. */
  peek(id: number): ProgramDTO {
    const p = this.db.select().from(programs).where(eq(programs.id, id)).get();
    if (!p) throw new Error(`Program ${id} not found`);
    const items = this.db
      .select()
      .from(programItems)
      .where(eq(programItems.programId, id))
      .orderBy(programItems.position)
      .all()
      .map(toItemDTO);
    return { ...toSummary(p, items.length), items };
  }

  /** Replaces a program's items wholesale inside one transaction — reordering,
   *  adding and removing items is all "save the whole playlist again", matching
   *  how the control window's playlist editor actually works. `favorite` is
   *  only written when the caller actually knows it — `saveCurrentProgram()`
   *  in the renderer never does, and must not clobber it back to `false`. */
  save(input: ProgramUpsert): ProgramSummary {
    const now = Date.now();
    const run = this.sqlite.transaction(() => {
      let programId = input.id;
      if (programId && !this.db.select({ id: programs.id }).from(programs).where(eq(programs.id, programId)).get()) {
        throw new IpcError({ code: "PROGRAM_NOT_FOUND", message: mt("programs.notFound") });
      }
      if (programId) {
        this.db
          .update(programs)
          .set({
            name: input.name,
            notes: input.notes ?? null,
            ...(input.favorite !== undefined ? { favorite: input.favorite } : {}),
            updatedAt: now,
          })
          .where(eq(programs.id, programId))
          .run();
        this.db.delete(programItems).where(eq(programItems.programId, programId)).run();
      } else {
        programId = this.db
          .insert(programs)
          .values({
            name: input.name,
            notes: input.notes ?? null,
            favorite: input.favorite ?? false,
            sortOrder: this.topSortOrder(),
            createdAt: now,
            updatedAt: now,
          })
          .run().lastInsertRowid as number;
      }

      withLiveBibleIds(this.db, input.items).forEach((item: ProgramItemUpsert, index: number) => {
        this.db.insert(programItems).values(toRow(programId, index, item, now)).run();
      });

      return programId;
    });

    const id = run();
    const p = this.db.select().from(programs).where(eq(programs.id, id)).get()!;
    return toSummary(p, input.items.length);
  }

  /** Renames/edits a program's metadata only — unlike `save()`, never touches
   *  its items or rewrites their ids. Same partial-write rule for `favorite`
   *  as `save()`. */
  updateMeta(input: ProgramMetaUpsert): ProgramSummary {
    const now = Date.now();
    this.db
      .update(programs)
      .set({
        name: input.name,
        notes: input.notes ?? null,
        ...(input.favorite !== undefined ? { favorite: input.favorite } : {}),
        updatedAt: now,
      })
      .where(eq(programs.id, input.id))
      .run();
    const p = this.db.select().from(programs).where(eq(programs.id, input.id)).get()!;
    const itemCount =
      this.db.select({ n: count() }).from(programItems).where(eq(programItems.programId, input.id)).get()
        ?.n ?? 0;
    return toSummary(p, itemCount);
  }

  /** Flips just the favorite flag — a plain `UPDATE` that deliberately never
   *  touches `updatedAt`: starring a program isn't a content edit, and
   *  bumping it would reorder the list (`ix_programs_recent`/`updatedAt`
   *  sort), which the star is never supposed to do. */
  setFavorite(id: number, favorite: boolean): ProgramSummary {
    this.db.update(programs).set({ favorite }).where(eq(programs.id, id)).run();
    const p = this.db.select().from(programs).where(eq(programs.id, id)).get();
    if (!p) throw new Error(`Program ${id} not found`);
    const itemCount =
      this.db.select({ n: count() }).from(programItems).where(eq(programItems.programId, id)).get()?.n ?? 0;
    return toSummary(p, itemCount);
  }

  /** Copies a program's header + items in one transaction. Never touches the
   *  source program, and item ids are freshly assigned like any other save.
   *  `notes`/`favorite` fall back to the source's own values when the caller
   *  omits them — unlike `save`/`updateMeta`, which `??` an omitted `notes` to
   *  `null` (there the field is always present in the form; here duplicating
   *  without touching a field means "keep it as it was"). */
  duplicate(input: ProgramDuplicateInput): ProgramSummary {
    const now = Date.now();
    const run = this.sqlite.transaction(() => {
      const source = this.db.select().from(programs).where(eq(programs.id, input.id)).get();
      if (!source) throw new Error(`Program ${input.id} not found`);
      const sourceItems = this.db
        .select()
        .from(programItems)
        .where(eq(programItems.programId, input.id))
        .orderBy(programItems.position)
        .all();

      const newId = this.db
        .insert(programs)
        .values({
          name: input.name,
          notes: input.notes !== undefined ? input.notes : source.notes,
          favorite: input.favorite ?? source.favorite,
          sortOrder: this.topSortOrder(),
          createdAt: now,
          updatedAt: now,
        })
        .run().lastInsertRowid as number;

      sourceItems.forEach((item) => {
        const { id: _id, programId: _programId, createdAt: _createdAt, ...rest } = item;
        this.db.insert(programItems).values({ ...rest, programId: newId, createdAt: now }).run();
      });

      return { newId, itemCount: sourceItems.length };
    });

    const { newId, itemCount } = run();
    const p = this.db.select().from(programs).where(eq(programs.id, newId)).get()!;
    return toSummary(p, itemCount);
  }

  /** Sort key that puts a brand new (or duplicated) program at the top of the
   *  list without rewriting every other row — one slot below the current
   *  minimum, which is allowed to go negative. `reorder()` normalizes the
   *  whole column back to `0..n-1` the first time the operator drags. */
  private topSortOrder(): number {
    const lowest = this.db.select({ value: min(programs.sortOrder) }).from(programs).get()?.value ?? null;
    return lowest === null ? 0 : lowest - 1;
  }

  /** Applies a manual order: `ids` is the full list of program ids in the
   *  order they should appear, and each row's `sortOrder` becomes its index.
   *  Deliberately never touches `updatedAt` — dragging a row isn't a content
   *  edit. Ids that no longer exist are simply no-ops, and a program missing
   *  from `ids` keeps whatever key it had — it stays in the list, just where
   *  that key happens to fall. */
  reorder(ids: number[]): ProgramSummary[] {
    if (ids.length > 0) {
      // One statement for the whole drag, instead of an UPDATE per id inside a
      // transaction. `json_each` turns the array into a (key, value) table
      // whose `key` IS the 0-based position, which is exactly the sort order
      // being assigned — so the mapping never has to be spelled out as SQL
      // text, and a 40-program list costs one prepare instead of forty.
      // A single statement is atomic on its own; the transaction it needed
      // went away with the loop.
      this.sqlite
        .prepare(
          `UPDATE programs
              SET sort_order = (SELECT key FROM json_each(?) WHERE value = programs.id)
            WHERE id IN (SELECT value FROM json_each(?))`,
        )
        .run(JSON.stringify(ids), JSON.stringify(ids));
    }
    return this.list();
  }

  delete(id: number): void {
    this.db.delete(programs).where(eq(programs.id, id)).run();
  }

  /** What still uses `assetId`, for the warning before it leaves the library:
   *  the saved programs that list it — the FK violation itself doesn't say
   *  which — and the looks drawn over it (owner, 2026-11-06). */
  findUsages(assetId: number): MediaAssetUsages {
    const programRows = this.db
      .select({
        programId: programs.id,
        programName: programs.name,
        itemCount: count(),
      })
      .from(programItems)
      .innerJoin(programs, eq(programItems.programId, programs.id))
      .where(eq(programItems.mediaAssetId, assetId))
      .groupBy(programs.id)
      .all();
    return { programs: programRows, looks: this.findLookUsages(assetId) };
  }

  /**
   * The looks drawn over `assetId`: the LOGO's and the verse's backgrounds
   * (settings), a song theme's (an image or a video), a time scene's, a bug
   * plate's picture. A style is a JSON column that no FK reaches, so removing
   * the file is never refused for it — the look would simply lose its picture
   * on the projector; this is what lets the removal say so first. Only an
   * image or video background carries `assetId`, so the path alone tells. A
   * value that is not JSON costs that row, never the answer (`CASE` is the one
   * guard SQLite promises to evaluate first).
   */
  private findLookUsages(assetId: number): AssetLookUsage[] {
    const drawsIt = (column: string, path: string) =>
      `CASE WHEN json_valid(${column}) THEN json_extract(${column}, '${path}') END = :id`;
    return this.sqlite
      .prepare(
        `SELECT 'logo' AS kind, NULL AS name FROM settings
          WHERE key = 'logo.background' AND ${drawsIt("value", "$.assetId")}
         UNION ALL
         SELECT 'verse', NULL FROM settings WHERE key = 'bible.style' AND ${drawsIt("value", "$.background.assetId")}
         UNION ALL
         SELECT 'songTheme', name FROM song_themes WHERE ${drawsIt("style_json", "$.background.assetId")}
         UNION ALL
         SELECT 'scene', name FROM utility_scenes WHERE ${drawsIt("style_json", "$.background.assetId")}
         UNION ALL
         SELECT 'plate', name FROM overlay_plates WHERE image_asset_id = :id`,
      )
      .all({ id: assetId }) as AssetLookUsage[];
  }

  /** Which saved programs still reference the time scene `sceneId` — the same
   *  question `findUsages` answers about a media asset, and asked for the same
   *  reason: `utility_scene_id`'s `ON DELETE restrict` refuses the delete
   *  without naming anything the operator could act on. */
  findSceneUsages(sceneId: number): UtilitySceneUsage[] {
    return this.db
      .select({
        programId: programs.id,
        programName: programs.name,
        itemCount: count(),
      })
      .from(programItems)
      .innerJoin(programs, eq(programItems.programId, programs.id))
      .where(eq(programItems.utilitySceneId, sceneId))
      .groupBy(programs.id)
      .all();
  }

  /** Which saved programs still reference the plate `plateId` — `findSceneUsages`
   *  for `overlay_plate_id`. */
  findPlateUsages(plateId: number): PlateUsage[] {
    return this.db
      .select({
        programId: programs.id,
        programName: programs.name,
        itemCount: count(),
      })
      .from(programItems)
      .innerJoin(programs, eq(programItems.programId, programs.id))
      .where(eq(programItems.overlayPlateId, plateId))
      .groupBy(programs.id)
      .all();
  }

  /** Which saved programs still reference the song `songId`. */
  findSongUsages(songId: number): SongUsage[] {
    return this.db
      .select({
        programId: programs.id,
        programName: programs.name,
        itemCount: count(),
      })
      .from(programItems)
      .innerJoin(programs, eq(programItems.programId, programs.id))
      .where(eq(programItems.songId, songId))
      .groupBy(programs.id)
      .all();
  }

  /**
   * Which saved programs cite `versionId`, and how many items each one has.
   *
   * The same query shape as `findSceneUsages`, answering a milder question:
   * this FK is `set null`, so the delete it precedes cannot fail and cannot
   * remove a row. It exists so the confirmation can NAME what changes —
   * "these schedules lose the version" — instead of the operator finding out
   * next Sunday that a verse stopped printing «RV1909» underneath itself.
   */
  findBibleVersionUsages(versionId: number): BibleVersionUsage[] {
    return this.db
      .select({
        programId: programs.id,
        programName: programs.name,
        itemCount: count(),
      })
      .from(programItems)
      .innerJoin(programs, eq(programItems.programId, programs.id))
      .where(eq(programItems.bibleVersionId, versionId))
      .groupBy(programs.id)
      .all();
  }

  /** Frees the `restrict` FK on `program_items.utility_scene_id`, exactly like
   *  `deleteItemsByMediaAsset` does for an asset: the CHECK constraint forbids
   *  a `utility` item with a null scene, so the rows go rather than being
   *  blanked. Leaves gaps in `position`, which `load()`'s ORDER BY and the
   *  next `save()`'s reindex both tolerate. */
  deleteItemsByUtilityScene(sceneId: number): void {
    this.db.delete(programItems).where(eq(programItems.utilitySceneId, sceneId)).run();
  }

  /** `deleteItemsByUtilityScene` for `overlay_plate_id`. */
  deleteItemsByPlate(plateId: number): void {
    this.db.delete(programItems).where(eq(programItems.overlayPlateId, plateId)).run();
  }

  /** `deleteItemsByUtilityScene` for `song_id`. */
  deleteItemsBySong(songId: number): void {
    this.db.delete(programItems).where(eq(programItems.songId, songId)).run();
  }

  /** Removes every item pointing at `assetId` across all programs — the only
   *  way to free the `onDelete: "restrict"` FK on `program_items.media_asset_id`,
   *  since the table's CHECK constraint forbids a `media`/`ppt` item with a
   *  null asset. Leaves gaps in `position`, which `load()`'s ORDER BY and the
   *  next `save()`'s reindex both tolerate. */
  deleteItemsByMediaAsset(assetId: number): void {
    this.db.delete(programItems).where(eq(programItems.mediaAssetId, assetId)).run();
  }
}

function toRow(programId: number, position: number, item: ProgramItemUpsert, now: number) {
  const common = { programId, position, createdAt: now, title: null as string | null };
  switch (item.kind) {
    case "media":
    case "ppt":
      return { ...common, kind: item.kind, mediaAssetId: item.mediaAssetId, title: item.title };
    case "utility":
      return { ...common, kind: "utility" as const, utilitySceneId: item.utilitySceneId, title: item.title };
    case "plate":
      return { ...common, kind: "plate" as const, overlayPlateId: item.overlayPlateId, title: item.title };
    case "song":
      return { ...common, kind: "song" as const, songId: item.songId, title: item.title };
    case "bible":
    default:
      return {
        ...common,
        kind: "bible" as const,
        bibleVersionId: item.bibleVersionId,
        bibleBookId: item.bibleBookId,
        bibleChapter: item.chapter,
        bibleVerseFrom: item.verseFrom,
        bibleVerseTo: item.verseTo,
        bibleReference: item.reference,
        bibleText: item.text,
      };
  }
}
