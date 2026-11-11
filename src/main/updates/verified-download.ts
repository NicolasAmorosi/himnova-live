import { createHash } from "node:crypto";
import fs from "node:fs";

/**
 * The pure half of `mac-dmg.ts`'s download: nothing here imports `electron`, so the check is tested in
 * `tests/main/verified-download.test.ts`.
 *
 * Writes `body` to `target` only if its bytes are the ones the release describes (`sha512`, base64, as
 * `latest-mac.yml` gives it). Throws `ERR_CHECKSUM_MISMATCH` — and leaves nothing behind — when they are not.
 */
export async function saveVerified(
  body: ReadableStream<Uint8Array>,
  target: string,
  sha512: string,
  total: number,
  onProgress: (percent: number, received: number, total: number) => void,
): Promise<string> {
  const partial = `${target}.part`;
  const hash = createHash("sha512");
  const file = await fs.promises.open(partial, "w");
  const reader = body.getReader();
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
