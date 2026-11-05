import { app, BrowserWindow, dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import { registerWorshipScheme, registerWorshipProtocolHandler } from "./protocol/worship-protocol";
import { openDatabase } from "./db/client";
import { backupBeforeMigrate, runMigrations } from "./db/migrate";
import { seedBuiltinBibles } from "./db/seed/seed-bible";
import { seedUtilityScenes } from "./db/seed/seed-utility-scenes";
import { seedSongThemes } from "./db/seed/seed-song-themes";
import {
  initRepos,
  getSongsRepo,
  closeDatabase,
  getHistoryRepo,
  getMediaRepo,
  getSettingsRepo,
  getUtilityRepo,
} from "./services/repos";
import {
  migrateLegacySettingsIfPresent,
  migrateLegacyMediaIfPresent,
} from "./services/migrate-legacy-data";
import { setBibleDb } from "./ipc/handlers/bible";
import { registerAllIpcHandlers } from "./ipc";
import { createControlWindow } from "./windows/control-window";
import { installNavigationGuards } from "./windows/navigation-guards";
import { installApplicationMenu } from "./windows/app-menu";
import { holdQuitUntilAnswered, installCloseGuard } from "./windows/close-guard";
import { watchDisplays } from "./windows/projector-screen";
import { closeStageWindow, syncStageWindow } from "./windows/stage-window";
import { projectionState } from "./services/projection-state";
import {
  dbBackupDir,
  dbPath,
  biblesDir,
  legacyMediaLibraryPath,
  legacySettingsPath,
  migrationsDir,
  userDataDir,
} from "./paths";
import { mt, setMainLocale } from "./i18n";
import { systemLocale } from "./i18n/system-locale";
import { initSlidesSubsystem, shutdownSlides } from "./slides/deck-service";
import { cancelAllPrewarmBatches } from "./services/prewarm-service";
import { isRasterizerWindow } from "./slides/rasterizer";
import { startLibrarySweepScheduler } from "./services/library-sweeper";
import { pruneThumbCache } from "./media/thumbnail-service";
import { backfillContentHashes } from "./media/content-hash";
import { initEngineAssets, shutdownEngineAssets } from "./media/engine-assets";
import { engineAvailable, killAllEngines, prewarmEngine } from "./media/media-engine";
import { stopDeckClips } from "./media/deck-clips";
import { appendLogLine, installMainLog } from "./logging";
import { initUpdates } from "./updates/updater";

/** Long enough to be safely past the first paint of the control window — the
 *  prune walks a directory and is worth nothing compared to the app being on
 *  screen. */
const THUMB_PRUNE_DELAY_MS = 10_000;

/** Shorter than the thumbnail prune: this one changes what the library grid
 *  SHOWS (a tile's badge and its first-slide thumbnail), so the operator
 *  should not have to wait ten seconds to see the truth — but still long
 *  enough to be past the control window's first paint. */
const CONTENT_HASH_BACKFILL_DELAY_MS = 2_000;

// First of all, so nothing main says is lost on a machine with no console.
installMainLog(path.join(userDataDir, "main.log"));

// Must run before app.whenReady().
registerWorshipScheme();

// Every window this app will ever create — control, projection, and the
// offscreen rasterizer — hardened from one place, before any of them exists.
// Registering it per-window instead would mean remembering to do it in the
// next `new BrowserWindow`, which is exactly the kind of thing that gets
// forgotten. See `windows/navigation-guards.ts` for what it stops.
app.on("web-contents-created", (_event, contents) => installNavigationGuards(contents));

// Two instances writing the same SQLite file (and fighting over which one
// owns the projection window) is a real scenario — a user double-clicking
// the app icon, or a stray process left over from a crash. Refuse the
// second launch and focus the first instance's window instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function initDatabase(): void {
  // Asked before `openDatabase` creates the file. A profile holding the legacy
  // app's data is not new either: that church has always run in Spanish.
  const isNewProfile = ![dbPath, legacySettingsPath, legacyMediaLibraryPath].some((file) => fs.existsSync(file));
  // Until the settings can be read, main speaks the OS's language — the
  // migration-failure dialog below is said before they can.
  setMainLocale(systemLocale());

  // Kept and reported rather than assumed: the error box below used to promise
  // a backup unconditionally, which on the one morning it matters sends the
  // operator looking for a file that may not be there.
  const backup = backupBeforeMigrate(dbPath, dbBackupDir, migrationsDir);
  if (backup.status === "failed") console.warn("[db] pre-migration backup failed:", backup.reason);

  const { sqlite, db } = openDatabase(dbPath);

  try {
    runMigrations(db, migrationsDir);
  } catch (error) {
    dialog.showErrorBox(
      mt("dialogs.dbErrorTitle"),
      [
        mt("dialogs.dbErrorMigrations"),
        backup.status === "ok"
          ? mt("dialogs.dbErrorBackup", { path: backup.path })
          : mt("dialogs.dbErrorNoBackup"),
        String(error),
      ].join("\n\n"),
    );
    // Explained already: `reportCrash` still logs it, without a second dialog.
    crashDialogShown = true;
    throw error;
  }

  initRepos(db, sqlite);
  // A new install starts in the OS's language; every other one keeps its own,
  // which is Spanish unless the operator changed it. Before the seeds: the
  // example time scenes are written in it.
  if (isNewProfile) getSettingsRepo().setMany({ "ui.locale": systemLocale() });
  setMainLocale(getSettingsRepo().get("ui.locale"));
  setBibleDb(db, sqlite);
  // After `initRepos` now, and for the same reason the utility seed below is:
  // it reads `bible.builtinSeeded`, which is what keeps a deleted RV1909
  // deleted across launches. See `seedBuiltinBibles`.
  seedBuiltinBibles(db, sqlite, biblesDir, getSettingsRepo());
  migrateLegacySettingsIfPresent(getSettingsRepo());
  // After `initRepos`, unlike the Bible seed above: this one needs two
  // repositories rather than a raw handle, and the flag it reads lives in
  // `settings`.
  seedUtilityScenes(getUtilityRepo(), getSettingsRepo());
  // After the legacy settings: the theme copies the verse's style.
  seedSongThemes(getSongsRepo(), getSettingsRepo());
}

function wireMinimizeRestoreSync(controlWindow: BrowserWindow): void {
  // The projection window loses `alwaysOnTop` on some platforms when the OS
  // minimizes/restores its owning process — reasserted here on restore.
  controlWindow.on("minimize", () => projectionState.getWindow()?.minimize());
  controlWindow.on("restore", () => {
    const win = projectionState.getWindow();
    if (!win) return;
    win.restore();
    win.setAlwaysOnTop(true, "screen-saver");
  });
  controlWindow.on("closed", () => {
    projectionState.getWindow()?.close();
    closeStageWindow();
  });
}

/** Every window the operator can actually see — i.e. not the offscreen
 *  rasterizer, which is a real `BrowserWindow` and would otherwise make the
 *  app look "still open" for the 60s its idle timer keeps it alive after a
 *  conversion. */
function userFacingWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((win) => !isRasterizerWindow(win));
}

/** Creates the control window and wires everything that must follow it.
 *
 *  A single entry point on purpose: `app.on("activate")` used to call
 *  `createControlWindow()` directly, which quietly skipped
 *  `wireMinimizeRestoreSync` — so after closing and reopening the app on
 *  macOS, minimizing no longer took the projection down with it and closing
 *  the control window left the projector on screen. */
function openControlWindow(): BrowserWindow {
  const win = createControlWindow();
  wireMinimizeRestoreSync(win);
  syncStageWindow();
  // Vetoes the first close and asks the control window instead — the unsaved
  // schedule is the renderer's to speak for. See `close-guard.ts`.
  installCloseGuard(win);
  win.on("closed", () => {
    // `window-all-closed` only fires when NO window is left, rasterizer
    // included — so on Windows/Linux a recent conversion could leave the app
    // running with no visible window at all. The control window IS the app
    // there: it closing means quitting, unconditionally. Counting the windows
    // still open did not work — the projector's own `close()` is asynchronous
    // and still counted, so the process stayed alive with nothing on screen
    // and kept the single-instance lock, and the next double-click on the
    // icon found no window to bring forward.
    if (process.platform !== "darwin") app.quit();
  });
  return win;
}

let mainControlWindow: BrowserWindow | null = null;

app.on("second-instance", () => {
  // A destroyed window throws on every call, which is what turned a second
  // launch into the «Unexpected error» dialog with no window behind it.
  if (!mainControlWindow || mainControlWindow.isDestroyed()) {
    if (app.isReady()) mainControlWindow = openControlWindow();
    return;
  }
  if (mainControlWindow.isMinimized()) mainControlWindow.restore();
  mainControlWindow.focus();
});

if (gotSingleInstanceLock) {
  void app.whenReady().then(() => {
    try {
      initDatabase();
    } catch (error) {
      // A migration failure has already explained itself (`initDatabase`).
      // Anything else — a locked or corrupt `worship.db`, a backup that
      // cannot be pruned — used to quit with no dialog and nothing in
      // `crash.log`: the app simply never opened, on the one launch (the first
      // after an update) when a pending migration makes that most likely.
      reportCrash("startup", error);
      app.quit();
      return;
    }

    registerWorshipProtocolHandler(getMediaRepo());
    registerAllIpcHandlers();
    watchDisplays();
    // Before the first window: the default menu's Cmd+W (which closes the
    // PROJECTOR) and Cmd+R must never be reachable, not even for one frame.
    installApplicationMenu();

    // Non-blocking: creates the cache dirs and sweeps anything a crash left
    // half-written, and what older builds left behind. A failure here must
    // never keep the app from starting. It yields an event-loop
    // turn before its first synchronous filesystem work — `void` alone only
    // defers from the first `await`, which used to be after the whole sweep.
    void initSlidesSubsystem().catch((error: unknown) => {
      console.warn("[slides] init failed", error);
    });
    startLibrarySweepScheduler();
    // Deletes the old converted copies only. Deciding what the engine plays waits for the control
    // window to report what this machine decodes (`engine:reportDecoders`).
    initEngineAssets();
    // A media engine started ahead of time, so the first video it plays does not pay for the
    // process (150–650 ms).
    if (engineAvailable()) prewarmEngine();

    // The other half of the legacy import (`media_library.json`). Off the
    // startup path: it is a whole library's worth of files, and the rows it
    // creates reach an open window through `library-changed`.
    void migrateLegacyMediaIfPresent().catch((error: unknown) => {
      console.warn("[legacy] media migration failed", error);
    });

    // Teaches main which cached deck each presentation's BYTES belong to, so
    // "is this converted?" can be answered by content instead of by which
    // asset happens to own the deck row (`N3` in the media-chain audit §5.2).
    // Deferred like every other launch chore: it is a few seconds of
    // background reads and must never stand between the operator and a window.
    setTimeout(() => {
      void backfillContentHashes().catch((error: unknown) => {
        console.warn("[media] content-hash backfill failed", error);
      });
    }, CONTENT_HASH_BACKFILL_DELAY_MS);

    // Collects thumbnails orphaned by an edited/replaced source file — their
    // cache key includes size+mtime, so nothing else ever removes them.
    // Deferred and best-effort: it is pure housekeeping and must never delay
    // the control window appearing.
    setTimeout(() => {
      void pruneThumbCache().catch((error: unknown) => {
        console.warn("[thumbs] prune failed", error);
      });
      // Same deal for the projection history: it grows by one row per change
      // of output and its `prune()` — which documents itself as "called once
      // at startup" — had no caller at all, so `MAX_ROWS` was never enforced.
      try {
        getHistoryRepo().prune();
      } catch (error) {
        console.warn("[history] prune failed", error);
      }
    }, THUMB_PRUNE_DELAY_MS);

    mainControlWindow = openControlWindow();
    // After the window, like every launch chore: the check itself waits ten
    // more seconds, and a failed one only reaches `main.log`.
    initUpdates();

    app.on("activate", () => {
      // Counts only windows the user can actually see: the rasterizer is a
      // real (hidden) BrowserWindow, so `getAllWindows()` stays non-empty for
      // up to 60s after any conversion — during which a dock click used to
      // reopen nothing at all.
      if (userFacingWindows().length === 0) mainControlWindow = openControlWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Cancels in-flight jobs and closes the rasterizer. The deck cache is
// deliberately NOT deleted — persisting it is the point of the pipeline.
app.on("before-quit", (event) => {
  // Held until the control window answers. No window closes and nothing shuts
  // down before that: an operator who cancels must keep the projector and a
  // working slides pipeline. See `holdQuitUntilAnswered`.
  if (holdQuitUntilAnswered(event)) return;
  cancelAllPrewarmBatches();
  shutdownSlides();
  stopDeckClips();
  shutdownEngineAssets();
  killAllEngines();
});

// `will-quit`, not `before-quit`, for two reasons. It runs after every window
// is gone, so no in-flight `projection:show` can reach `HistoryRepo.record()`
// on a connection that was just closed — and more importantly, `before-quit`
// now fires while the close guard may still be ASKING the operator, who is
// free to answer "cancel": closing the database there would leave a perfectly
// alive app with no database. Synchronous by necessity either way — see
// `.claude/knowledge/nothing-asynchronous-survives-before-quit.md`.
//
// Reaching it at all depends on the close guard resuming the quit with
// `app.quit()` rather than `win.close()`: vetoing a window's close during a
// quit cancels the quit outright, and `will-quit` never comes. See
// `windows/close-guard.ts`.
app.on("will-quit", () => {
  closeDatabase();
});

/** At most one crash dialog per run. `showErrorBox` is modal and blocking, so
 *  a repeating fault (a listener that throws on every event, say) turned the
 *  "health check" into a wall of dialogs the operator could not get past —
 *  during a service. Everything after the first still reaches `crash.log`. */
let crashDialogShown = false;

function reportCrash(label: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  appendLogLine(path.join(userDataDir, "crash.log"), label, detail);
  if (crashDialogShown) {
    console.error(`[${label}]`, error);
    return;
  }
  crashDialogShown = true;
  dialog.showErrorBox(mt("dialogs.crashTitle"), detail);
}

// Surface crashes as a dialog instead of a silent blank window — the health
// check the design doc calls for around the native SQLite module.
//
// Registering this handler also overrides Node's default of ABORTING the
// process, and that is the intended trade: a service with the app in a
// questionable state beats a service with no app at all, and the operator
// gets a dialog either way. The cost is real and is accepted here — after an
// uncaught throw, main's state may be inconsistent (a half-applied
// transaction, a queue entry that will never settle), so the honest advice to
// an operator who sees this dialog is to restart once the service is over.
process.on("uncaughtException", (error) => reportCrash("uncaughtException", error));

// Without this an unhandled rejection is a silent no-op (Electron does not
// abort on one), so the whole `void somethingAsync()` style used across main
// could fail invisibly.
process.on("unhandledRejection", (reason) => reportCrash("unhandledRejection", reason));

// A renderer that dies says so only on a console a packaged app doesn't have
// («Renderer process crashed»), so a control window or projector gone blank
// mid-service left nothing to read afterwards. No dialog: the operator already
// sees it. The rasterizer handles its own (`slides/rasterizer.ts`).
app.on("render-process-gone", (_event, contents, details) => {
  const win = BrowserWindow.fromWebContents(contents);
  if (win && isRasterizerWindow(win)) return;
  appendLogLine(path.join(userDataDir, "crash.log"), "render-process-gone", `${contents.getURL()} ${JSON.stringify(details)}`);
});
