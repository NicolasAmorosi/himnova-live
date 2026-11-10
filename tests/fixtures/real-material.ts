// Real files no fixture reproduces — the HASD songbook project's songs, a church's hymnal — kept out of the repo and
// read from `WORSHIP_REAL_DIR` (default: ~/Downloads). Where they are not, their tests skip; on a computer that is
// meant to have them (the release PCs), `WORSHIP_REAL=required` makes a missing one fail instead of passing on
// nothing (2026-11-10 review, agent3-15: Windows and Linux skipped them without a word).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.env["WORSHIP_REAL_DIR"] ?? path.join(os.homedir(), "Downloads");

/** Where `relative` is inside the real-material folder. */
export function realPath(relative: string): string {
  return path.join(ROOT, relative);
}

/** Whether a test should skip for want of `file` — throws instead when the material is required. */
export function realMissing(file: string): boolean {
  if (fs.existsSync(file)) return false;
  if (process.env["WORSHIP_REAL"] === "required") throw new Error(`real material missing: ${file} (WORSHIP_REAL_DIR)`);
  return true;
}
