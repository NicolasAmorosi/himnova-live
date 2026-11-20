import { eq, min } from "drizzle-orm";
import Database from "better-sqlite3";
import type { Db } from "../client";
import { overlayPlates } from "../schema";
import { parseJson } from "../parse-json";
import { IpcError } from "@shared/ipc/result";
import { normalizePlateStyle } from "@shared/overlay-validators";
import { PLATE_KIND_POSITIONS, type Plate } from "@shared/types/overlay";

/** A row as a `Plate`, whatever the row holds — normalized field by field, so
 *  a bad style cannot take the panel down at boot (same rule as
 *  `UtilityRepo`). A position its kind does not allow falls back to that
 *  kind's first one rather than landing somewhere the layout never draws. */
function toPlate(row: typeof overlayPlates.$inferSelect): Plate {
  const positions = PLATE_KIND_POSITIONS[row.kind];
  const position = positions.find((p) => p === row.position) ?? positions[0]!;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    position,
    title: row.title,
    subtitle: row.subtitle,
    imageAssetId: row.kind === "bug" ? row.imageAssetId : null,
    style: normalizePlateStyle(parseJson(row.styleJson)),
  };
}

function toRow(input: Omit<Plate, "id">) {
  return {
    name: input.name.trim(),
    kind: input.kind,
    position: input.position,
    title: input.title,
    subtitle: input.subtitle,
    imageAssetId: input.imageAssetId,
    styleJson: JSON.stringify(input.style),
  };
}

/** CRUD over `overlay_plates`. Knows nothing about which plate is on the air —
 *  that is the control window's (`projection.store.livePlates`). */
export class OverlaysRepo {
  constructor(
    private readonly db: Db,
    private readonly sqlite: Database.Database,
  ) {}

  list(): Plate[] {
    return this.db
      .select()
      .from(overlayPlates)
      .orderBy(overlayPlates.sortOrder, overlayPlates.id)
      .all()
      .map(toPlate);
  }

  get(id: number): Plate | null {
    const row = this.db.select().from(overlayPlates).where(eq(overlayPlates.id, id)).get();
    return row ? toPlate(row) : null;
  }

  create(input: Omit<Plate, "id">): Plate {
    const now = Date.now();
    const lowest = this.db.select({ value: min(overlayPlates.sortOrder) }).from(overlayPlates).get()?.value ?? null;
    const id = this.db
      .insert(overlayPlates)
      .values({ ...toRow(input), sortOrder: lowest === null ? 0 : lowest - 1, createdAt: now, updatedAt: now })
      .run().lastInsertRowid as number;
    const plate = this.get(id);
    if (!plate) throw new Error(`Overlay plate ${id} vanished right after being created`);
    return plate;
  }

  update(id: number, input: Omit<Plate, "id">): Plate {
    this.db
      .update(overlayPlates)
      .set({ ...toRow(input), updatedAt: Date.now() })
      .where(eq(overlayPlates.id, id))
      .run();
    const plate = this.get(id);
    if (!plate) throw new Error(`Overlay plate ${id} not found`);
    return plate;
  }

  duplicate(id: number, name: string): Plate {
    const source = this.get(id);
    if (!source) throw new Error(`Overlay plate ${id} not found`);
    const { id: _id, ...rest } = source;
    return this.create({ ...rest, name });
  }

  /** A plate a saved program still uses is refused as `OVERLAY_PLATE_IN_USE`
   *  — the question `overlay:usages` answers, same as `UtilityRepo.delete`. */
  delete(id: number): void {
    try {
      this.db.delete(overlayPlates).where(eq(overlayPlates.id, id)).run();
    } catch (error) {
      if (error instanceof Database.SqliteError && error.message.includes("FOREIGN KEY constraint failed")) {
        throw new IpcError({
          code: "OVERLAY_PLATE_IN_USE",
          message: `Overlay plate ${id} is still referenced by a program item`,
        });
      }
      throw error;
    }
  }

  /** Same single `json_each` statement as `UtilityRepo.reorder`. */
  reorder(ids: number[]): Plate[] {
    if (ids.length > 0) {
      this.sqlite
        .prepare(
          `UPDATE overlay_plates
              SET sort_order = (SELECT key FROM json_each(?) WHERE value = overlay_plates.id)
            WHERE id IN (SELECT value FROM json_each(?))`,
        )
        .run(JSON.stringify(ids), JSON.stringify(ids));
    }
    return this.list();
  }
}
