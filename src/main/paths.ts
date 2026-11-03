import { app } from "electron";
import path from "node:path";
import type { AssetKind } from "@shared/constants";

/**
 * Single place that resolves every "where does X live" question so dev vs.
 * packaged never leaks into the rest of the main process. See package.json's
 * `build.extraResources` for how `migrations/` and `bibles/` land next to the
 * packaged app.
 */
const resourcesRoot = app.isPackaged ? process.resourcesPath : app.getAppPath();

export const migrationsDir = app.isPackaged
  ? path.join(resourcesRoot, "migrations")
  : path.join(app.getAppPath(), "drizzle");

export const biblesDir = app.isPackaged
  ? path.join(resourcesRoot, "bibles")
  : path.join(app.getAppPath(), "resources/bibles");

/** What the `.pptx` reader draws with: ECMA-376's preset shape definitions
 *  and PowerPoint's built-in table styles (`src/main/slides/pptx/`). */
export const ooxmlDir = app.isPackaged
  ? path.join(resourcesRoot, "ooxml")
  : path.join(app.getAppPath(), "resources/ooxml");

/** FFmpeg + ffprobe, fetched per platform by `scripts/fetch-binaries.ts` into
 *  `resources/ffmpeg/<platform>-<arch>/` and shipped as `resources/ffmpeg/`. */
const ffmpegDir = app.isPackaged
  ? path.join(resourcesRoot, "ffmpeg")
  : path.join(app.getAppPath(), "resources/ffmpeg", `${process.platform}-${process.arch}`);
const exe = process.platform === "win32" ? ".exe" : "";
export const ffmpegPath = path.join(ffmpegDir, `ffmpeg${exe}`);
export const ffprobePath = path.join(ffmpegDir, `ffprobe${exe}`);

/** The media engine (`native/`): fetched per platform by `scripts/fetch-binaries.ts` (or built by
 *  `native/build.sh`) into `resources/engine/<platform>-<arch>/` and shipped as `resources/engine/`,
 *  next to its libmpv where the app carries one. */
export const engineDir = app.isPackaged
  ? path.join(resourcesRoot, "engine")
  : path.join(app.getAppPath(), "resources/engine", `${process.platform}-${process.arch}`);
export const enginePath = path.join(engineDir, `media-engine${exe}`);

export const userDataDir = app.getPath("userData");
export const dbPath = path.join(userDataDir, "worship.db");
export const dbBackupDir = path.join(userDataDir, "backups");
export const legacySettingsPath = path.join(userDataDir, "settings.json");
export const legacyMediaLibraryPath = path.join(userDataDir, "media_library.json");

/** Persistent, content-addressed cache of converted PowerPoint/Impress decks
 *  (rasterized slide images + extracted audio) — see src/main/slides/. Never
 *  os.tmpdir(): that's what the COM-era exporter used and why its cache was
 *  lost on every restart. */
export const slidesCacheDir = path.join(userDataDir, "slides-cache");
/** PDFs being rasterized land here first; only fs.renameSync'd into their
 *  final deckCacheDir() once every file is written. Swept clean on startup. */
export const slidesTempDir = path.join(slidesCacheDir, ".tmp");

/** Generated library thumbnails (images and video first frames). Sharded one
 *  level by the first two characters of the key, because a church's media
 *  folder can easily hold thousands of files and some filesystems get slow
 *  listing a single directory that size. Purely derived data: deleting it
 *  costs nothing but a regeneration. */
export const thumbCacheDir = path.join(userDataDir, "thumb-cache");

/** Where builds before step 1.4 of the engine plan kept the playable copies of
 *  the videos and audios Chromium cannot decode. Deleted at startup
 *  (`main/media/engine-assets.ts`): the media engine plays those files now. */
export const convertedMediaDir = path.join(userDataDir, "converted-media");

export function thumbCachePath(key: string): string {
  return path.join(thumbCacheDir, key.slice(0, 2), `${key}.jpg`);
}

export function deckCacheDir(contentHash: string, renderWidth: number, imageFormat: string): string {
  return path.join(slidesCacheDir, `${contentHash.slice(0, 16)}-${renderWidth}-${imageFormat}`);
}

/** Only `ppt` has no folder of its own on any platform: a presentation is a
 *  document, and Documents is where every office suite already saves one. */
const SYSTEM_FOLDER_BY_KIND: Record<AssetKind, "music" | "videos" | "pictures" | "documents"> = {
  audio: "music",
  video: "videos",
  image: "pictures",
  ppt: "documents",
};

/**
 * The operating system's own folder for one kind of asset — Music, Movies/
 * Videos, Pictures and Documents.
 *
 * `app.getPath` goes through the platform API (`SHGetKnownFolderPath` on
 * Windows, `NSSearchPathForDirectoriesInDomains` on macOS, `xdg-user-dir` on
 * Linux), so the answer is right regardless of the language the machine is
 * installed in and of where the user moved their home directory — which is
 * exactly why these are resolved on every pick instead of being written into
 * the settings table once.
 *
 * Electron throws rather than returning a fallback when a name cannot be
 * resolved (a Linux box with no `xdg-user-dirs` installed is the real case),
 * so every lookup falls back to the home directory: a file dialog that opens
 * *somewhere* beats one that fails to open.
 */
export function systemMediaFolder(kind: AssetKind): string {
  try {
    return app.getPath(SYSTEM_FOLDER_BY_KIND[kind]);
  } catch {
    return app.getPath("home");
  }
}
