import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import type Database from "better-sqlite3";
import type { Db } from "../client";
import { deckAudio, deckSlides, deckVideos, mediaAssets, slideDecks } from "../schema";
import { slideModelUrl, slideThumbUrl, slideUrl, deckAudioUrl, deckVideoUrl, engineClipUrl, linkedAudioUrl } from "@shared/urls";
import { SLIDES_CONVERTER_VERSION, SLIDES_NATIVE_VERSION, SLIDES_MODEL_VERSION } from "@shared/constants";
import type { DeckDTO, DeckSlide, DeckSlideVideo, DeckSound, DeckStatus, SlideRect } from "@shared/types/deck";
import { isSlideTransitionStyle, type SlideTransition } from "@shared/types/transition";

/** One `IN (...)` binds one parameter per id; SQLite refuses the statement
 *  past `SQLITE_MAX_VARIABLE_NUMBER`. Same partition size `media.repo.ts`
 *  uses. */
const ID_CHUNK = 500;

export type DeckRow = typeof slideDecks.$inferSelect;

/** What `statusesByAsset` knows about an asset's most recent deck row. The
 *  `deckId` rides along because it costs one more column in a query that
 *  already runs, and it is what lets a library tile address the deck's own
 *  first-slide thumbnail (`worship://deck/<deckId>/1/thumb`) without one
 *  `deck:get` per tile. */
export type DeckRowSummary = { deckId: number; status: DeckStatus; drawnFromModel: boolean };
type SlideRow = typeof deckSlides.$inferSelect;
type AudioRow = typeof deckAudio.$inferSelect;
type VideoRow = typeof deckVideos.$inferSelect;

/** Whether a deck row was written by the pipeline this build runs — the
 *  rasterizer's version for a converted deck, each reader's for a deck read
 *  from its source (native, model). */
export function isCurrentDeck(row: Pick<DeckRow, "imageFormat" | "converterVersion">): boolean {
  const current =
    row.imageFormat === "native" ? SLIDES_NATIVE_VERSION : row.imageFormat === "model" ? SLIDES_MODEL_VERSION : SLIDES_CONVERTER_VERSION;
  return row.converterVersion === current;
}

/** What `worship://deck/<id>/<n>` serves, built from the deck's source every
 *  time: a native slide's pictures (`native-deck.ts`), or a PDF's page drawn
 *  by pdf.js (`rasterizer.ts`). */
export type SlideImage =
  | {
      kind: "native";
      variant: "full" | "thumb";
      sourcePath: string;
      sourceSizeBytes: number;
      sourceMtimeMs: number;
      layers: string;
    }
  | {
      kind: "pdf";
      variant: "full" | "thumb";
      page: number;
      sourcePath: string;
      sourceSizeBytes: number;
      sourceMtimeMs: number;
      renderWidth: number;
      imageFormat: "webp" | "png";
    };

export type NewDeck = {
  contentHash: string;
  renderWidth: number;
  imageFormat: "webp" | "png" | "native" | "model";
  converterVersion: number;
  mediaAssetId: number | null;
  sourcePath: string;
  sourceSizeBytes: number;
  sourceMtimeMs: number;
  cacheDir: string;
  aspectRatio: string | null;
  timingsSource: "ooxml" | "binary" | "odf" | "none";
  bytesOnDisk: number;
  /** Defaults to the moment of insertion. A background prewarm backdates
   *  this on purpose — see the call site in `deck-service.ts`. */
  lastUsedAt?: number;
};

export type NewSlide = {
  slideIndex: number;
  imageFile: string;
  thumbFile: string;
  widthPx: number;
  heightPx: number;
  bytes: number;
  advanceMs: number | null;
  advanceOnClick: boolean;
  transition: SlideTransition | null;
  hidden: boolean;
  title: string | null;
  notes: string | null;
  /** `SlideLayers` JSON for a native deck's slide, `null` for a rasterized
   *  one (whose `imageFile` is then the image). */
  layers: string | null;
};

export type NewAudio = {
  audioFile: string;
  ext: string;
  bytes: number;
  origin: "embedded" | "transition";
  scope: "deck" | "slide";
  startSlideIndex: number | null;
  stopSlideIndex: number | null;
  loop: boolean;
  volume: number | null;
  playable: boolean;
};

export type NewVideo = {
  slideIndex: number;
  videoFile: string;
  ext: string;
  bytes: number;
  rect: SlideRect;
  loop: boolean;
  /** 0..1, or null when the source file doesn't say. Stored as a percent, like
   *  `NewAudio.volume`. */
  volume: number | null;
  playable: boolean;
};

export class SlidesRepo {
  constructor(
    private readonly db: Db,
    private readonly sqlite: Database.Database,
  ) {}

  /**
   * Prepared statements for the `worship://` path resolvers.
   *
   * better-sqlite3 caches the compiled plan on the Statement object, so the
   * win is in preparing ONCE — Drizzle builds and compiles a fresh statement
   * per call. Created lazily rather than in the constructor because the repo
   * is constructed before migrations have necessarily created these tables.
   */
  private slideImageStatement: Database.Statement | null = null;
  private audioPathStatement: Database.Statement | null = null;

  private slideImageStmt(): Database.Statement {
    this.slideImageStatement ??= this.sqlite.prepare(
      `SELECT d.cache_dir AS cacheDir, s.layers AS layers, d.image_format AS imageFormat,
              d.render_width AS renderWidth, d.source_path AS sourcePath,
              d.source_size_bytes AS sourceSizeBytes, d.source_mtime_ms AS sourceMtimeMs
         FROM deck_slides s JOIN slide_decks d ON d.id = s.deck_id
        WHERE s.deck_id = ? AND s.slide_index = ?`,
    );
    return this.slideImageStatement;
  }

  private deckSourceStatement: Database.Statement | null = null;

  /** Whether some deck was read from `sourcePath` — every deck's source was a
   *  library file when it was read. */
  isDeckSource(sourcePath: string): boolean {
    this.deckSourceStatement ??= this.sqlite.prepare(`SELECT 1 FROM slide_decks WHERE source_path = ? LIMIT 1`);
    return this.deckSourceStatement.get(sourcePath) !== undefined;
  }

  private insertSlideStatement: Database.Statement | null = null;
  private insertAudioStatement: Database.Statement | null = null;
  private insertVideoStatement: Database.Statement | null = null;
  private videoPathStatement: Database.Statement | null = null;

  private insertSlideStmt(): Database.Statement {
    this.insertSlideStatement ??= this.sqlite.prepare(
      `INSERT INTO deck_slides
         (deck_id, slide_index, image_file, thumb_file, width_px, height_px, bytes,
          advance_ms, advance_on_click, transition, transition_ms, hidden, title, notes, layers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    return this.insertSlideStatement;
  }

  private insertAudioStmt(): Database.Statement {
    this.insertAudioStatement ??= this.sqlite.prepare(
      `INSERT INTO deck_audio
         (deck_id, audio_file, ext, bytes, origin, scope, start_slide_index,
          stop_slide_index, loop, volume, playable)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    return this.insertAudioStatement;
  }

  private insertVideoStmt(): Database.Statement {
    this.insertVideoStatement ??= this.sqlite.prepare(
      `INSERT INTO deck_videos
         (deck_id, slide_index, video_file, ext, bytes,
          rect_x, rect_y, rect_width, rect_height, loop, volume, playable)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    return this.insertVideoStatement;
  }

  private videoPathStmt(): Database.Statement {
    this.videoPathStatement ??= this.sqlite.prepare(
      `SELECT d.cache_dir AS cacheDir, v.video_file AS videoFile
         FROM deck_videos v JOIN slide_decks d ON d.id = v.deck_id
        WHERE v.id = ?`,
    );
    return this.videoPathStatement;
  }

  private audioPathStmt(): Database.Statement {
    this.audioPathStatement ??= this.sqlite.prepare(
      `SELECT d.cache_dir AS cacheDir, a.audio_file AS audioFile
         FROM deck_audio a JOIN slide_decks d ON d.id = a.deck_id
        WHERE a.id = ?`,
    );
    return this.audioPathStatement;
  }

  // -- lookup ---------------------------------------------------------------

  /** Fast path: same file (by size+mtime) already converted for this asset. */
  findDeckByAsset(mediaAssetId: number): DeckRow | null {
    return (
      this.db
        .select()
        .from(slideDecks)
        .where(eq(slideDecks.mediaAssetId, mediaAssetId))
        .orderBy(sql`${slideDecks.lastUsedAt} DESC`)
        .get() ?? null
    );
  }

  /** This asset's deck read from its source in `format` (native, model),
   *  whatever else it has: until the next launch it may still own the
   *  converted copy it replaced. */
  findSourceDeckByAsset(mediaAssetId: number, format: "native" | "model"): DeckRow | null {
    return (
      this.db
        .select()
        .from(slideDecks)
        .where(and(eq(slideDecks.mediaAssetId, mediaAssetId), eq(slideDecks.imageFormat, format)))
        .orderBy(sql`${slideDecks.lastUsedAt} DESC`)
        .get() ?? null
    );
  }

  /**
   * One query per chunk for a whole grid's worth of assets, instead of
   * `findDeckByAsset` + `fs.existsSync` per asset (what `deckStatuses` used to
   * do). Deliberately skips the filesystem: a cache dir that vanished out from
   * under a `ready` row is caught when the deck is read (`prepareDeck`), not
   * by a status badge that exists to answer "does this still need reading?"
   * for hundreds of tiles at once without touching disk hundreds of times.
   *
   * **Asked by CONTENT, then by ownership** — this is the fix for `N3`
   * (media-chain audit §5.2). It used to ask only "which deck row does this
   * asset OWN?", and ownership is exclusive: `relinkDeck` MOVES
   * `mediaAssetId` when another asset resolves to the same bytes, while the
   * cache itself is addressed by `contentHash + renderWidth + imageFormat`.
   * With the same file present twice, one asset held the row and the other
   * reported "pending" forever — measured on the real library, 555 of 1235
   * assets with zero work to do, and a count that oscillated instead of
   * reaching zero because preparing one folder stole the rows back from the
   * other. Every caller inherited it: the "Prepare folder" count, the tile
   * thumbnails, and `adoptProgram`'s eviction pins.
   *
   * So the primary lookup joins `media_assets.content_hash` (stamped with the
   * `(size, mtime)` that validates it — see `schema.ts`) to the deck's own
   * `contentHash`. Ownership stays as the fallback for assets whose hash is
   * not stamped yet: the backfill is asynchronous and a grid drawn in the
   * meantime must keep reporting what it reported before, not regress to
   * "nothing is converted".
   *
   * Both passes keep the most recently used row per asset — the same tie-break
   * `findDeckByAsset` uses, and the reason `mediaAssetId` being non-unique
   * here (a re-linked deck leaves old rows around until GC) is harmless.
   */
  statusesByAsset(mediaAssetIds: readonly number[]): Map<number, DeckRowSummary> {
    const result = new Map<number, DeckRowSummary>();
    if (mediaAssetIds.length === 0) return result;

    // Chunked for the same reason `media.repo.ts`'s sweep is: one `IN (...)`
    // binds one parameter per id, and SQLite refuses the statement past
    // SQLITE_MAX_VARIABLE_NUMBER. The caller is a grid handing over every
    // asset it can see, so the day a linked folder holds a few thousand decks
    // this stops being theoretical — and it would fail as a thrown query, not
    // as a slow one.
    //
    // Rows arrive newest-first *within each chunk*, which is all this needs:
    // a given assetId's rows can only ever land in one chunk, since the chunks
    // partition the ids.
    const take = (
      rows: readonly {
        id: number;
        assetId: number | null;
        status: string;
        converterVersion: number;
        imageFormat: DeckRow["imageFormat"];
      }[],
    ) => {
      for (const row of rows) {
        if (row.assetId === null || result.has(row.assetId)) continue;
        // Same DB-status → `DeckStatus` collapse `toDTO` uses ("pending"/
        // "converting" both read as "still converting" to a caller that only
        // wants to know whether it's safe to skip this asset). A row from an
        // older converter is `stale`, not `ready`: opening it reconverts it,
        // so every prewarm that skips `ready` has to upgrade it BEFORE the
        // service instead — 677 of 685 decks in the real library were v2 and
        // all of them claimed to be prepared.
        const status: DeckStatus =
          row.status === "error"
            ? "failed"
            : row.status !== "ready"
              ? "converting"
              : isCurrentDeck(row)
                ? "ready"
                : "stale";
        result.set(row.assetId, { deckId: row.id, status, drawnFromModel: row.imageFormat === "model" });
      }
    };

    for (let i = 0; i < mediaAssetIds.length; i += ID_CHUNK) {
      const slice = mediaAssetIds.slice(i, i + ID_CHUNK);

      // 1. By content. `IS` rather than `=` on purpose: both sides are
      //    nullable, and a row with no size/mtime recorded must not match a
      //    stamp that also has none — but `contentHash IS NOT NULL` already
      //    excludes that, and `IS` keeps the comparison from going NULL (i.e.
      //    silently false-but-not-false) for any other combination.
      take(
        this.db
          .select({
            id: slideDecks.id,
            assetId: mediaAssets.id,
            status: slideDecks.status,
            converterVersion: slideDecks.converterVersion,
            imageFormat: slideDecks.imageFormat,
          })
          .from(mediaAssets)
          .innerJoin(slideDecks, eq(slideDecks.contentHash, mediaAssets.contentHash))
          .where(
            and(
              inArray(mediaAssets.id, slice),
              sql`${mediaAssets.contentHash} IS NOT NULL`,
              sql`${mediaAssets.contentHashSize} IS ${mediaAssets.sizeBytes}`,
              sql`${mediaAssets.contentHashMtimeMs} IS ${mediaAssets.mtimeMs}`,
            ),
          )
          .orderBy(sql`${slideDecks.lastUsedAt} DESC`)
          .all(),
      );

      // 2. By ownership, for whatever the content pass could not answer.
      const unresolved = slice.filter((id) => !result.has(id));
      if (unresolved.length === 0) continue;
      take(
        this.db
          .select({
            id: slideDecks.id,
            assetId: slideDecks.mediaAssetId,
            status: slideDecks.status,
            converterVersion: slideDecks.converterVersion,
            imageFormat: slideDecks.imageFormat,
          })
          .from(slideDecks)
          .where(inArray(slideDecks.mediaAssetId, unresolved))
          .orderBy(sql`${slideDecks.lastUsedAt} DESC`)
          .all(),
      );
    }
    return result;
  }

  /** The deck matching an asset's stamped content hash at the current render
   *  settings — the exact identity `insertDeck` enforces, so at most one row.
   *  Lets a reader (`nativeDeck`, `modelDeck`, `pdfDeck`) resolve a duplicate file without re-reading it just to
   *  recompute a digest the asset already carries. */
  findDeckByAssetContent(mediaAssetId: number, renderWidth: number, imageFormat: DeckRow["imageFormat"]): DeckRow | null {
    const row = this.db
      .select({ deck: slideDecks })
      .from(mediaAssets)
      .innerJoin(
        slideDecks,
        and(
          eq(slideDecks.contentHash, mediaAssets.contentHash),
          eq(slideDecks.renderWidth, renderWidth),
          eq(slideDecks.imageFormat, imageFormat),
        ),
      )
      .where(
        and(
          eq(mediaAssets.id, mediaAssetId),
          sql`${mediaAssets.contentHash} IS NOT NULL`,
          sql`${mediaAssets.contentHashSize} IS ${mediaAssets.sizeBytes}`,
          sql`${mediaAssets.contentHashMtimeMs} IS ${mediaAssets.mtimeMs}`,
        ),
      )
      .get();
    return row?.deck ?? null;
  }

  /** Content-addressed hit: the same bytes converted at the same settings,
   *  even if it arrived through a different library entry or a moved file. */
  findDeckByIdentity(
    contentHash: string,
    renderWidth: number,
    imageFormat: DeckRow["imageFormat"],
  ): DeckRow | null {
    return (
      this.db
        .select()
        .from(slideDecks)
        .where(
          and(
            eq(slideDecks.contentHash, contentHash),
            eq(slideDecks.renderWidth, renderWidth),
            eq(slideDecks.imageFormat, imageFormat),
          ),
        )
        .get() ?? null
    );
  }

  getDeckById(deckId: number): DeckRow | null {
    return this.db.select().from(slideDecks).where(eq(slideDecks.id, deckId)).get() ?? null;
  }

  listSlides(deckId: number): SlideRow[] {
    return this.db
      .select()
      .from(deckSlides)
      .where(eq(deckSlides.deckId, deckId))
      .orderBy(asc(deckSlides.slideIndex))
      .all();
  }

  listAudio(deckId: number): AudioRow[] {
    return this.db.select().from(deckAudio).where(eq(deckAudio.deckId, deckId)).all();
  }

  listVideos(deckId: number): VideoRow[] {
    return this.db
      .select()
      .from(deckVideos)
      .where(eq(deckVideos.deckId, deckId))
      .orderBy(asc(deckVideos.slideIndex))
      .all();
  }

  // -- writes ---------------------------------------------------------------

  /** A clip `media/deck-clips.ts` looked at again: the same row, found playable
   *  after all, or pointed back at the original an earlier build converted
   *  (`playable` false: only the media engine plays it). Its id — and its url —
   *  never change. */
  updateClip(kind: "video" | "audio", id: number, file: string, ext: string, bytes: number, playable = true): void {
    const flag = playable ? 1 : 0;
    if (kind === "video") {
      this.db
        .update(deckVideos)
        .set({ videoFile: file, ext, bytes, playable: flag })
        .where(eq(deckVideos.id, id))
        .run();
    } else {
      this.db
        .update(deckAudio)
        .set({ audioFile: file, ext, bytes, playable: flag })
        .where(eq(deckAudio.id, id))
        .run();
    }
  }

  /** Clips still on the playable copy a build before step 1.4 of the engine plan made
   *  (`<n>.playable.mp4`/`.m4a`, next to the original in the deck's folder). */
  clipsOnPlayableCopies(): { kind: "video" | "audio"; id: number; cacheDir: string; file: string }[] {
    return this.sqlite
      .prepare(
        `SELECT 'video' AS kind, v.id, d.cache_dir AS cacheDir, v.video_file AS file
           FROM deck_videos v JOIN slide_decks d ON d.id = v.deck_id
          WHERE v.video_file LIKE '%.playable.%'
         UNION ALL
         SELECT 'audio', a.id, d.cache_dir, a.audio_file
           FROM deck_audio a JOIN slide_decks d ON d.id = a.deck_id
          WHERE a.audio_file LIKE '%.playable.%'`,
      )
      .all() as { kind: "video" | "audio"; id: number; cacheDir: string; file: string }[];
  }

  /** Single transaction: a half-inserted deck must never be observable. */
  insertDeck(deck: NewDeck, slides: NewSlide[], audio: NewAudio[], videos: NewVideo[] = []): number {
    const now = Date.now();
    const insert = this.sqlite.transaction(() => {
      // Replace any previous read with the same identity (a forced re-read, a
      // newer reader, the same bytes through a copy not hashed yet) so
      // ux_deck_identity never collides — under the SAME id: windows ask for
      // `worship://deck/<id>/<n>`, and a new id left a deck already on air
      // asking for slides of a row that no longer existed (blank, mid-service).
      // ponytail: its audio/video rows still get new ids, so a clip on air
      // through this deck loses its url; keep those ids too if that bites.
      const existing = this.findDeckByIdentity(
        deck.contentHash,
        deck.renderWidth,
        deck.imageFormat,
      );
      if (existing) this.deleteDeckRow(existing.id);

      const deckId = this.db
        .insert(slideDecks)
        .values({
          ...deck,
          ...(existing ? { id: existing.id } : {}),
          slideCount: slides.length,
          transitionsRead: 1,
          status: "ready",
          errorCode: null,
          errorMessage: null,
          createdAt: now,
          updatedAt: now,
          lastUsedAt: deck.lastUsedAt ?? now,
        })
        .run().lastInsertRowid as number;

      // One prepared statement re-run per row, not one statement BUILT and
      // compiled per row: a 400-slide deck used to make Drizzle assemble 400
      // INSERTs inside the transaction.
      const insertSlide = this.insertSlideStmt();
      for (const slide of slides) {
        insertSlide.run(
          deckId,
          slide.slideIndex,
          slide.imageFile,
          slide.thumbFile,
          slide.widthPx,
          slide.heightPx,
          slide.bytes,
          slide.advanceMs,
          slide.advanceOnClick ? 1 : 0,
          slide.transition?.style ?? null,
          slide.transition?.durationMs ?? null,
          slide.hidden ? 1 : 0,
          slide.title,
          slide.notes,
          slide.layers,
        );
      }

      const insertAudio = this.insertAudioStmt();
      for (const track of audio) {
        insertAudio.run(
          deckId,
          track.audioFile,
          track.ext,
          track.bytes,
          track.origin,
          track.scope,
          track.startSlideIndex,
          track.stopSlideIndex,
          track.loop ? 1 : 0,
          track.volume === null ? null : Math.round(track.volume * 100),
          track.playable ? 1 : 0,
        );
      }

      const insertVideo = this.insertVideoStmt();
      for (const video of videos) {
        insertVideo.run(
          deckId,
          video.slideIndex,
          video.videoFile,
          video.ext,
          video.bytes,
          video.rect.x,
          video.rect.y,
          video.rect.width,
          video.rect.height,
          video.loop ? 1 : 0,
          video.volume === null ? null : Math.round(video.volume * 100),
          video.playable ? 1 : 0,
        );
      }

      return deckId;
    });

    return insert();
  }

  touchDeck(deckId: number): void {
    this.db
      .update(slideDecks)
      .set({ lastUsedAt: Date.now() })
      .where(eq(slideDecks.id, deckId))
      .run();
  }

  /** Re-points an existing content-addressed deck at the library entry that
   *  just asked for it (the "same file added twice" case).
   *
   *  The source stamp moves with it. The row describes whichever file it is
   *  pointed at, and leaving the previous copy's `(size, mtime)` behind meant
   *  a reader's first lookup — the one that costs a single `statSync` —
   *  could never match again for the new owner: a file merely `touch`ed, or a
   *  duplicate saved at a different moment, fell through to the slower lookup
   *  on every single open, forever. */
  relinkDeck(
    deckId: number,
    mediaAssetId: number,
    sourcePath: string,
    sourceSizeBytes: number,
    sourceMtimeMs: number,
  ): void {
    const now = Date.now();
    this.db
      .update(slideDecks)
      .set({ mediaAssetId, sourcePath, sourceSizeBytes, sourceMtimeMs, lastUsedAt: now, updatedAt: now })
      .where(eq(slideDecks.id, deckId))
      .run();
  }

  setStatus(deckId: number, status: DeckStatus, errorCode?: string, errorMessage?: string): void {
    this.db
      .update(slideDecks)
      .set({
        status: status === "ready" ? "ready" : status === "failed" ? "error" : "converting",
        errorCode: errorCode ?? null,
        errorMessage: errorMessage ?? null,
        updatedAt: Date.now(),
      })
      .where(eq(slideDecks.id, deckId))
      .run();
  }

  private deleteDeckRow(deckId: number): void {
    this.db.delete(slideDecks).where(eq(slideDecks.id, deckId)).run();
  }

  /** Removes the cache directory first, then the row (children CASCADE). A
   *  failed rmSync leaves a row whose files are gone, which self-heals on the
   *  next existence check. */
  deleteDeck(deckId: number): void {
    const row = this.getDeckById(deckId);
    // A native deck owns no folder, and a model deck only one for the media it
    // extracted: an empty `cacheDir` is "none", and `rmSync` of a path resolved
    // from "" is the process's working directory.
    if (row && row.imageFormat !== "native" && row.cacheDir !== "") {
      try {
        fs.rmSync(row.cacheDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    this.deleteDeckRow(deckId);
  }

  // -- cache housekeeping ---------------------------------------------------

  /**
   * Points every deck row at its folder under `cacheRoot`, the slide cache of
   * the profile open now. A row stores its folder as an ABSOLUTE path, so a
   * profile copied to another folder, account or machine carries rows naming
   * the original's folders: `worship://` refuses to serve outside this
   * profile (every slide a broken image under the projector), and deleting
   * such a deck deleted the ORIGINAL's files. A folder of the same name in
   * this cache — which a copy brings along — is that deck's; without one the
   * row is forgotten, never its files, and the deck converts again on demand.
   * `path.win32.basename` because it splits on both separators: a Windows
   * profile's rows read on a Mac, and the reverse. Returns the two counts.
   */
  adoptCacheRoot(cacheRoot: string): { rebased: number; forgotten: number } {
    const root = path.resolve(cacheRoot);
    const rows = this.db
      .select({ id: slideDecks.id, dir: slideDecks.cacheDir })
      .from(slideDecks)
      .where(sql`${slideDecks.imageFormat} <> 'native' AND ${slideDecks.cacheDir} <> ''`)
      .all();
    const counts = { rebased: 0, forgotten: 0 };
    this.sqlite.transaction(() => {
      for (const row of rows) {
        if (path.dirname(path.resolve(row.dir)) === root) continue;
        const local = path.join(root, path.win32.basename(row.dir));
        if (fs.existsSync(local)) {
          this.db.update(slideDecks).set({ cacheDir: local }).where(eq(slideDecks.id, row.id)).run();
          counts.rebased += 1;
        } else {
          this.deleteDeckRow(row.id);
          counts.forgotten += 1;
        }
      }
    })();
    return counts;
  }

  allDeckDirs(): string[] {
    return this.db
      .select({ dir: slideDecks.cacheDir })
      .from(slideDecks)
      .where(sql`${slideDecks.imageFormat} <> 'native' AND ${slideDecks.cacheDir} <> ''`)
      .all()
      .map((r) => r.dir);
  }

  /** `allDeckDirs().length` used to answer this — every cache path in the
   *  database materialized as a string, to read one number. */
  deckCount(): number {
    // What the cache holds: a deck read from its source with no folder is a
    // few rows describing a file elsewhere, not a cached copy of anything.
    const row = this.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(slideDecks)
      .where(sql`${slideDecks.imageFormat} <> 'native' AND ${slideDecks.cacheDir} <> ''`)
      .get();
    return row?.n ?? 0;
  }

  totalBytes(): number {
    const row = this.db
      .select({ total: sql<number>`COALESCE(SUM(${slideDecks.bytesOnDisk}), 0)` })
      .from(slideDecks)
      .get();
    return row?.total ?? 0;
  }

  /**
   * Oldest-first eviction candidates, excluding anything recently used or
   * currently on screen.
   *
   * Two columns and a `LIMIT`, not `SELECT *` over every row under the cutoff:
   * eviction only ever needs the id to delete and the bytes to subtract, and
   * it usually stops after the first few. The caller re-asks for another page
   * if it is still over budget — rows it deleted are gone, so the next call
   * naturally continues where this one stopped.
   */
  lruCandidates(
    excludeIds: number[],
    usedBefore: number,
    limit: number,
  ): { id: number; bytesOnDisk: number }[] {
    // A deck with no folder frees nothing when deleted, and is read again on
    // next use.
    const base = and(
      lt(slideDecks.lastUsedAt, usedBefore),
      sql`${slideDecks.imageFormat} <> 'native' AND ${slideDecks.cacheDir} <> ''`,
      excludeIds.length > 0 ? notInArray(slideDecks.id, excludeIds) : undefined,
    );
    return this.db
      .select({ id: slideDecks.id, bytesOnDisk: slideDecks.bytesOnDisk })
      .from(slideDecks)
      .where(base)
      .orderBy(asc(slideDecks.lastUsedAt))
      .limit(limit)
      .all();
  }

  /** Every deck, rows and cache directories alike — the "Clear cache" button.
   *  Goes through `deleteDeck` one by one rather than a single `DELETE FROM`
   *  so each cache directory is removed with its row; a bulk delete would
   *  leave the whole `slides-cache` on disk with nothing left pointing at it.
   *  Returns how many decks went. */
  deleteAllDecks(): number {
    const rows = this.db.select({ id: slideDecks.id }).from(slideDecks).all();
    for (const row of rows) this.deleteDeck(row.id);
    return rows.length;
  }

  /**
   * Deletes `deck_slides`/`deck_audio` rows whose deck is gone.
   *
   * There should never be any: both tables declare `ON DELETE cascade`,
   * `foreign_keys = ON` has been set in `client.ts` since the first commit,
   * and a delete through `deleteDeck` does cascade — measured. And yet a real
   * library was found carrying 184 of them, across 35 deck ids in one
   * contiguous recent run, so *something* produced them and the cause has not
   * been reproduced. This is the same bet `sweepCache` already makes about
   * cache directories: reconcile the state at launch rather than trust that
   * every path that could have broken it is gone. Returns how many rows went.
   */
  deleteOrphanDeckChildren(): number {
    const slides = this.db
      .delete(deckSlides)
      .where(sql`${deckSlides.deckId} NOT IN (SELECT ${slideDecks.id} FROM ${slideDecks})`)
      .run();
    const audio = this.db
      .delete(deckAudio)
      .where(sql`${deckAudio.deckId} NOT IN (SELECT ${slideDecks.id} FROM ${slideDecks})`)
      .run();
    const videos = this.db
      .delete(deckVideos)
      .where(sql`${deckVideos.deckId} NOT IN (SELECT ${slideDecks.id} FROM ${slideDecks})`)
      .run();
    return Number(slides.changes) + Number(audio.changes) + Number(videos.changes);
  }

  /** Drops decks left mid-conversion by a crash — a crash skips before-quit,
   *  so this runs at startup instead. */
  deleteUnfinished(): void {
    const rows = this.db
      .select()
      .from(slideDecks)
      .where(sql`${slideDecks.status} IN ('pending','converting')`)
      .all();
    for (const row of rows) this.deleteDeck(row.id);
  }

  /**
   * Deletes every deck a build before 2026-11-03 drew to disk — a raster
   * (`webp`/`png`) with a folder: a PDF's pages, or a deck LibreOffice
   * converted — with that folder. Every such deck is read from its source on
   * its next open; a PDF's pages are drawn when asked for (cache dir `''`).
   * Run at startup, when nothing is on the projector. Returns how many went.
   */
  deleteRasterizedDecks(): number {
    const rows = this.sqlite
      .prepare(`SELECT id FROM slide_decks WHERE image_format IN ('webp', 'png') AND cache_dir <> ''`)
      .all() as { id: number }[];
    for (const row of rows) this.deleteDeck(row.id);
    return rows.length;
  }

  // -- path resolution (worship:// protocol) --------------------------------

  /**
   * The single hottest query in the app: every `<img>` in a slide strip, every
   * thumbnail in the deck transport and every slide the projector paints comes
   * through here. A strip of 400 slides used to be 800 queries — one
   * `getDeckById` plus one slide lookup each — with Drizzle rebuilding both
   * statements every time.
   *
   * One JOIN, prepared once and reused. `slideIndex` is 1-based and in
   * PRESENTATION order, which is what `deck_slides.slide_index` stores.
   */
  getSlideImage(deckId: number, slideIndex: number, variant: "full" | "thumb"): SlideImage | null {
    const row = this.slideImageStmt().get(deckId, slideIndex) as
      | {
          cacheDir: string;
          layers: string | null;
          imageFormat: string;
          renderWidth: number;
          sourcePath: string;
          sourceSizeBytes: number;
          sourceMtimeMs: number;
        }
      | undefined;
    if (!row) return null;
    // A model slide is no image at all: `SlideView` draws it (`getSlideModel`).
    if (row.imageFormat === "model") return null;
    // A native slide is built from its source for either variant
    // (`renderNativeSlide`), nothing on disk.
    if (row.layers !== null) {
      return {
        kind: "native",
        variant,
        sourcePath: row.sourcePath,
        sourceSizeBytes: row.sourceSizeBytes,
        sourceMtimeMs: row.sourceMtimeMs,
        layers: row.layers,
      };
    }
    // A PDF's page, drawn when asked for. A raster with a folder is what a
    // build before 2026-11-03 drew to disk, deleted at the next startup
    // (`deleteRasterizedDecks`): never served.
    if ((row.imageFormat === "webp" || row.imageFormat === "png") && row.cacheDir === "") {
      return {
        kind: "pdf",
        variant,
        page: slideIndex,
        sourcePath: row.sourcePath,
        sourceSizeBytes: row.sourceSizeBytes,
        sourceMtimeMs: row.sourceMtimeMs,
        renderWidth: row.renderWidth,
        imageFormat: row.imageFormat,
      };
    }
    return null;
  }

  /** A model deck's slide as `SlideModel` JSON, with the source it was read
   *  from — the protocol checks the file is still that one. */
  getSlideModel(deckId: number, slideIndex: number): { json: string; sourcePath: string; sourceSizeBytes: number; sourceMtimeMs: number } | null {
    const row = this.slideImageStmt().get(deckId, slideIndex) as
      | { layers: string | null; imageFormat: string; sourcePath: string; sourceSizeBytes: number; sourceMtimeMs: number }
      | undefined;
    if (!row || row.imageFormat !== "model" || row.layers === null) return null;
    return { json: row.layers, sourcePath: row.sourcePath, sourceSizeBytes: row.sourceSizeBytes, sourceMtimeMs: row.sourceMtimeMs };
  }

  /** The source a model deck reads its parts (pictures, fonts) from. */
  getDeckSource(deckId: number): { sourcePath: string; sourceSizeBytes: number; sourceMtimeMs: number } | null {
    const row = this.getDeckById(deckId);
    if (!row || row.imageFormat !== "model") return null;
    return { sourcePath: row.sourcePath, sourceSizeBytes: row.sourceSizeBytes, sourceMtimeMs: row.sourceMtimeMs };
  }

  getVideoPath(videoId: number): string | null {
    const row = this.videoPathStmt().get(videoId) as
      | { cacheDir: string; videoFile: string }
      | undefined;
    if (!row) return null;
    return path.join(row.cacheDir, "video", row.videoFile);
  }

  getAudioPath(audioId: number): string | null {
    const row = this.audioPathStmt().get(audioId) as
      | { cacheDir: string; audioFile: string }
      | undefined;
    if (!row) return null;
    return path.join(row.cacheDir, "audio", row.audioFile);
  }

  // -- DTO ------------------------------------------------------------------

  /** `linkedAudioPath` is resolved by the caller (`deck-service.ts`, via
   *  `MediaRepo`) — this repo only knows about `slide_decks`/`deck_audio`,
   *  never about `media_assets`. So is `engineClip`: whether the media engine
   *  plays a clip Chromium cannot (`media/deck-clips.ts`), which is decided
   *  every launch and never stored. */
  toDTO(
    deckRow: DeckRow,
    assetId: number,
    linkedAudioPath: string | null = null,
    engineClip: (kind: "audio" | "video", id: number) => boolean = () => false,
  ): DeckDTO {
    const slideRows = this.listSlides(deckRow.id);
    const audioRows = this.listAudio(deckRow.id);
    const audioUrl = (row: AudioRow) =>
      engineClip("audio", row.id) ? engineClipUrl("audio", row.id) : deckAudioUrl(row.id, row.audioFile);

    // The deck's music is the sound in the file that plays from the first
    // slide to the end, else a linked external file (an old hymnal's .mp3).
    // Every other playable sound plays on its own slides — a row written
    // before those were read (`scope` slide, no stop) on its own slide only.
    const playableRows = audioRows.filter((row) => row.playable === 1 || engineClip("audio", row.id));
    const embeddedTrack =
      playableRows.find((row) => row.scope === "deck" && (row.startSlideIndex ?? 1) === 1) ?? null;
    const sounds: DeckSound[] = playableRows
      .filter((row) => row !== embeddedTrack)
      .map((row) => {
        const start = row.startSlideIndex ?? 1;
        return {
          id: row.id,
          url: audioUrl(row),
          startSlideIndex: start,
          stopSlideIndex: row.stopSlideIndex ?? (row.scope === "slide" ? start : null),
          loop: row.loop === 1,
        };
      });

    const soundtrack: DeckDTO["soundtrack"] = embeddedTrack
      ? {
          url: audioUrl(embeddedTrack),
          durationMs: null,
          origin: embeddedTrack.origin,
          name: embeddedTrack.audioFile,
        }
      : linkedAudioPath
        ? {
            url: linkedAudioUrl(assetId),
            durationMs: null,
            origin: "linked",
            name: path.basename(linkedAudioPath),
          }
        : null;

    // One video per slide: `ProjectionOutput` sustains a single `slideVideo`,
    // so a slide that somehow carries two keeps the first and the second is
    // simply a still (its poster frame is already in the rasterized image).
    // Unplayable rows never reach the renderer at all — see `DeckSlideVideo`.
    const videos: DeckSlideVideo[] = [];
    const slidesWithVideo = new Set<number>();
    for (const row of this.listVideos(deckRow.id)) {
      const engine = engineClip("video", row.id);
      if ((row.playable !== 1 && !engine) || slidesWithVideo.has(row.slideIndex)) continue;
      // A video whose slide no longer exists, or whose page has no size on
      // record, has no box to be positioned inside. Dropped rather than given
      // a default: the poster frame in the rasterized slide is already right.
      const page = slideRows.find((slide) => slide.slideIndex === row.slideIndex);
      if (!page || page.widthPx <= 0 || page.heightPx <= 0) continue;
      slidesWithVideo.add(row.slideIndex);
      videos.push({
        slideIndex: row.slideIndex,
        url: engine ? engineClipUrl("video", row.id) : deckVideoUrl(row.id, row.videoFile),
        rect: { x: row.rectX, y: row.rectY, width: row.rectWidth, height: row.rectHeight },
        aspectRatio: page.widthPx / page.heightPx,
        loop: row.loop === 1,
        volume: row.volume === null ? null : row.volume / 100,
        name: row.videoFile,
      });
    }

    const slides: DeckSlide[] = slideRows.map((row) => ({
      index: row.slideIndex,
      url: slideUrl(deckRow.id, row.slideIndex),
      thumbUrl: slideThumbUrl(deckRow.id, row.slideIndex),
      modelUrl: deckRow.imageFormat === "model" ? slideModelUrl(deckRow.id, row.slideIndex) : null,
      advanceAfterMs: row.advanceMs,
      transition:
        isSlideTransitionStyle(row.transition) && row.transitionMs !== null && row.transitionMs > 0
          ? { style: row.transition, durationMs: row.transitionMs }
          : null,
    }));

    return {
      assetId,
      deckId: deckRow.id,
      status:
        deckRow.status === "ready" ? "ready" : deckRow.status === "error" ? "failed" : "converting",
      slideCount: deckRow.slideCount,
      slides,
      soundtrack,
      sounds,
      videos,
      autoAdvance: slides.some((slide) => slide.advanceAfterMs !== null),
      timingsSource: deckRow.timingsSource,
      sourceMtimeMs: deckRow.sourceMtimeMs,
      convertedAt: deckRow.updatedAt,
      error: deckRow.errorMessage,
    };
  }
}
