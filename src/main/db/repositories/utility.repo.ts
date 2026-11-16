import { eq, min } from "drizzle-orm";
import Database from "better-sqlite3";
import { IpcError } from "@shared/ipc/result";
import type { Db } from "../client";
import { utilityScenes } from "../schema";
import { normalizeSceneStyle, normalizeTimerConfig } from "@shared/scene-validators";
import type { UtilityScene } from "@shared/types/utility";

/**
 * A row as a `UtilityScene`, whatever the row actually holds.
 *
 * Every JSON field is parsed defensively and normalized field by field
 * (`shared/scene-validators.ts`): a `config_json` that a future version wrote,
 * that somebody hand-edited, or that a truncated write left half-finished must
 * not be able to throw during `list()` — which runs at launch, from the
 * control window's boot. The same discipline `DraftRepo.load` and the Bible
 * seed already follow, and for the same reason: a scene that comes back
 * slightly wrong is a bad service, a scene that takes the panel down is a worse
 * one.
 */
function toScene(row: typeof utilityScenes.$inferSelect): UtilityScene {
  return {
    id: row.id,
    name: row.name,
    tool: row.tool,
    config: normalizeTimerConfig(parseJson(row.configJson)),
    style: normalizeSceneStyle(parseJson(row.styleJson)),
    title: row.title,
    message: row.message,
  };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // `null` is not a shape any normalizer accepts, so this lands on the
    // defaults exactly like a structurally wrong object would.
    return null;
  }
}

/** The stored half of a scene, shared by insert and update. `tool` is a column
 *  of its own (the list's discriminant), the rest is JSON. */
function toRow(input: Omit<UtilityScene, "id">) {
  return {
    name: input.name.trim(),
    tool: input.tool,
    configJson: JSON.stringify(input.config),
    styleJson: JSON.stringify(input.style),
    title: input.title,
    message: input.message,
  };
}

export class UtilityRepo {
  constructor(
    private readonly db: Db,
    private readonly sqlite: Database.Database,
  ) {}

  /** In the operator's own manual order (`ix_utility_scenes_order`), with `id`
   *  only breaking ties between rows that still share a `sortOrder` — which can
   *  only happen before the first `reorder()` renormalizes them. */
  list(): UtilityScene[] {
    return this.db
      .select()
      .from(utilityScenes)
      .orderBy(utilityScenes.sortOrder, utilityScenes.id)
      .all()
      .map(toScene);
  }

  get(id: number): UtilityScene | null {
    const row = this.db.select().from(utilityScenes).where(eq(utilityScenes.id, id)).get();
    return row ? toScene(row) : null;
  }

  create(input: Omit<UtilityScene, "id">): UtilityScene {
    const now = Date.now();
    const id = this.db
      .insert(utilityScenes)
      .values({ ...toRow(input), sortOrder: this.topSortOrder(), createdAt: now, updatedAt: now })
      .run().lastInsertRowid as number;
    const scene = this.get(id);
    if (!scene) throw new Error(`Utility scene ${id} vanished right after being created`);
    return scene;
  }

  /** Replaces every editable field of one scene. Never touches `sortOrder`:
   *  editing a scene is not reordering the list, and the operator's arrangement
   *  must survive a rename. */
  update(id: number, input: Omit<UtilityScene, "id">): UtilityScene {
    this.db
      .update(utilityScenes)
      .set({ ...toRow(input), updatedAt: Date.now() })
      .where(eq(utilityScenes.id, id))
      .run();
    const scene = this.get(id);
    if (!scene) throw new Error(`Utility scene ${id} not found`);
    return scene;
  }

  /** Copies a scene under a new name, landing on top of the list like any
   *  other new row. Everything else is carried over verbatim — the stored JSON
   *  is re-serialized from the parsed scene, so a duplicate of a row written by
   *  an older build is normalized on the way out. */
  duplicate(id: number, name: string): UtilityScene {
    const source = this.get(id);
    if (!source) throw new Error(`Utility scene ${id} not found`);
    const { id: _id, ...rest } = source;
    return this.create({ ...rest, name });
  }

  /** The `ON DELETE restrict` on `program_items.utility_scene_id` surfaces as
   *  an error code rather than a raw SQLite failure, exactly like
   *  `MediaRepo.remove`: the renderer's confirmation needs to tell the two
   *  cases apart, and a saved program that still uses this scene is not an
   *  error the operator can do nothing about — it is a question
   *  (`utility:usages`) waiting to be asked. */
  delete(id: number): void {
    try {
      this.db.delete(utilityScenes).where(eq(utilityScenes.id, id)).run();
    } catch (error) {
      if (error instanceof Database.SqliteError && error.message.includes("FOREIGN KEY constraint failed")) {
        throw new IpcError({
          code: "UTILITY_SCENE_IN_USE",
          message: `Utility scene ${id} is still referenced by a program item`,
        });
      }
      throw error;
    }
  }

  /** Sort key that puts a brand new scene on top without rewriting every other
   *  row — one slot below the current minimum, which is allowed to go negative.
   *  Same scheme as `ProgramsRepo.topSortOrder`. */
  private topSortOrder(): number {
    const lowest =
      this.db.select({ value: min(utilityScenes.sortOrder) }).from(utilityScenes).get()?.value ?? null;
    return lowest === null ? 0 : lowest - 1;
  }

  /**
   * Applies a manual order: `ids` is the full list in the order it should
   * appear, and each row's `sortOrder` becomes its index.
   *
   * One statement for the whole drag, exactly like `ProgramsRepo.reorder`:
   * `json_each` turns the array into a `(key, value)` table whose `key` IS the
   * 0-based position being assigned. `updatedAt` is deliberately untouched —
   * dragging a row is not a content edit.
   */
  reorder(ids: number[]): UtilityScene[] {
    if (ids.length > 0) {
      this.sqlite
        .prepare(
          `UPDATE utility_scenes
              SET sort_order = (SELECT key FROM json_each(?) WHERE value = utility_scenes.id)
            WHERE id IN (SELECT value FROM json_each(?))`,
        )
        .run(JSON.stringify(ids), JSON.stringify(ids));
    }
    return this.list();
  }

  /** Whether the table holds anything at all. Only the seed asks, and only to
   *  avoid writing over a database that already has scenes — the decision of
   *  WHETHER to seed is the `utility.seeded` flag's, never a row count. */
  isEmpty(): boolean {
    return this.db.select({ id: utilityScenes.id }).from(utilityScenes).limit(1).get() === undefined;
  }

  /** The seed's insert path: several scenes in one transaction, in the order
   *  given, `sortOrder` counting up from 0 so no `reorder()` is needed to make
   *  the list look the way the constant reads. */
  insertMany(scenes: readonly Omit<UtilityScene, "id">[]): void {
    const now = Date.now();
    this.sqlite.transaction(() => {
      scenes.forEach((scene, index) => {
        this.db
          .insert(utilityScenes)
          .values({ ...toRow(scene), sortOrder: index, createdAt: now, updatedAt: now })
          .run();
      });
    })();
  }
}
