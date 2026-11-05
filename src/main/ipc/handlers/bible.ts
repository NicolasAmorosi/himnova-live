import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Handlers } from "../register";
import { getBibleRepo, getProgramsRepo, getSettingsRepo } from "../../services/repos";
import { seedBibleFromFile } from "../../db/seed/seed-bible";
import { bibleImportFilters } from "../../db/seed/bible-formats";
import { IpcError } from "@shared/ipc/result";
import { isBibleVersionName } from "@shared/types/bible";
import type { Db } from "../../db/client";
import type Database from "better-sqlite3";
import { showOpenDialogFor } from "../open-dialog";
import { mt } from "../../i18n";

let dbRef: { db: Db; sqlite: Database.Database } | null = null;
export function setBibleDb(db: Db, sqlite: Database.Database): void {
  dbRef = { db, sqlite };
}

export const bibleHandlers: Pick<
  Handlers,
  | "bible:versions"
  | "bible:books"
  | "bible:chapter"
  | "bible:search"
  | "bible:import"
  | "bible:rename"
  | "bible:delete"
  | "bible:usages"
  | "bible:reorder"
  | "bible:favorites"
  | "bible:setFavorite"
  | "bible:recents"
  | "bible:recordRecent"
> = {
  "bible:versions": () => getBibleRepo().listVersions(),
  "bible:books": ({ versionId }) => getBibleRepo().listBooks(versionId),
  "bible:chapter": ({ bookId, chapter }) => getBibleRepo().getChapter(bookId, chapter),
  "bible:search": ({ versionId, query, limit }) => getBibleRepo().search(versionId, query, limit),
  "bible:favorites": () => getBibleRepo().listFavorites(),
  "bible:setFavorite": ({ bookId, chapter, verse, favorite }) =>
    getBibleRepo().setFavorite(bookId, chapter, verse, favorite),
  "bible:recents": () => getBibleRepo().listRecents(),
  "bible:recordRecent": ({ bookId, chapter, verseFrom, verseTo }) =>
    getBibleRepo().recordRecent(bookId, chapter, verseFrom, verseTo),

  "bible:import": async (_req, ev) => {
    const result = await showOpenDialogFor(ev.sender, {
      properties: ["openFile"],
      filters: bibleImportFilters(),
    });
    if (result.canceled || result.filePaths.length === 0 || !dbRef) return null;

    const filePath = result.filePaths[0]!;
    const fallbackName = path.basename(filePath, path.extname(filePath));
    // Unlike the legacy import-bible, this NEVER writes into the app bundle —
    // the file is parsed in memory and only SQL rows land on disk, in userData.
    const code = `custom-${randomUUID().slice(0, 8)}`;
    const seeded = seedBibleFromFile(dbRef.db, dbRef.sqlite, filePath, { code, fallbackName });
    if (!seeded) return null;

    return getBibleRepo().getVersion(seeded.versionId);
  },

  "bible:rename": ({ id, name }) => {
    if (!isBibleVersionName(name)) {
      throw new IpcError({ code: "INVALID_BIBLE_VERSION_NAME", message: mt("bible.invalidName") });
    }
    const renamed = getBibleRepo().renameVersion(id, name.trim());
    if (!renamed) throw new IpcError({ code: "BIBLE_VERSION_NOT_FOUND", message: `Bible version ${id} not found` });
    return renamed;
  },

  /**
   * Removes a version, its books and its verses.
   *
   * `force` is informed consent and nothing else: the FK on
   * `program_items.bible_version_id` is `set null`, so unlike a time scene's
   * delete this one cannot fail and removes nothing from anybody's program —
   * it only costs those programs the version label under their verses. Main
   * still refuses without it, so the renderer cannot skip asking.
   *
   * Resetting `bible.defaultVersionId` is part of the same operation rather
   * than a follow-up write from the renderer: a dangling default would fall
   * back silently to "whichever comes first" and read, from the booth, exactly
   * like a setting that never saved.
   */
  "bible:delete": ({ id, force }) => {
    const usages = getProgramsRepo().findBibleVersionUsages(id);
    if (usages.length > 0 && !force) {
      throw new IpcError({
        code: "BIBLE_VERSION_IN_USE",
        message: `Bible version ${id} is still referenced by ${usages.length} program(s)`,
      });
    }
    getBibleRepo().deleteVersion(id);

    const settings = getSettingsRepo();
    if (settings.get("bible.defaultVersionId") === id) settings.setMany({ "bible.defaultVersionId": null });
  },

  "bible:usages": ({ id }) => getProgramsRepo().findBibleVersionUsages(id),

  "bible:reorder": ({ ids }) => getBibleRepo().reorderVersions(ids),
};
