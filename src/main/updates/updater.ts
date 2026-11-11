import { app, shell } from "electron";
// Default import, never `import { autoUpdater }`: main is ESM with its
// dependencies left outside the bundle, and electron-updater is CommonJS whose
// `autoUpdater` is a getter — the named import passes `typecheck` and throws
// «Named export 'autoUpdater' not found» when the app starts.
import electronUpdater, { type AppUpdater, type UpdateInfo } from "electron-updater";
import { canCheck, type UpdateStatus, type UpdateStep } from "@shared/types/updates";
import { broadcast } from "../services/broadcast";
import { getSettingsRepo } from "../services/repos";
import { releaseForUpdate } from "../windows/close-guard";
import { clearDownloadedDmg, downloadDmg, openDmg } from "./mac-dmg";
import { installerFile, loopbackFeedUrl, shouldCheckOnLaunch, statusForError } from "./update-status";

/**
 * The in-app update, owned by main.
 *
 * Nothing here reaches the projector, and the only thing that starts without
 * the operator asking is the launch check. Downloading waits for «Download»
 * (~200 MB, maybe mid-stream), and installing for «Restart and update» or
 * «When the app closes» — whose confirmation the control window has already
 * shown by the time `installUpdate` runs.
 *
 * The feed is the GitHub release marked Latest, the same one the landing
 * offers: `app-update.yml`, which electron-builder writes from `repository`.
 */
export const REPO_URL = "https://github.com/NicolasAmorosi/himnova-live";

/** Past the control window's first paint, like the other launch chores. */
const LAUNCH_CHECK_DELAY_MS = 10_000;
const PROGRESS_INTERVAL_MS = 250;
/** macOS without a Developer ID: the app opens the `.dmg` and the operator
 *  drags it over itself (`mac-dmg.ts`). */
const OPENS_DMG = process.platform === "darwin";

let updater: AppUpdater | null = null;
let status: UpdateStatus = { kind: "unsupported" };
/** The version on offer, once a check found one. */
let info: UpdateInfo | null = null;
let step: UpdateStep = "check";
let manualCheck = false;
let feedOverride: string | null = null;
/** macOS only: the verified `.dmg`, opened instead of Squirrel. */
let dmgPath: string | null = null;
let lastProgressAt = 0;

function setStatus(next: UpdateStatus): void {
  status = next;
  broadcast("update-status", next);
}

export function getUpdateStatus(): UpdateStatus {
  return status;
}

export function initUpdates(): void {
  if (process.platform === "darwin") clearDownloadedDmg();
  const candidate = electronUpdater.autoUpdater;
  candidate.autoDownload = false;
  // Off until the operator picks «When the app closes»: on, any quit after a
  // download would install in silence.
  candidate.autoInstallOnAppQuit = false;
  // The constructor turns it on for a `-beta` version, and then the GitHub
  // provider hunts a `beta.yml` that no release carries. Off, it reads the
  // release marked Latest — which is a beta, by our convention.
  candidate.allowPrerelease = false;
  feedOverride = loopbackFeedUrl(process.env.WORSHIP_UPDATE_FEED_URL);
  if (feedOverride) {
    candidate.setFeedURL({ provider: "generic", url: feedOverride });
    candidate.forceDevUpdateConfig = true;
  }
  // `npm run dev`, an AppImage started without `APPIMAGE`, a snap.
  if (!candidate.isUpdaterActive()) return;

  updater = candidate;
  status = { kind: "idle" };
  candidate.on("checking-for-update", () => setStatus({ kind: "checking" }));
  candidate.on("update-not-available", () => setStatus({ kind: "upToDate", checkedAt: Date.now() }));
  candidate.on("update-available", (next) => {
    info = next;
    setStatus({ kind: "available", version: next.version });
  });
  candidate.on("download-progress", (progress) => reportProgress(progress.percent, progress.transferred, progress.total));
  candidate.on("update-downloaded", () => downloaded());
  // electron-updater has already logged it to `main.log`.
  candidate.on("error", (error) => setStatus(statusForError(error, step, step !== "check" || manualCheck)));

  // «When the app closes». `quit` comes only once the close guard has let the
  // quit through, so a «Cancel» there installs nothing.
  app.once("quit", (_event, exitCode) => {
    if (exitCode === 0 && status.kind === "downloaded" && status.installOnQuit) launchInstaller(false);
  });

  setTimeout(() => {
    // Read now, not at launch: the operator may have just turned it off.
    if (shouldCheckOnLaunch(getSettingsRepo().get("updates.autoCheck"), process.argv)) checkForUpdates(false);
  }, LAUNCH_CHECK_DELAY_MS);
}

export function checkForUpdates(manual: boolean): void {
  if (!updater || !canCheck(status)) return;
  step = "check";
  manualCheck = manual;
  // A failure arrives by the `error` event.
  updater.checkForUpdates().catch(() => undefined);
}

export function downloadUpdate(): void {
  if (!updater || status.kind !== "available" || !info) return;
  step = "download";
  lastProgressAt = 0;
  setStatus({ kind: "downloading", version: info.version, percent: 0, transferred: 0, total: 0 });
  if (!OPENS_DMG) {
    updater.downloadUpdate().catch(() => undefined);
    return;
  }

  const dmg = installerFile(info.files, ".dmg");
  if (!dmg) {
    setStatus(statusForError({ code: "ERR_UPDATER_ASSET_NOT_FOUND" }, "download", true));
    return;
  }
  downloadDmg(fileUrl(info, dmg.url), dmg.sha512, dmg.size ?? 0, reportProgress)
    .then((file) => {
      dmgPath = file;
      downloaded();
    })
    .catch((error: unknown) => {
      console.error("[updates] download failed", error);
      setStatus(statusForError(error, "download", true));
    });
}

export function installUpdate(when: "now" | "onQuit"): void {
  if (status.kind !== "downloaded") return;
  if (when === "onQuit") {
    setStatus({ ...status, installOnQuit: true });
    return;
  }
  if (!launchInstaller(true)) return;
  // After the installer is running, never before: if it could not start, the
  // app stays open and the close guard still asks on the next quit.
  releaseForUpdate();
  app.quit();
}

export function openReleaseNotes(): Promise<void> {
  return shell.openExternal(info ? `${REPO_URL}/releases/tag/v${info.version}` : `${REPO_URL}/releases/latest`);
}

function downloaded(): void {
  if (info) setStatus({ kind: "downloaded", version: info.version, installOnQuit: false, opensInstaller: OPENS_DMG });
}

function reportProgress(percent: number, transferred: number, total: number): void {
  const now = Date.now();
  if (!info || (now - lastProgressAt < PROGRESS_INTERVAL_MS && percent < 100)) return;
  lastProgressAt = now;
  setStatus({ kind: "downloading", version: info.version, percent: Math.floor(percent), transferred, total });
}

/** Starts the installer, which on Windows and Linux kills this app within
 *  seconds. False when it could not start; the `error` event has said why. */
function launchInstaller(relaunch: boolean): boolean {
  step = "install";
  if (OPENS_DMG) {
    if (!dmgPath) return false;
    // electron-updater logs its own `Install:` line; this is the `.dmg`'s.
    console.info("[updates] opening the installer", dmgPath);
    openDmg(dmgPath);
    // Once: «Open installer» after «When the app closes» must not open it
    // again on the way out.
    dmgPath = null;
    return true;
  }
  return updater instanceof electronUpdater.BaseUpdater && updater.install(true, relaunch);
}

/** The installer next to the release's `latest*.yml`: the GitHub release's
 *  download folder, or the E2E suite's server. */
function fileUrl(update: UpdateInfo, name: string): string {
  const base = feedOverride ?? `${REPO_URL}/releases/download/${(update as UpdateInfo & { tag?: string }).tag}/`;
  return new URL(name, base.endsWith("/") ? base : `${base}/`).href;
}
