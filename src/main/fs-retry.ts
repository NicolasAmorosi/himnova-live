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

/** Cleanup that must never fail the work it cleans up after: retried the way
 *  Node offers, then logged and dropped. */
export function removeQuietly(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    console.warn(`[fs] could not remove ${target}`, error);
  }
}
