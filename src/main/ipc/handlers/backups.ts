import { spawn } from "node:child_process";
import fs from "node:fs";
import { app, shell } from "electron";
import { IpcError } from "@shared/ipc/result";
import type { Handlers } from "../register";
import { dbBackupDir, dbPath, migrationsDir } from "../../paths";
import {
  backupEntries,
  dailyBackupDir,
  describeBackup,
  stagedRestorePath,
  takeLaunchRestore,
} from "../../db/backups";
import { runBackupJob } from "../../db/backup-thread";
import { journalNewest } from "../../db/migrate";
import { releaseForUpdate } from "../../windows/close-guard";
import { showOpenDialogFor } from "../open-dialog";
import { mt } from "../../i18n";

export const backupsHandlers: Pick<
  Handlers,
  | "backups:list"
  | "backups:create"
  | "backups:pick"
  | "backups:restore"
  | "backups:openFolder"
  | "backups:launchRestore"
> = {
  "backups:list": () => backupEntries(dbBackupDir),

  "backups:create": async () => {
    const dir = dailyBackupDir(dbBackupDir);
    const reply = await runBackupJob({ op: "snapshot", dbPath, dir, keep: 7 });
    const result = "snapshot" in reply ? reply.snapshot : null;
    const entry = result?.status === "ok" ? describeBackup(result.path, "daily") : null;
    if (!entry) {
      if (result?.status === "failed") console.warn("[backups] copy failed:", result.reason);
      throw new IpcError({ code: "BACKUP_FAILED", message: mt("backups.failed") });
    }
    return entry;
  },

  "backups:pick": async (_req, ev) => {
    const result = await showOpenDialogFor(ev.sender, {
      properties: ["openFile"],
      filters: [{ name: "Himnova Live", extensions: ["db"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return describeBackup(result.filePaths[0]!, "file");
  },

  "backups:restore": async ({ path }) => {
    const reply = await runBackupJob({
      op: "stage",
      source: path,
      staged: stagedRestorePath(dbBackupDir),
      newestMigration: journalNewest(migrationsDir),
    });
    const refused = "refused" in reply ? reply.refused : "unreadable";
    if (refused) throw new IpcError({ code: "BACKUP_REFUSED", message: mt(`backups.${refused}`) });
    // The control window already asked what a quit puts at risk (`quitRisks`): asked again here, a
    // «Cancel» would leave the copy staged for whatever launch came next.
    releaseForUpdate();
    const appImage = process.env["APPIMAGE"];
    if (appImage) startAfterExit(appImage, process.argv.slice(1));
    else app.relaunch();
    app.quit();
  },

  "backups:openFolder": async () => {
    fs.mkdirSync(dbBackupDir, { recursive: true });
    // `openPath` resolves to an error MESSAGE rather than rejecting.
    const failure = await shell.openPath(dbBackupDir);
    if (failure) throw new IpcError({ code: "OPEN_FAILED", message: failure });
  },

  "backups:launchRestore": () => takeLaunchRestore(),
};

/**
 * Starts `file` again once this process is gone. For an AppImage, whose binary runs from a mount that goes away
 * with this process: `app.relaunch()` with `execPath` set to the AppImage never brought it back (measured on the
 * Linux PC, 2026-11-13; the unpacked binary the `.deb` installs relaunched in 1.7 s). Electron's relaunch helper
 * is this same binary, from that same mount. A shell outside it waits for this PID to end, which also frees the
 * single-instance lock, and then runs the AppImage file itself. It first closes every descriptor it inherited but
 * the standard three: the next instance got them all, the old mount stayed alive through them, and with
 * `--remote-debugging-port` the old listening socket took the new instance's port. Bash for the multi-digit
 * descriptors (dash's `exec` only takes one digit); without it, the same wait with nothing closed.
 */
function startAfterExit(file: string, args: readonly string[]): void {
  const bash = fs.existsSync("/bin/bash");
  const close = bash ? 'for fd in /proc/$$/fd/*; do n=${fd##*/}; [ "$n" -gt 2 ] && eval "exec $n>&-"; done 2>/dev/null; ' : "";
  const script = `${close}while kill -0 "$0" 2>/dev/null; do sleep 0.2; done; exec "$@"`;
  spawn(bash ? "/bin/bash" : "/bin/sh", ["-c", script, String(process.pid), file, ...args], {
    detached: true,
    stdio: "ignore",
  }).unref();
}
