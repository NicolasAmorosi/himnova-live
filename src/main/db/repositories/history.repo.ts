import { desc, sql } from "drizzle-orm";
import type { Db } from "../client";
import { projectionHistory } from "../schema";
import type { ProjectionOutput } from "@shared/types/projection";

const MAX_ROWS = 5000;

export class HistoryRepo {
  constructor(private readonly db: Db) {}

  /** Last deck recorded, so a 60-slide auto-advancing deck writes one row
   *  instead of 60 and doesn't burn through MAX_ROWS in a few programs. */
  private lastDeckAssetId: number | null = null;
  /** The same for a song: one row per song, not one per slide. */
  private lastSongId: number | null = null;
  /** The last recorded output, minus its plates — see `record`. */
  private lastRecordedKey: string | null = null;

  record(output: ProjectionOutput, programId: number | null): void {
    // Not worth remembering. A timer is excluded for a second reason beyond
    // "it is not content of the service": every pause, resume and reset is
    // another `projection:show`, so a countdown left on screen before a
    // service would write a row per touch, each carrying a whole serialized
    // scene, straight into the 5000-row budget.
    if (output.kind === "black" || output.kind === "timer") return;

    // An overlay plate going up or down re-pushes the very same content: that
    // is not something new being projected, and it must not cost a row. Nor is
    // uncovering BLACK: the push that follows differs only in its transition
    // epoch and in the video being resumed. What IS content — the url, a
    // video's own epoch, a verse — still records as before.
    const key = JSON.stringify({ ...output, plates: undefined, transition: undefined, videoUnderlay: undefined });
    if (key === this.lastRecordedKey) return;
    this.lastRecordedKey = key;

    if (output.kind === "song") {
      this.lastDeckAssetId = null;
      if (this.lastSongId === output.songId) return;
      this.lastSongId = output.songId;
      this.db
        .insert(projectionHistory)
        .values({
          projectedAt: Date.now(),
          kind: "song",
          mediaAssetId: null,
          programId,
          reference: output.title,
          snapshotJson: JSON.stringify({ kind: "song", songId: output.songId, title: output.title }),
        })
        .run();
      return;
    }
    this.lastSongId = null;

    if (output.kind === "slide") {
      if (this.lastDeckAssetId === output.deckAssetId) return;
      this.lastDeckAssetId = output.deckAssetId;
      this.db
        .insert(projectionHistory)
        .values({
          projectedAt: Date.now(),
          kind: "slide",
          mediaAssetId: output.deckAssetId,
          programId,
          reference: null,
          // `preload` is a transient rendering detail, not history.
          snapshotJson: JSON.stringify({
            kind: "slide",
            deckAssetId: output.deckAssetId,
            total: output.total,
          }),
        })
        .run();
      return;
    }

    this.lastDeckAssetId = null;
    this.db
      .insert(projectionHistory)
      .values({
        projectedAt: Date.now(),
        kind: output.kind,
        mediaAssetId: null,
        programId,
        reference: "reference" in output ? output.reference : null,
        snapshotJson: JSON.stringify(output),
      })
      .run();
  }

  recent(limit = 50) {
    return this.db
      .select()
      .from(projectionHistory)
      .orderBy(desc(projectionHistory.projectedAt))
      .limit(limit)
      .all();
  }

  /** Called once at startup (deferred — see `main/index.ts`) to keep the table
   *  bounded.
   *
   *  Done entirely in SQL: the previous version pulled EVERY id into memory,
   *  sorted them in JS and deleted with `IN (...)`, which on a table that had
   *  been growing unbounded (this method had no caller at all) meant both a
   *  full materialization and a bound-parameter list large enough to hit
   *  SQLite's limit — the prune would throw exactly when it was most needed. */
  prune(): void {
    // `id < (the MAX_ROWS-th newest id)` rather than `NOT IN (that set)`: the
    // subquery yields ONE value and the delete is a range scan on the primary
    // key, instead of testing every surviving row against a 5000-element set.
    // Ids are monotonic (`integer primary key`), so ordering by id is
    // ordering by age.
    //
    // Strictly `<`: the row AT that offset is the oldest keeper. With `<=` the
    // table settles at MAX_ROWS - 1, which is what the test caught. Under the
    // cap the subquery yields NULL and `id < NULL` is NULL for every row, so
    // nothing is deleted — the case that would otherwise empty the history on
    // a fresh install, silently.
    this.db
      .delete(projectionHistory)
      .where(
        sql`${projectionHistory.id} < (
          SELECT ${projectionHistory.id} FROM ${projectionHistory}
          ORDER BY ${projectionHistory.id} DESC LIMIT 1 OFFSET ${MAX_ROWS - 1}
        )`,
      )
      .run();
  }
}
