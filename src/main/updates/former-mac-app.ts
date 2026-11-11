import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app, dialog, shell } from "electron";
import { mt } from "../i18n";
import { formerBundlePath } from "./former-bundle";

/** `build.appId` — electron-builder's, absent from the packaged `package.json`. */
const APP_ID = "com.worshipapp.app";

function bundleId(bundle: string): string | null {
  try {
    const plist = path.join(bundle, "Contents", "Info.plist");
    return execFileSync("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

export async function retireFormerMacApp(): Promise<void> {
  if (process.platform !== "darwin" || !app.isPackaged) return;
  const former = formerBundlePath(app.getPath("exe"));
  if (!former || !fs.existsSync(former) || bundleId(former) !== APP_ID) return;
  try {
    await shell.trashItem(former);
  } catch (error) {
    console.warn(`[updates] could not move ${former} to the Trash`, error);
    return;
  }
  console.log(`[updates] moved ${former} to the Trash`);
  void dialog.showMessageBox({
    type: "info",
    message: mt("dialogs.formerAppTitle"),
    detail: mt("dialogs.formerAppDetail"),
  });
}
