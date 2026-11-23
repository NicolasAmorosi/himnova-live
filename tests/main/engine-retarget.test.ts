/**
 * GO LIVE takes over PREVIEW's engine (`takePreviewEngine`), seeking it to where the live video starts, and the live
 * session hears again what that engine last said (`retarget`). Parked at its end in PREVIEW, what it last said was
 * «ended»: replayed, the live video ended at once and «Al terminar» put the LOGO up (Windows E2E, 2026-11-22). The real
 * `media-engine` over a fake engine: a shell script, so macOS only, as `engine-start.test.ts`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ dir: "" }));
h.dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-retarget-"));

vi.mock("electron", () => ({ app: { getGPUInfo: () => Promise.resolve({}), on: () => undefined }, sharedTexture: {} }));
vi.mock("../../src/main/paths", () => ({
  engineCacheDir: h.dir,
  engineDir: h.dir,
  enginePath: path.join(h.dir, "media-engine"),
}));
vi.mock("../../src/main/ndi/ndi-output", () => ({ setNdiAudioRoute: () => undefined }));
vi.mock("../../src/main/media/engine-sessions", () => ({ setEngineAudioDevices: () => undefined }));
vi.mock("../../src/main/services/broadcast", () => ({ broadcast: () => undefined }));
vi.mock("../../src/main/services/repos", () => ({ getSettingsRepo: () => ({ get: () => false }) }));

test.skipIf(process.platform !== "darwin")("an engine sought away from its end is not «ended» for the session that takes it over", async () => {
  const ENDED = `{"ev":"status","time":30,"duration":30,"paused":true,"ended":true}`;
  fs.writeFileSync(path.join(h.dir, "media-engine"), `#!/bin/sh\necho '{"ev":"hello","proto":8}'\necho '{"ev":"ready","gpu":"fake"}'\necho '${ENDED}'\nexec sleep 30\n`);
  fs.chmodSync(path.join(h.dir, "media-engine"), 0o755);
  const { killAllEngines, takeEngine } = await import("../../src/main/media/media-engine");
  const engine = takeEngine();
  try {
    // PREVIEW's engine, parked at the end of the next row's video.
    await expect.poll(() => engine.position, { timeout: 3000 }).toBe(30);
    // GO LIVE: «Al terminar» sends that row from 0:00.
    engine.seek(0);
    const status = vi.fn();
    engine.retarget("live", { status });
    expect(status).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ time: 0, ended: false }));
    expect(engine.position).toBe(0);
  } finally {
    killAllEngines();
  }
});
