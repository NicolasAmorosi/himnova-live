import fs from "node:fs";
import path from "node:path";
import { app, type WebContents } from "electron";
import { IpcError } from "@shared/ipc/result";
import { mt } from "../i18n";
import { showSaveDialogFor } from "../ipc/open-dialog";
import { localDay, songUsageCsv } from "../songs/usage-report";
import { getSongsRepo } from "./repos";

/**
 * Asks where to save the songs used in `[from, to)` and writes them; `null`
 * when the operator cancels. Nothing used in those dates asks nothing.
 */
export async function exportSongUsage(sender: WebContents, from: number, to: number): Promise<{ songs: number } | null> {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new IpcError({ code: "INVALID_ARGUMENT", message: "Invalid date range." });
  }
  const uses = getSongsRepo().usesBetween(from, to);
  if (uses.length === 0) return { songs: 0 };
  const name = `${mt("songs.usageFileName")} ${localDay(from)} ${localDay(to - 1)}.csv`;
  const result = await showSaveDialogFor(sender, {
    title: mt("songs.usageSaveTitle"),
    defaultPath: path.join(app.getPath("documents"), name),
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, songUsageCsv(uses), "utf-8");
  return { songs: uses.length };
}
