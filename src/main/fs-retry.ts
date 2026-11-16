import fs from "node:fs";
import fsp from "node:fs/promises";

/** Windows Defender and the search indexer briefly open a file that was just
 *  written, so a rename or delete of it fails for a moment with one of these.
 *  A retry, not a failure. */
const TRANSIENT_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/** `rename`, retried for about two seconds while the file is transiently
 *  held. Any other error — or one that outlasts the retries — is thrown. */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 9 || !code || !TRANSIENT_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/** Puts `staging` (or nothing, when null) where `target` is and runs `commit` (the row that names it). The folder that
 *  was there goes aside first and is deleted only once both worked; when either fails it is put back, and the new
 *  one dropped. Deleted first, a new folder that could not be moved in (a file held by Defender) or a row that could
 *  not be written left the old row over a folder that was gone (review of the 2026-11-15 audit, D6). */
export async function replaceFolder<T>(target: string, staging: string | null, commit: () => T): Promise<T> {
  const previous = `${target}.previous`;
  removeQuietly(previous);
  let aside = false;
  try {
    if (fs.existsSync(target)) {
      await renameWithRetry(target, previous);
      aside = true;
    }
    if (staging) await renameWithRetry(staging, target);
    const result = commit();
    if (aside) removeQuietly(previous);
    return result;
  } catch (error) {
    if (staging) removeQuietly(staging);
    if (aside) {
      removeQuietly(target);
      await renameWithRetry(previous, target).catch((back: unknown) => console.warn(`[fs] could not put ${target} back`, back));
    }
    throw error;
  }
}

/** Cleanup that must never fail the work it cleans up after: retried the way
 *  Node offers, then logged and dropped. */
export function removeQuietly(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    console.warn(`[fs] could not remove ${target}`, error);
  }
}
