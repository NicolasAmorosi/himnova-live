import fs from "node:fs";
import type { SettingsRepo } from "../db/repositories/settings.repo";

type LegacySettings = { logoPath?: string | null };
type LegacyMediaLibrary = {
  videos?: { path: string }[];
  images?: { path: string }[];
  audios?: { path: string }[];
};

/**
 * One-shot import of the pre-migration `settings.json` (docs/knowledge/
 * 05-data-and-persistence.md in the legacy app) into SQLite. One key out of
 * a tiny file, so it stays on the startup path — the settings have to be
 * right before the first window reads them.
 *
 * Renames the source to `*.migrated` afterwards so this never runs twice and
 * the original stays around as a safety net.
 *
 * The file (`paths.ts`' `legacySettingsPath`) and, below, the importer are
 * passed in so that nothing here imports `electron`: tested in
 * `tests/main/migrate-legacy-data.test.ts`.
 */
export function migrateLegacySettingsIfPresent(settingsRepo: Pick<SettingsRepo, "setMany">, legacySettingsPath: string): void {
  if (!fs.existsSync(legacySettingsPath)) return;
  try {
    const legacy = JSON.parse(fs.readFileSync(legacySettingsPath, "utf-8")) as LegacySettings;
    // Only the logo: the legacy file's `lastFolder` has nowhere to land any
    // more, now that the picker opens a folder chosen per kind instead of
    // wherever the previous pick ended (`ipc/handlers/files.ts`).
    settingsRepo.setMany({ "logo.path": legacy.logoPath ?? null });
    fs.renameSync(legacySettingsPath, `${legacySettingsPath}.migrated`);
  } catch {
    // A corrupt legacy file shouldn't block startup; the app just starts with defaults.
  }
}

/**
 * The other half: `media_library.json`.
 *
 * Deferred and asynchronous, unlike the settings. It used to run on the
 * startup path as a `statSync`-and-insert loop, one file at a time, outside
 * any transaction — a legacy library of a few hundred entries was that many
 * synchronous stats and writes before the window existed. `importPaths` is
 * the same operation the app already uses for a folder full of files:
 * `CHUNK_SIZE` transactions with an event-loop yield between them, parallel
 * stats inside each, and it emits `library-changed` so a window that is
 * already open picks the rows up.
 *
 * The rename happens only after the import resolves: interrupted halfway, the
 * file is still there and the next launch redoes it — and the import is an
 * upsert, so redoing it costs nothing.
 */
export async function migrateLegacyMediaIfPresent(
  legacyMediaLibraryPath: string,
  /** `library-import.ts`' `importPaths`. */
  importPaths: (paths: string[], kind: "video" | "image" | "audio", opts: { inLibrary: boolean }) => Promise<unknown>,
): Promise<void> {
  if (!fs.existsSync(legacyMediaLibraryPath)) return;

  let legacy: LegacyMediaLibrary;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyMediaLibraryPath, "utf-8")) as LegacyMediaLibrary;
  } catch {
    // Unparseable: rename it out of the way rather than retrying every launch.
    try {
      fs.renameSync(legacyMediaLibraryPath, `${legacyMediaLibraryPath}.migrated`);
    } catch {
      /* best effort */
    }
    return;
  }

  const kinds: [keyof LegacyMediaLibrary, "video" | "image" | "audio"][] = [
    ["videos", "video"],
    ["images", "image"],
    ["audios", "audio"],
  ];

  try {
    for (const [key, kind] of kinds) {
      const paths = (legacy[key] ?? []).map((entry) => entry.path);
      // A path that no longer exists is dropped by `importPaths`' own stat,
      // so there is no `existsSync` pre-pass to pay for here.
      if (paths.length > 0) await importPaths(paths, kind, { inLibrary: true });
    }
    fs.renameSync(legacyMediaLibraryPath, `${legacyMediaLibraryPath}.migrated`);
  } catch (error) {
    console.warn("[legacy] media library migration failed", error);
  }
}
