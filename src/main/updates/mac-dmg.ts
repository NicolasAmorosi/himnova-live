import { app, net } from "electron";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * macOS updates without Squirrel.
 *
 * `MacUpdater` hands the new bundle to Squirrel.Mac, which accepts it only if
 * it satisfies the running app's designated requirement — and an ad-hoc
 * signature's requirement is that one build's own hash, so no later version
 * ever passes. Until there is a Developer ID, the app downloads the `.dmg`
 * itself, checks it against the `latest-mac.yml` sha512, and opens it: the
 * operator drags the app over the old one.
 */
/** In this profile, not in `~/Library/Caches`: a profile of its own — every E2E run's — then never deletes the
 *  download the installed app has waiting (2026-11-10 review, agent3-16). */
const dmgDir = () => path.join(app.getPath("userData"), "update-download");
/** Where builds before 2.8.0 kept it, shared by every profile. */
const LEGACY_DMG_DIR = path.join(os.homedir(), "Library", "Caches", "worship-app-updater");

/** At launch: a `.dmg` downloaded before is done with — the app it carried is the one running now, or the
 *  operator declined it and the next check fetches it again. 255 MB stayed there for good (agent6-05). */
export function clearDownloadedDmg(): void {
  for (const dir of [dmgDir(), LEGACY_DMG_DIR]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[updates] could not clear ${dir}`, error);
    }
  }
}

/** Downloads `url` into the updater's cache and returns its path. Throws
 *  `ERR_CHECKSUM_MISMATCH` — and leaves nothing behind — when the bytes are not
 *  the ones the release describes. */
export async function downloadDmg(
  url: string,
  sha512: string,
  size: number,
  onProgress: (percent: number, received: number, total: number) => void,
): Promise<string> {
  // One `.dmg` at a time: each is ~200 MB, and an older one is never opened again.
  const dir = dmgDir();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, path.basename(new URL(url).pathname));
  const partial = `${target}.part`;

  const response = await net.fetch(url);
  if (!response.ok || !response.body) {
    throw Object.assign(new Error(`Cannot download ${url}: HTTP ${response.status}`), { statusCode: response.status });
  }
  const total = Number(response.headers.get("content-length")) || size;
  const hash = createHash("sha512");
  const file = await fs.promises.open(partial, "w");
  // Node types the fetch body as a stream of `any`; it is bytes.
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  let received = 0;
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      hash.update(chunk.value);
      await file.write(chunk.value);
      received += chunk.value.byteLength;
      onProgress(total > 0 ? Math.min(100, (received / total) * 100) : 0, received, total);
    }
  } finally {
    await file.close();
  }

  const actual = hash.digest("base64");
  if (actual !== sha512) {
    fs.rmSync(partial, { force: true });
    throw Object.assign(new Error(`sha512 checksum mismatch, expected ${sha512}, got ${actual}`), {
      code: "ERR_CHECKSUM_MISMATCH",
    });
  }
  fs.renameSync(partial, target);
  return target;
}

/** Synchronous and detached on purpose: «When the app closes» calls it from
 *  `quit`, where nothing asynchronous survives. */
export function openDmg(file: string): void {
  spawn("open", [file], { detached: true, stdio: "ignore" }).unref();
}
