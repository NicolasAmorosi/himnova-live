import type Database from "better-sqlite3";
import type { Db } from "../db/client";
import { SettingsRepo } from "../db/repositories/settings.repo";
import { MediaRepo } from "../db/repositories/media.repo";
import { BibleRepo } from "../db/repositories/bible.repo";
import { ProgramsRepo } from "../db/repositories/programs.repo";
import { HistoryRepo } from "../db/repositories/history.repo";
import { SlidesRepo } from "../db/repositories/slides.repo";
import { DraftRepo } from "../db/repositories/draft.repo";
import { UtilityRepo } from "../db/repositories/utility.repo";
import { OverlaysRepo } from "../db/repositories/overlays.repo";
import { ConversionsRepo } from "../db/repositories/conversions.repo";
import { SongsRepo } from "../db/repositories/songs.repo";

/**
 * Small process-wide registry so modules that can't easily receive constructor
 * injection (the worship:// protocol handler, registered once before any
 * window exists) can still reach the same repository instances the IPC
 * handlers use. Populated once in main/index.ts right after the DB opens.
 */
let settingsRepo: SettingsRepo | null = null;
let mediaRepo: MediaRepo | null = null;
let bibleRepo: BibleRepo | null = null;
let programsRepo: ProgramsRepo | null = null;
let historyRepo: HistoryRepo | null = null;
let slidesRepo: SlidesRepo | null = null;
let draftRepo: DraftRepo | null = null;
let utilityRepo: UtilityRepo | null = null;
let overlaysRepo: OverlaysRepo | null = null;
let conversionsRepo: ConversionsRepo | null = null;
let songsRepo: SongsRepo | null = null;
let dbHandle: { db: Db; sqlite: Database.Database } | null = null;

export function initRepos(db: Db, sqlite: Database.Database): void {
  settingsRepo = new SettingsRepo(db);
  mediaRepo = new MediaRepo(db, sqlite);
  bibleRepo = new BibleRepo(db, sqlite);
  programsRepo = new ProgramsRepo(db, sqlite);
  historyRepo = new HistoryRepo(db);
  slidesRepo = new SlidesRepo(db, sqlite);
  draftRepo = new DraftRepo(db);
  utilityRepo = new UtilityRepo(db, sqlite);
  overlaysRepo = new OverlaysRepo(db, sqlite);
  conversionsRepo = new ConversionsRepo(db, sqlite);
  songsRepo = new SongsRepo(db, sqlite);
  dbHandle = { db, sqlite };
}

export const getDbHandle = () => assertInit(dbHandle, "Database");
/** False once `closeDatabase()` ran — late work on the way out checks it instead of throwing. */
export const isDatabaseOpen = () => dbHandle !== null;

/**
 * Closes the database on the way out, from `will-quit`.
 *
 * `close()` on the last connection already checkpoints, but the explicit
 * TRUNCATE is what actually empties `worship.db-wal` instead of leaving it to
 * grow across sessions — and a fat, un-checkpointed WAL is exactly the state
 * that used to make `backupBeforeMigrate`'s snapshot incomplete.
 *
 * Synchronous, because nothing else survives there
 * (`.claude/knowledge/nothing-asynchronous-survives-before-quit.md`), and
 * never throws: a failure here must not keep the process from exiting.
 */
export function closeDatabase(): void {
  const handle = dbHandle;
  if (!handle) return;
  // Cleared first, so a second call is a no-op rather than a double close.
  dbHandle = null;
  try {
    handle.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    handle.sqlite.close();
  } catch (error) {
    console.warn("[db] close failed", error);
  }
}

function assertInit<T>(value: T | null, name: string): T {
  if (!value) throw new Error(`${name} accessed before initRepos() ran`);
  return value;
}

export const getSettingsRepo = () => assertInit(settingsRepo, "SettingsRepo");
export const getMediaRepo = () => assertInit(mediaRepo, "MediaRepo");
export const getBibleRepo = () => assertInit(bibleRepo, "BibleRepo");
export const getProgramsRepo = () => assertInit(programsRepo, "ProgramsRepo");
export const getHistoryRepo = () => assertInit(historyRepo, "HistoryRepo");
export const getSlidesRepo = () => assertInit(slidesRepo, "SlidesRepo");
export const getDraftRepo = () => assertInit(draftRepo, "DraftRepo");
export const getUtilityRepo = () => assertInit(utilityRepo, "UtilityRepo");
export const getOverlaysRepo = () => assertInit(overlaysRepo, "OverlaysRepo");
export const getConversionsRepo = () => assertInit(conversionsRepo, "ConversionsRepo");
export const getSongsRepo = () => assertInit(songsRepo, "SongsRepo");
