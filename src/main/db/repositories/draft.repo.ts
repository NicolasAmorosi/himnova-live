import { eq, inArray } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Db } from "../client";
import { mediaAssets, overlayPlates, programDraft, programs, songs, utilityScenes } from "../schema";
import type { ProgramDraft, ProgramItemUpsert } from "@shared/types/program";
import { PROGRAM_ITEM_KINDS } from "@shared/constants";

const KNOWN_KINDS = new Set<string>(PROGRAM_ITEM_KINDS);

function isKnownKind(item: unknown): item is ProgramItemUpsert {
  return (
    typeof item === "object" &&
    item !== null &&
    KNOWN_KINDS.has((item as { kind?: unknown }).kind as string)
  );
}

/** One row, always. The table exists to answer exactly one question at launch:
 *  "was the operator in the middle of something?". */
const ROW_ID = 1;

/**
 * The unsaved order of service, mirrored out of the control window so a
 * reload, a window close, a renderer crash or a power cut cannot throw it
 * away. See `schema.ts`'s note on `program_draft` for why the items are a JSON
 * blob and not rows in `program_items`.
 */
export class DraftRepo {
  constructor(private readonly db: Db) {}

  save(draft: ProgramDraft): void {
    const values = {
      id: ROW_ID,
      programId: draft.programId,
      name: draft.name,
      notes: draft.notes,
      items: JSON.stringify(draft.items),
      updatedAt: draft.updatedAt,
    };
    this.db
      .insert(programDraft)
      .values(values)
      .onConflictDoUpdate({ target: programDraft.id, set: values })
      .run();
  }

  clear(): void {
    this.db.delete(programDraft).where(eq(programDraft.id, ROW_ID)).run();
  }

  /**
   * The draft as it can still be honoured today, or `null` when there is none.
   *
   * Items whose target no longer exists — a media asset, a time scene — are
   * dropped here rather than in the renderer: main is the only side that can
   * answer "does this row still exist" without one IPC round trip per item.
   * See `withLiveAssetsOnly` for why a draft is the only place a dead
   * reference can outlive the thing it points at.
   *
   * A draft whose items ALL disappeared still comes back (with an empty list)
   * when it names a saved program, because its name and `programId` are
   * themselves state worth restoring; a nameless, itemless draft is nothing
   * and returns `null`.
   */
  load(): ProgramDraft | null {
    const row = this.db.select().from(programDraft).where(eq(programDraft.id, ROW_ID)).get();
    if (!row) return null;

    let parsed: ProgramItemUpsert[];
    try {
      const value: unknown = JSON.parse(row.items);
      // A hand-edited or truncated blob must not take the launch down with it:
      // the draft is a convenience, never a dependency.
      // Kinds are filtered, not trusted: this blob outlives the schema that
      // wrote it. `text` items were a real kind until 0009 dropped it, and a
      // draft written before the upgrade would otherwise come back as a row
      // no renderer knows how to label and no `save()` can persist — the
      // CHECK constraint rejects it. Dropping it here is the same rule the
      // dead-asset filter below already follows.
      parsed = Array.isArray(value) ? value.filter(isKnownKind) : [];
    } catch {
      parsed = [];
    }

    const items = parsed.length > 0 ? this.withLiveAssetsOnly(parsed) : parsed;
    if (items.length === 0 && row.programId === null && row.name === "") return null;

    // A draft of a program deleted since is a draft of a NEW program: keeping
    // the dead id made «Save» fail on it forever (an FK error, or a
    // TypeError on the summary), leaving only «Save as».
    const programExists =
      row.programId !== null &&
      this.db.select({ id: programs.id }).from(programs).where(eq(programs.id, row.programId)).get() !== undefined;

    return {
      programId: programExists ? row.programId : null,
      name: row.name,
      notes: row.notes,
      items,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Drops the items whose target no longer exists — a media asset removed from
   * the library, a time scene, a plate or a song deleted in its editor.
   *
   * Both kinds of reference are checked, and neither is optional: a saved
   * program is protected by an `ON DELETE restrict` FK, but a draft is a JSON
   * blob that no constraint can reach, so it is the one place a dead reference
   * can survive a delete. What it survives AS is the problem — a tile that can
   * never preview, never go live and never explain itself.
   */
  private withLiveAssetsOnly(items: ProgramItemUpsert[]): ProgramItemUpsert[] {
    const assetIds = [...new Set(items.flatMap((item) => (usesAsset(item) ? [item.mediaAssetId] : [])))];
    const sceneIds = [
      ...new Set(items.flatMap((item) => (item.kind === "utility" ? [item.utilitySceneId] : []))),
    ];
    const plateIds = [...new Set(items.flatMap((item) => (item.kind === "plate" ? [item.overlayPlateId] : [])))];
    const songIds = [...new Set(items.flatMap((item) => (item.kind === "song" ? [item.songId] : [])))];
    if (assetIds.length === 0 && sceneIds.length === 0 && plateIds.length === 0 && songIds.length === 0) return items;

    const liveAssets = this.aliveIds(mediaAssets.id, assetIds);
    const liveScenes = this.aliveIds(utilityScenes.id, sceneIds);
    const livePlates = this.aliveIds(overlayPlates.id, plateIds);
    const liveSongs = this.aliveIds(songs.id, songIds);
    return items.filter((item) => {
      if (usesAsset(item)) return liveAssets.has(item.mediaAssetId);
      if (item.kind === "utility") return liveScenes.has(item.utilitySceneId);
      if (item.kind === "plate") return livePlates.has(item.overlayPlateId);
      if (item.kind === "song") return liveSongs.has(item.songId);
      return true;
    });
  }

  /** Which of `ids` still have a row, as a set. `inArray` with an empty list
   *  compiles to a `WHERE false` that is pure overhead, so an empty ask is
   *  answered without a query. */
  private aliveIds(column: SQLiteColumn, ids: number[]): Set<number> {
    if (ids.length === 0) return new Set();
    return new Set(
      this.db
        .select({ id: column })
        .from(column.table)
        .where(inArray(column, ids))
        .all()
        .map((r) => r.id as number),
    );
  }
}

function usesAsset(item: ProgramItemUpsert): item is Extract<ProgramItemUpsert, { mediaAssetId: number }> {
  return item.kind === "media" || item.kind === "ppt";
}
