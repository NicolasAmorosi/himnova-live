/** `worship://`'s Range contract (`CLAUDE.md`: non-negotiable). Without it every video loses seek, and a large
 *  one dies with `PIPELINE_ERROR_DECODE (-12909)` from misaligned bytes. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { serveFile } from "../../src/main/protocol/serve-file";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-serve-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = path.join(dir, "clip.mp4");
const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
fs.writeFileSync(file, bytes);

async function get(range: string): Promise<{ status: number; range: string | null; accept: string | null; body: Buffer }> {
  const res = await serveFile(new Request("worship://asset/1", { headers: { Range: range } }), file);
  return {
    status: res.status,
    range: res.headers.get("Content-Range"),
    accept: res.headers.get("Accept-Ranges"),
    body: Buffer.from(await res.arrayBuffer()),
  };
}

test("a byte range is answered with 206 and exactly those bytes", async () => {
  // Fails if Range is ignored (M23: always 200 with the whole file) or the bytes are not the ones asked for.
  expect(await get("bytes=100-199")).toEqual({ status: 206, range: "bytes 100-199/1000", accept: "bytes", body: bytes.subarray(100, 200) });
  // The open-ended form `<video>` starts with, and the suffix form.
  expect(await get("bytes=900-")).toMatchObject({ status: 206, range: "bytes 900-999/1000", body: bytes.subarray(900) });
  expect(await get("bytes=-10")).toMatchObject({ status: 206, range: "bytes 990-999/1000", body: bytes.subarray(990) });
  // Fails if a range past the end gets bytes that are not there.
  expect(await get("bytes=1000-")).toMatchObject({ status: 416, range: "bytes */1000" });
});
