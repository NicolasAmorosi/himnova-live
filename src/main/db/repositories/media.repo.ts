import fs from "node:fs";
import path from "node:path";
import { eq, and, inArray, sql } from "drizzle-orm";
import Database from "better-sqlite3";
import type { Db } from "../client";
import { mediaAssets } from "../schema";
import { LINKED_AUDIO_RESOLVER_VERSION, type AssetKind } from "@shared/constants";
import type { MediaAsset } from "@shared/types/media";
import { resolveLinkedAudio } from "../../slides/linked-audio";
import { IpcError } from "@shared/ipc/result";

/** One `IN (...)` binds one parameter per id, and SQLite refuses the
 *  statement past `SQLITE_MAX_VARIABLE_NUMBER`. Every query here that takes
 *  a caller-sized list of ids partitions it with this. */
const ID_CHUNK = 500;

function toPathKey(filePath: string): string {
  const normalized = path.normalize(filePath).normalize("NFC");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function toDTO(row: typeof mediaAssets.$inferSelect): MediaAsset {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    ext: row.ext,
    path: row.path,
    sizeBytes: row.sizeBytes,
    mtimeMs: row.mtimeMs,
    durationMs: row.durationMs,
    linkedAudioPath: row.linkedAudioPath,
    inLibrary: row.inLibrary === 1,
    missingSince: row.missingSince,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class MediaRepo {
  constructor(
    private readonly db: Db,
    private readonly sqlite: Database.Database,
  ) {}

  list(kind: AssetKind): MediaAsset[] {
    return this.db
      .select()
      .from(mediaAssets)
      .where(and(eq(mediaAssets.kind, kind), eq(mediaAssets.inLibrary, 1)))
      .all()
      .map(toDTO);
  }

  /** Adds a file if new, or reactivates it in the library if it already exists (e.g. was
   *  referenced by a program but not shown in the library list). */
  upsertFromPath(filePath: string, kind: AssetKind, inLibrary: boolean): MediaAsset {
    const stat = fs.statSync(filePath);
    const pathKey = toPathKey(filePath);
    const now = Date.now();
    const existing = this.db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.pathKey, pathKey))
      .get();

    if (existing) {
      const mtimeMs = Math.trunc(stat.mtimeMs);
      // `createdAt` is when the asset joined the library — the media tabs'
      // «newest first» (`lib/media-view.ts`). A linked folder's or a program's
      // file that is added now is new to the library now.
      const createdAt = inLibrary && existing.inLibrary === 0 ? now : existing.createdAt;
      this.db
        .update(mediaAssets)
        .set({
          inLibrary: inLibrary || existing.inLibrary === 1 ? 1 : 0,
          createdAt,
          missingSince: null,
          lastSeenAt: now,
          sizeBytes: stat.size,
          mtimeMs,
          updatedAt: now,
        })
        .where(eq(mediaAssets.id, existing.id))
        .run();
      // The returned DTO must carry what was just written, not the row as it
      // was read: `sizeBytes`/`mtimeMs` are the identity a thumbnail's
      // cache-buster is built from (`assetThumbVersion`), so handing back the
      // pre-update values would leave the caller pointing at the previous
      // file's thumbnail.
      return toDTO({
        ...existing,
        inLibrary: inLibrary ? 1 : existing.inLibrary,
        createdAt,
        missingSince: null,
        sizeBytes: stat.size,
        mtimeMs,
        updatedAt: now,
      });
    }

    const ext = path.extname(filePath).slice(1).toLowerCase();
    const name = path.basename(filePath, path.extname(filePath));

    // Linked-audio resolution is deliberately NOT done here: for a legacy
    // `.ppt`/`.pps` it means reading the whole file into memory (see
    // `linked-audio.ts`), which is exactly the cost that makes importing many
    // decks at once freeze the app. It's left at version 0 and resolved
    // lazily, once, the first time the deck is actually opened
    // (`ensureLinkedAudio`, called from `deck-service.ts`'s `toDeckDTO`).
    const row = this.db
      .insert(mediaAssets)
      .values({
        kind,
        path: filePath,
        pathKey,
        name,
        ext,
        sizeBytes: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
        linkedAudioPath: null,
        linkedAudioResolvedVersion: 0,
        inLibrary: inLibrary ? 1 : 0,
        lastSeenAt: now,
        missingSince: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return toDTO(row);
  }

  /** Same upsert as `upsertFromPath`, batched: one `statSync` result per file
   *  (already gathered by the caller — `library-import.ts` — so a vanished
   *  file just isn't in the list) and a single transaction for the whole
   *  slice. A row whose `pathKey`, size and mtime are unchanged and already
   *  `!missing` is skipped entirely — the common case of revisiting a stable
   *  linked folder, which used to cost one `UPDATE` per file every time. */
  upsertBatch(
    files: { path: string; stat: fs.Stats }[],
    kind: AssetKind,
    inLibrary: boolean,
  ): { assets: MediaAsset[]; mutated: number } {
    if (files.length === 0) return { assets: [], mutated: 0 };
    const now = Date.now();
    const entries = files.map((file) => ({ file, pathKey: toPathKey(file.path) }));
    const existingByKey = new Map(
      this.db
        .select()
        .from(mediaAssets)
        .where(inArray(mediaAssets.pathKey, entries.map((e) => e.pathKey)))
        .all()
        .map((row) => [row.pathKey, row] as const),
    );

    const run = this.sqlite.transaction(() => {
      const results: MediaAsset[] = [];
      let mutated = 0;
      for (const { file, pathKey } of entries) {
        const sizeBytes = file.stat.size;
        const mtimeMs = Math.trunc(file.stat.mtimeMs);
        const existing = existingByKey.get(pathKey);

        if (
          existing &&
          existing.sizeBytes === sizeBytes &&
          existing.mtimeMs === mtimeMs &&
          existing.missingSince === null &&
          (existing.inLibrary === 1 || !inLibrary)
        ) {
          results.push(toDTO(existing));
          continue;
        }
        mutated += 1;

        const ext = path.extname(file.path).slice(1).toLowerCase();
        const name = path.basename(file.path, path.extname(file.path));

        // A single upsert statement, not "select then insert-or-update": two
        // imports racing on the same `pathKey` (the process-wide lock in
        // `library-import.ts` should already prevent this, but this is the
        // belt to its suspenders) resolve atomically instead of one of them
        // hitting `ux_media_path`'s UNIQUE constraint. Only the columns
        // listed in `set` are touched on conflict — `linkedAudioPath` and its
        // version are never clobbered by a re-import.
        const row = this.db
          .insert(mediaAssets)
          .values({
            kind,
            path: file.path,
            pathKey,
            name,
            ext,
            sizeBytes,
            mtimeMs,
            linkedAudioPath: null,
            linkedAudioResolvedVersion: 0,
            inLibrary: inLibrary ? 1 : 0,
            lastSeenAt: now,
            missingSince: null,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: mediaAssets.pathKey,
            set: {
              // Reactivating an inactive row must not deactivate an already-active
              // one — same "OR" semantics `upsertFromPath` uses, expressed in SQL
              // so it stays correct even under the race described above.
              inLibrary: inLibrary
                ? sql`1`
                : sql`CASE WHEN ${mediaAssets.inLibrary} = 1 THEN 1 ELSE 0 END`,
              // Joining the library now is «newest» now (see `upsertFromPath`).
              // SQLite reads every column of the SET from the row as it was.
              ...(inLibrary
                ? { createdAt: sql`CASE WHEN ${mediaAssets.inLibrary} = 1 THEN ${mediaAssets.createdAt} ELSE ${now} END` }
                : {}),
              missingSince: null,
              lastSeenAt: now,
              sizeBytes,
              mtimeMs,
              updatedAt: now,
            },
          })
          .returning()
          .get();
        results.push(toDTO(row));
      }
      return { assets: results, mutated };
    });

    return run();
  }

  /** Throws `IpcError("MEDIA_ASSET_IN_USE")` when the asset is still referenced
   *  by a program item (`onDelete: "restrict"` in the schema) — a saved
   *  program's history must not silently lose an item.
   *
   *  SQLite reports a RESTRICT violation as `SQLITE_CONSTRAINT_TRIGGER`, not
   *  `SQLITE_CONSTRAINT_FOREIGNKEY` (that code is only for an immediate FK
   *  check, e.g. an insert with a bad reference) — RESTRICT is implemented
   *  internally as a trigger, so the message is the one stable signal. */
  remove(id: number): void {
    try {
      this.db.delete(mediaAssets).where(eq(mediaAssets.id, id)).run();
    } catch (error) {
      if (error instanceof Database.SqliteError && error.message.includes("FOREIGN KEY constraint failed")) {
        throw new IpcError({
          code: "MEDIA_ASSET_IN_USE",
          message: `Media asset ${id} is still referenced by a program item`,
        });
      }
      throw error;
    }
  }

  /**
   * By-id lookups, on the `worship://` hot path.
   *
   * Every tile in a virtualized grid asks for `worship://asset/<id>/thumb`,
   * and every one of those used to be a Drizzle `SELECT *` — the whole row
   * rebuilt and recompiled per request, to read one or three columns. These
   * three are prepared once and ask only for what they use. Lazy for the same
   * reason as `SlidesRepo`'s: the repo exists before the table does.
   */
  private byIdStatement: Database.Statement | null = null;
  private pathStatement: Database.Statement | null = null;
  private hasPathStatement: Database.Statement | null = null;
  private linkedAudioStatement: Database.Statement | null = null;

  getById(id: number): MediaAsset | null {
    this.byIdStatement ??= this.sqlite.prepare(
      `SELECT id, kind, name, ext, path, size_bytes AS sizeBytes, mtime_ms AS mtimeMs,
              duration_ms AS durationMs, linked_audio_path AS linkedAudioPath,
              in_library AS inLibrary, missing_since AS missingSince,
              created_at AS createdAt, updated_at AS updatedAt
         FROM media_assets WHERE id = ?`,
    );
    const row = this.byIdStatement.get(id) as
      | (Omit<MediaAsset, "inLibrary"> & { inLibrary: number })
      | undefined;
    return row ? { ...row, inLibrary: row.inLibrary === 1 } : null;
  }

  getPathById(id: number): string | null {
    this.pathStatement ??= this.sqlite.prepare(`SELECT path FROM media_assets WHERE id = ?`);
    const row = this.pathStatement.get(id) as { path: string } | undefined;
    return row?.path ?? null;
  }

  /**
   * Whether this exact file is a row in the library.
   *
   * The reverse of `getPathById`, and it exists for one caller: the
   * `worship://raster/<taskId>` guard. A PDF is drawn from where the operator
   * keeps it, so this is the positive assertion main serves it on: the file is
   * one the operator added, which is the same property `worship://asset/<id>`
   * already rests on.
   * Matched on `pathKey` (NFC + lowercased on Windows), never the raw string.
   */
  hasPath(filePath: string): boolean {
    this.hasPathStatement ??= this.sqlite.prepare(
      `SELECT 1 FROM media_assets WHERE path_key = ? LIMIT 1`,
    );
    return this.hasPathStatement.get(toPathKey(filePath)) !== undefined;
  }

  linkedAudioPathById(id: number): string | null {
    this.linkedAudioStatement ??= this.sqlite.prepare(
      `SELECT linked_audio_path AS linkedAudioPath FROM media_assets WHERE id = ?`,
    );
    const row = this.linkedAudioStatement.get(id) as { linkedAudioPath: string | null } | undefined;
    return row?.linkedAudioPath ?? null;
  }

  // -- content hash ---------------------------------------------------------
  //
  // The asset's own copy of the identity `slide_decks` is keyed by. See the
  // column comments in `schema.ts` and `N3` in the media-chain audit §5.2:
  // without it, "is this asset converted?" can only be asked as "does this
  // asset OWN a deck row?", and ownership is exclusive while the cache is
  // content-addressed.

  /** The stored hash, but only while the `(size, mtime)` it was computed over
   *  still matches the file the row describes. A stale stamp reads as "no
   *  hash": the bytes changed, so the old digest answers about a file that no
   *  longer exists. */
  private static validHash(row: typeof mediaAssets.$inferSelect): string | null {
    if (row.contentHash === null) return null;
    if (row.contentHashSize !== row.sizeBytes) return null;
    if (row.contentHashMtimeMs !== row.mtimeMs) return null;
    return row.contentHash;
  }

  /** `assetId → content hash`, for the assets that have a currently-valid one.
   *  Chunked for the same reason `sweep` and `statusesByAsset` are: the caller
   *  is a grid handing over every asset it can see, and one `IN (...)` binds
   *  one parameter per id. */
  validContentHashes(ids: readonly number[]): Map<number, string> {
    const result = new Map<number, string>();
    if (ids.length === 0) return result;
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const slice = ids.slice(i, i + ID_CHUNK);
      for (const row of this.db
        .select()
        .from(mediaAssets)
        .where(inArray(mediaAssets.id, slice))
        .all()) {
        const hash = MediaRepo.validHash(row);
        if (hash !== null) result.set(row.id, hash);
      }
    }
    return result;
  }

  /** Records the digest together with the `(size, mtime)` it describes, so it
   *  can be invalidated without re-reading the file. Called from the two
   *  places that ever compute one: a real conversion (which needs the hash
   *  anyway, so this is free) and the startup backfill. */
  /** Stamps the digest of the file as it is NOW — so the row's own
   *  `(size, mtime)` is written too, or the stamp would read as stale against
   *  a row that still describes the file before an edit. */
  setContentHash(id: number, contentHash: string, sizeBytes: number, mtimeMs: number): void {
    this.db
      .update(mediaAssets)
      .set({ contentHash, contentHashSize: sizeBytes, contentHashMtimeMs: mtimeMs, sizeBytes, mtimeMs })
      .where(eq(mediaAssets.id, id))
      .run();
  }

  /**
   * Points the row's `(size, mtime)` at the file on disk. Nothing else keeps
   * them current for a library file edited in place (the sweep only checks
   * existence), and every content-hash stamp is validated against them — so a
   * stale row kept an edited deck's old digest "valid" and served last week's
   * slides. Also the thumbnail's cache-buster (`assetThumbVersion`).
   */
  refreshStat(id: number, sizeBytes: number, mtimeMs: number): void {
    this.db
      .update(mediaAssets)
      .set({ sizeBytes, mtimeMs, updatedAt: Date.now() })
      .where(
        and(
          eq(mediaAssets.id, id),
          sql`(${mediaAssets.sizeBytes} IS NOT ${sizeBytes} OR ${mediaAssets.mtimeMs} IS NOT ${mtimeMs})`,
        ),
      )
      .run();
  }

  /** Assets of `kind` whose stamp is missing or stale — the backfill's work
   *  list. Missing files are excluded: they cannot be read, and the sweep
   *  will re-offer them here once they come back (their stamp stays absent).
   *  `inLibrary` is deliberately NOT filtered: a linked folder's assets are
   *  `inLibrary = 0` and they are the bulk of a real library. */
  assetsNeedingContentHash(kind: AssetKind): { id: number; path: string }[] {
    return this.db
      .select({ id: mediaAssets.id, path: mediaAssets.path })
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.kind, kind),
          sql`${mediaAssets.missingSince} IS NULL`,
          sql`(${mediaAssets.contentHash} IS NULL
               OR ${mediaAssets.contentHashSize} IS NOT ${mediaAssets.sizeBytes}
               OR ${mediaAssets.contentHashMtimeMs} IS NOT ${mediaAssets.mtimeMs})`,
        ),
      )
      .all();
  }

  /** Manual override for when the heuristic in `linked-audio.ts` guesses
   *  wrong (or there's simply no matching file yet) — set from the "Assign
   *  audio" / "Remove" controls. `audioPath: null` means "this deck has no
   *  audio", not "go back to guessing" — either way, this is an explicit
   *  operator decision, so it also flips `linkedAudioManual` and freezes
   *  `ensureLinkedAudio` for this asset. */
  setLinkedAudio(id: number, audioPath: string | null): MediaAsset | null {
    const row = this.db.select().from(mediaAssets).where(eq(mediaAssets.id, id)).get();
    if (!row) return null;
    this.db
      .update(mediaAssets)
      .set({
        linkedAudioPath: audioPath,
        linkedAudioManual: 1,
        linkedAudioResolvedVersion: LINKED_AUDIO_RESOLVER_VERSION,
        updatedAt: Date.now(),
      })
      .where(eq(mediaAssets.id, id))
      .run();
    return toDTO({ ...row, linkedAudioPath: audioPath, linkedAudioManual: 1 });
  }

  /** Re-resolves the linked audio for a `ppt` asset, unless the operator
   *  already made an explicit call (`linkedAudioManual`) — that decision
   *  always wins over the heuristic. Called on every deck load (`peek`/
   *  `ensure` fire on every switch between decks in the UI), so the fast
   *  path matters: `resolveLinkedAudio` reads the whole folder and, for
   *  legacy binaries, the whole presentation file into memory to extract its
   *  hint — reasonable once, not on every click. A row already resolved at
   *  the current `LINKED_AUDIO_RESOLVER_VERSION` is trusted as-is (even a
   *  cached "no match") as long as its file, if any, still exists; only a
   *  stale version or a missing file pays for a full re-resolution. That
   *  version bump is what self-corrects assets linked under an older,
   *  looser version of the matching rules without a per-asset manual fix. */
  ensureLinkedAudio(id: number): void {
    const row = this.db.select().from(mediaAssets).where(eq(mediaAssets.id, id)).get();
    if (!row || row.kind !== "ppt") return;
    if (row.linkedAudioManual === 1) return;
    const upToDate = row.linkedAudioResolvedVersion === LINKED_AUDIO_RESOLVER_VERSION;
    const fileStillThere = row.linkedAudioPath === null || fs.existsSync(row.linkedAudioPath);
    if (upToDate && fileStillThere) return;

    const resolved = resolveLinkedAudio(row.path);
    if (resolved !== row.linkedAudioPath || !upToDate) {
      this.db
        .update(mediaAssets)
        .set({
          linkedAudioPath: resolved,
          linkedAudioResolvedVersion: LINKED_AUDIO_RESOLVER_VERSION,
          updatedAt: Date.now(),
        })
        .where(eq(mediaAssets.id, id))
        .run();
    }
  }

  /** Re-stats every in-library row — and every linked-folder row a saved
   *  program uses: without those, a schedule item from a linked folder never
   *  got `missingSince`, so its «Locate…» panel never appeared and it
   *  failed later, on GO LIVE — marking newly-missing files and clearing
   *  the flag on ones that reappeared (e.g. a reconnected drive). Never
   *  deletes rows. Chunked with a yield every 200 rows — a large library must
   *  never turn this into a multi-second main-thread stall — and writes go
   *  through in a couple of `id IN (...)` statements instead of one `UPDATE`
   *  per row. Returns the kinds that actually changed, so a caller only
   *  refreshes what's stale instead of every tab. */
  async sweep(): Promise<Set<AssetKind>> {
    const rows = this.db
      .select()
      .from(mediaAssets)
      .where(
        sql`${mediaAssets.inLibrary} = 1 OR ${mediaAssets.id} IN
              (SELECT media_asset_id FROM program_items WHERE media_asset_id IS NOT NULL)`,
      )
      .all();
    const changedKinds = new Set<AssetKind>();
    const toClear: number[] = [];
    const toMark: number[] = [];
    const toRestat: { id: number; sizeBytes: number; mtimeMs: number }[] = [];

    // Asynchronous existence checks, a chunk at a time. `existsSync` per row
    // was the wrong tool for the one case this function exists to handle: a
    // removable drive or a network share that went away answers each call in
    // milliseconds-to-seconds, and a synchronous loop over a large library
    // then blocks the main process — and therefore the projection — for as
    // long as that takes. The `setImmediate` yield only limited how long each
    // BATCH blocked, not the calls themselves.
    const PROBE_CHUNK = 200;
    for (let i = 0; i < rows.length; i += PROBE_CHUNK) {
      const slice = rows.slice(i, i + PROBE_CHUNK);
      //
      // `stat`, not `access`: the same one syscall, and it is the only place
      // that notices a file EDITED in place. Every stamp in the app — a deck's
      // content hash, a video's probe, a thumbnail — is
      // checked against the row's `(size, mtime)`, so a row nobody refreshed
      // kept last week's announcements "current" forever.
      const stats = await Promise.all(slice.map((row) => fs.promises.stat(row.path).catch(() => null)));
      slice.forEach((row, index) => {
        const stat = stats[index];
        if (stat && row.missingSince !== null) {
          toClear.push(row.id);
          changedKinds.add(row.kind);
        } else if (!stat && row.missingSince === null) {
          toMark.push(row.id);
          changedKinds.add(row.kind);
        }
        if (stat && (stat.size !== row.sizeBytes || Math.trunc(stat.mtimeMs) !== row.mtimeMs)) {
          toRestat.push({ id: row.id, sizeBytes: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) });
          changedKinds.add(row.kind);
        }
      });
      await new Promise((resolve) => setImmediate(resolve));
    }

    if (toClear.length === 0 && toMark.length === 0 && toRestat.length === 0) return changedKinds;

    const now = Date.now();
    const run = this.sqlite.transaction(() => {
      for (let i = 0; i < toClear.length; i += ID_CHUNK) {
        const slice = toClear.slice(i, i + ID_CHUNK);
        this.db
          .update(mediaAssets)
          .set({ missingSince: null, lastSeenAt: now })
          .where(inArray(mediaAssets.id, slice))
          .run();
      }
      for (let i = 0; i < toMark.length; i += ID_CHUNK) {
        const slice = toMark.slice(i, i + ID_CHUNK);
        this.db
          .update(mediaAssets)
          .set({ missingSince: now })
          .where(inArray(mediaAssets.id, slice))
          .run();
      }
      for (const { id, sizeBytes, mtimeMs } of toRestat) this.refreshStat(id, sizeBytes, mtimeMs);
    });
    run();

    return changedKinds;
  }

  /**
   * Points the row at `newPath`, keeping its id — the one the program items,
   * plates and history already reference.
   *
   * The new path may already be a row of its own, and in a real library it
   * usually is: 1485 of 1501 rows come from linked folders, so after a USB
   * stick comes back as F: instead of E: and its folder is re-linked, every
   * file there has a row before the operator relocates a single item. A plain
   * UPDATE then broke `ux_media_path`'s UNIQUE and «Locate…» failed with a
   * generic toast. The two rows are the same file, so they are MERGED: every
   * reference to the duplicate moves to this id, in one transaction, and the
   * duplicate goes (its `media_conversions` row with it, by cascade).
   *
   * References inside JSON columns (a scene's or the verse's background
   * image) are not rewritten. They are read through normalizers that already
   * tolerate an asset that is gone, and a linked-folder duplicate is not what
   * an operator picks as a background.
   */
  relocate(id: number, newPath: string): MediaAsset | null {
    const row = this.db.select().from(mediaAssets).where(eq(mediaAssets.id, id)).get();
    if (!row) return null;
    const stat = fs.statSync(newPath);
    const mtimeMs = Math.trunc(stat.mtimeMs);
    const now = Date.now();
    const pathKey = toPathKey(newPath);

    const inLibrary = this.sqlite.transaction(() => {
      const duplicate = this.db.select().from(mediaAssets).where(eq(mediaAssets.pathKey, pathKey)).get();
      let keepInLibrary = row.inLibrary;
      // When it joined the library («newest first»): the one of the two that did.
      let createdAt = row.createdAt;
      if (duplicate && duplicate.id !== id) {
        for (const statement of [
          "UPDATE program_items SET media_asset_id = ? WHERE media_asset_id = ?",
          "UPDATE overlay_plates SET image_asset_id = ? WHERE image_asset_id = ?",
          "UPDATE slide_decks SET media_asset_id = ? WHERE media_asset_id = ?",
          "UPDATE projection_history SET media_asset_id = ? WHERE media_asset_id = ?",
        ]) {
          this.sqlite.prepare(statement).run(id, duplicate.id);
        }
        // Shown in the library if either one was.
        keepInLibrary = Math.max(row.inLibrary, duplicate.inLibrary);
        if (row.inLibrary === 0 && duplicate.inLibrary === 1) createdAt = duplicate.createdAt;
        this.db.delete(mediaAssets).where(eq(mediaAssets.id, duplicate.id)).run();
      }
      this.db
        .update(mediaAssets)
        .set({
          path: newPath,
          pathKey,
          sizeBytes: stat.size,
          mtimeMs,
          inLibrary: keepInLibrary,
          createdAt,
          missingSince: null,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(mediaAssets.id, id))
        .run();
      return keepInLibrary;
    })();

    // Same reason as `upsertFromPath`: the relocated file is a different set
    // of bytes as far as the thumbnail cache is concerned.
    return toDTO({
      ...row,
      path: newPath,
      pathKey,
      sizeBytes: stat.size,
      mtimeMs,
      inLibrary,
      missingSince: null,
      updatedAt: now,
    });
  }
}
