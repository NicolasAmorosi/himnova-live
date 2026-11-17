/**
 * An engine that cannot start (the AppImage on a Linux without libmpv: it says `hello` and dies at `mpv_create`; a
 * binary that is not executable) answers the outputs question «none» at once and launches nothing more, while an
 * engine main kills on purpose is no sign of it (2026-11-15 audit, A28). The real `media-engine` and `audio-route`
 * over fake engines: shell scripts, so macOS only (Linux's engine needs `handles.node`, Windows runs no `.sh`).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ dir: "", spawned: 0, broadcasts: [] as string[], ndi: new Map<string, boolean>() }));
h.dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-start-"));
const ENGINE = path.join(h.dir, "media-engine");

vi.mock("electron", () => ({ app: { getGPUInfo: () => Promise.resolve({}), on: () => undefined }, sharedTexture: {} }));
vi.mock("../../src/main/paths", () => ({
  engineCacheDir: h.dir,
  engineDir: h.dir,
  enginePath: path.join(h.dir, "media-engine"),
}));
vi.mock("../../src/main/ndi/ndi-output", () => ({ setNdiAudioRoute: () => undefined }));
vi.mock("../../src/main/media/engine-sessions", () => ({ setEngineAudioDevices: () => undefined }));
vi.mock("../../src/main/services/broadcast", () => ({ broadcast: (channel: string) => h.broadcasts.push(channel) }));
vi.mock("../../src/main/services/repos", () => ({ getSettingsRepo: () => ({ get: (key: string) => h.ndi.get(key) ?? false }) }));
vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: (...args: Parameters<typeof real.spawn>) => {
      h.spawned += 1;
      return real.spawn(...args);
    },
  };
});

const engine = (body: string, mode = 0o755) => {
  fs.writeFileSync(ENGINE, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(ENGINE, mode);
};
const HELLO = `echo '{"ev":"hello","proto":8}'`;
const USB = [{ deviceId: "usb", label: "USB Audio" }];

test.skipIf(process.platform !== "darwin")("an engine that cannot start answers «none» at once and is not launched again", async () => {
  const { matchAudioOutputs } = await import("../../src/main/media/audio-route");
  const { engineFailsToStart, killAllEngines, listAudioDevices, prewarmEngine } = await import("../../src/main/media/media-engine");
  const timed = async () => {
    const t0 = performance.now();
    const answer = await matchAudioOutputs(USB);
    return { answer, ms: performance.now() - t0 };
  };

  // Killed by main (a spare for another card, quitting): no sign. It said hello and waits for a question it never answers.
  engine(`${HELLO}\nexec sleep 30`);
  const asked = listAudioDevices();
  await new Promise((resolve) => setTimeout(resolve, 300));
  killAllEngines();
  expect(await asked).toBeNull();
  expect(engineFailsToStart()).toBe(false);
  expect(h.broadcasts).toEqual([]);

  // Says hello and dies, as without libmpv: «pending» for good before, two engines per round every 2 s.
  engine(`${HELLO}\necho "libmpv could not be loaded: libmpv.so.2: cannot open shared object file" >&2\nexit 1`);
  let spawned = h.spawned;
  expect((await timed()).answer).toBe("none");
  expect(h.spawned - spawned).toBe(1);
  spawned = h.spawned;
  for (let round = 0; round < 3; round++) {
    const { answer, ms } = await timed();
    expect(answer).toBe("none");
    expect(ms).toBeLessThan(100);
  }
  expect(h.spawned).toBe(spawned);

  // One that says `ready` is a working engine again: the next question is asked of it.
  engine(`${HELLO}\necho '{"ev":"ready","gpu":"fake"}'\nexec sleep 30`);
  prewarmEngine();
  await expect.poll(() => engineFailsToStart(), { timeout: 2000 }).toBe(false);
  // The control window took «none» for the session and is told to ask again, once (review of A28).
  expect(h.broadcasts).toEqual(["engine-starts"]);
  killAllEngines();
  // An engine that starts with no mark standing (every video's) tells nobody.
  prewarmEngine();
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(h.broadcasts).toEqual(["engine-starts"]);
  killAllEngines();

  // Not executable: spawn fails, and no `exit` may follow. 6 s a round before, «pending».
  engine("exit 0", 0o644);
  spawned = h.spawned;
  const first = await timed();
  expect(first.answer).toBe("none");
  expect(first.ms).toBeLessThan(1000);
  expect(h.spawned - spawned).toBe(1);
  expect((await timed()).answer).toBe("none");
  expect(h.spawned - spawned).toBe(1);
}, 20_000);

// Each engine opened the Mac's default output for 100 ms on start, which only the NDI output's sound tap needs (it
// hears a process Core Audio already knows): only while that output takes the app's sound (2026-11-15 audit, X21).
test.skipIf(process.platform !== "darwin")("an engine opens the Mac's output on start only while NDI takes the app's sound", async () => {
  const { killAllEngines, prewarmEngine } = await import("../../src/main/media/media-engine");
  const said = path.join(h.dir, "args");
  killAllEngines();  // the spare the test above left, which never started
  engine(`echo "$@" > "${said}"\n${HELLO}\nexec sleep 30`);
  for (const [enabled, audio, joins] of [
    [true, true, true],
    [true, false, false],
    [false, true, false],
  ] as const) {
    h.ndi = new Map([["ndi.output.enabled", enabled], ["ndi.output.audio", audio]]);
    fs.rmSync(said, { force: true });
    prewarmEngine();
    await expect.poll(() => fs.existsSync(said) && fs.readFileSync(said, "utf8").includes("--max-width"), { timeout: 2000 }).toBe(true);
    expect(fs.readFileSync(said, "utf8").includes("--ndi-tap 1"), `NDI ${enabled}, its sound ${audio}`).toBe(joins);
    killAllEngines();
  }

  // The sound turned on after the spare started: that spare is replaced by one that opens the output.
  const { matchSpareToNdiSound } = await import("../../src/main/media/media-engine");
  const args = async (): Promise<string> => {
    await expect.poll(() => fs.existsSync(said) && fs.readFileSync(said, "utf8").includes("--max-width"), { timeout: 2000 }).toBe(true);
    return fs.readFileSync(said, "utf8");
  };
  h.ndi = new Map([["ndi.output.enabled", true], ["ndi.output.audio", false]]);
  fs.rmSync(said, { force: true });
  prewarmEngine();
  expect(await args()).not.toContain("--ndi-tap");
  h.ndi = new Map([["ndi.output.enabled", true], ["ndi.output.audio", true]]);
  fs.rmSync(said, { force: true });
  matchSpareToNdiSound();
  expect(await args()).toContain("--ndi-tap 1");
  // The same answer again starts nothing.
  fs.rmSync(said, { force: true });
  matchSpareToNdiSound();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(fs.existsSync(said)).toBe(false);
  killAllEngines();
});
