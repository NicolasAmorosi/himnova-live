import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { saveVerified } from "../../src/main/updates/verified-download";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-dmg-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const release = Buffer.from("the release's installer");
const sha512 = createHash("sha512").update(release).digest("base64");
const body = (bytes: Buffer) => new Response(bytes).body!;

test("the release's bytes are kept", async () => {
  const target = path.join(dir, "good.dmg");
  await expect(saveVerified(body(release), target, sha512, release.length, () => {})).resolves.toBe(target);
  expect(fs.readFileSync(target)).toEqual(release);
});

test("bytes that are not the release's are refused and leave nothing on disk", async () => {
  const target = path.join(dir, "bad.dmg");
  // Fails if the sha512 check is skipped (M14): the app would offer to open an installer someone altered.
  await expect(saveVerified(body(Buffer.from("altered")), target, sha512, 7, () => {})).rejects.toMatchObject({
    code: "ERR_CHECKSUM_MISMATCH",
  });
  expect(fs.readdirSync(dir).filter((name) => name.startsWith("bad"))).toEqual([]);
});
