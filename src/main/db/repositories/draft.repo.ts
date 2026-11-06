import { eq, inArray } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Db } from "../client";
import {
  bibleBooks,
  bibleVersions,
  mediaAssets,
  overlayPlates,
  programDraft,
  programs,
  songs,
  utilityScenes,
} from "../schema";
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
   * the library, a time scene, a plate or a song deleted in its editor. A
   * verse stays without its version, as a saved one does: only its dead ids
   * go (`withLiveBibleIds`).
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
    const liveAssets = aliveIds(this.db, mediaAssets.id, assetIds);
    const liveScenes = aliveIds(this.db, utilityScenes.id, sceneIds);
    const livePlates = aliveIds(this.db, overlayPlates.id, plateIds);
    const liveSongs = aliveIds(this.db, songs.id, songIds);
    const alive = items.filter((item) => {
      if (usesAsset(item)) return liveAssets.has(item.mediaAssetId);
      if (item.kind === "utility") return liveScenes.has(item.utilitySceneId);
      if (item.kind === "plate") return livePlates.has(item.overlayPlateId);
      if (item.kind === "song") return liveSongs.has(item.songId);
      return true;
    });
    return withLiveBibleIds(this.db, alive);
  }
}

/** Which of `ids` still have a row, as a set. `inArray` with an empty list
 *  compiles to a `WHERE false` that is pure overhead, so an empty ask is
 *  answered without a query. */
function aliveIds(db: Db, column: SQLiteColumn, ids: number[]): Set<number> {
  if (ids.length === 0) return new Set();
  return new Set(
    db
      .select({ id: column })
      .from(column.table)
      .where(inArray(column, ids))
      .all()
      .map((r) => r.id as number),
  );
}

/**
 * The items with every Bible version and book id that no longer has a row
 * nulled — exactly what the `set null` FK does to a saved verse when its
 * version is deleted: it keeps its text and reference and loses only the
 * label. The open schedule and its draft hold the ids they were built with,
 * and sending a dead one back failed the whole save on that FK; every
 * `ProgramsRepo.save` and every restored draft goes through here.
 */
export function withLiveBibleIds(db: Db, items: ProgramItemUpsert[]): ProgramItemUpsert[] {
  const verses = items.flatMap((item) => (item.kind === "bible" ? [item] : []));
  if (verses.length === 0) return items;
  const liveVersions = aliveIds(db, bibleVersions.id, verses.flatMap((verse) => verse.bibleVersionId ?? []));
  const liveBooks = aliveIds(db, bibleBooks.id, verses.flatMap((verse) => verse.bibleBookId ?? []));
  const alive = (id: number | null, live: Set<number>) => (id !== null && live.has(id) ? id : null);
  return items.map((item) =>
    item.kind === "bible"
      ? {
          ...item,
          bibleVersionId: alive(item.bibleVersionId, liveVersions),
          bibleBookId: alive(item.bibleBookId, liveBooks),
        }
      : item,
  );
}

function usesAsset(item: ProgramItemUpsert): item is Extract<ProgramItemUpsert, { mediaAssetId: number }> {
  return item.kind === "media" || item.kind === "ppt";
}
