import { IpcError } from "@shared/ipc/result";
import type { SongImportResult } from "@shared/types/song";
import { mt } from "../i18n";
import { findEasyWorshipData, readEasyWorship, songIdentity } from "../songs/easyworship";
import { getDbHandle, getSettingsRepo, getSongsRepo } from "./repos";

/**
 * Imports EasyWorship's songs from `folder` (its `Databases/Data`, or a
 * folder above it). A song already in the library — same title, same words —
 * is skipped and counted, and so is a second copy inside the same database;
 * one with the same title and other words comes in as a song of its own
 * (owner, 2026-11-04: it may be another version). One transaction: a database
 * that fails halfway leaves the library as it was.
 */
export function importEasyWorshipFolder(folder: string): SongImportResult {
  const data = findEasyWorshipData(folder);
  if (!data) throw new IpcError({ code: "EW_NOT_FOUND", message: mt("songs.ewNotFound") });
  let read: ReturnType<typeof readEasyWorship>;
  try {
    read = readEasyWorship(data, getSettingsRepo().get("ui.locale"));
  } catch (error) {
    console.warn("[songs] EasyWorship database unreadable", error);
    throw new IpcError({ code: "EW_UNREADABLE", message: mt("songs.ewUnreadable") });
  }
  const repo = getSongsRepo();
  const known = new Set(repo.list().map(songIdentity));
  let imported = 0;
  let repeated = 0;
  getDbHandle().sqlite.transaction(() => {
    for (const song of read.songs) {
      const identity = songIdentity(song);
      if (known.has(identity)) {
        repeated += 1;
        continue;
      }
      known.add(identity);
      repo.create(song);
      imported += 1;
    }
  })();
  return { imported, repeated, problems: read.problems };
}
