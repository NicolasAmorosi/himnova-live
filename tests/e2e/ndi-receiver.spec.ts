// The NDI® output as a receiver gets it (`native/ndi-probe`): every frame of a video, once, and its sound with its
// picture. Not the status label `ndi-output.spec.ts` reads, nor frames received per second — both said «fine» while
// 2.7.0 lost 0–27 % of a video and 2.7.1 lost up to 37 % of an engine one (2026-11-10 review, agent3-02/agent2-01).
// The frame loss depended on the phase each playback started with: each case starts two plays.
//
// Needs the NDI runtime (skipped without one, like the output itself) and the probe built for this computer:
// `native/build.sh ndi-probe <darwin-arm64|win32-x64|linux-x64>` — a missing probe FAILS, never skips.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type WorshipApp } from "./support/app";

const PROBE = path.join(
  process.cwd(),
  "native",
  ".build",
  `ndi-probe-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}${process.platform === "win32" ? ".exe" : ""}`,
);
const NAME = "Lumina E2E";

function probe<T>(...args: string[]): Promise<T> {
  return new Promise((resolve, reject) =>
    execFile(PROBE, args, { timeout: 60_000 }, (_error, out) => {
      const line = String(out).trim().split("\n").at(-1) ?? "";
      try {
        resolve(JSON.parse(line) as T);
      } catch {
        reject(new Error(`ndi-probe ${args[0]}: ${String(out)}`));
      }
    }),
  );
}

/** The output on, with its sound; `null` when this computer has no NDI runtime. */
async function source(app: WorshipApp): Promise<{ name: string; url: string } | null> {
  await app.invoke("settings:set", { "ndi.output.name": NAME, "ndi.output.audio": true, "ndi.output.audioDelayMs": 0 });
  await app.invoke("settings:set", { "ndi.output.enabled": true });
  const state = async () => (await app.invoke<{ state: string }>("ndi:getStatus")).state;
  await expect.poll(state, { timeout: 30_000 }).toMatch(/sending|runtime-missing/);
  if ((await state()) === "runtime-missing") return null;
  expect(fs.existsSync(PROBE), `the NDI test receiver is not built: native/build.sh ndi-probe (${PROBE})`).toBe(true);
  const found = await probe<{ name: string | null; url: string }>("find", `(${NAME})`, "10");
  expect(found.name, `«${NAME}» is not listed by an NDI finder`).not.toBeNull();
  return { name: found.name!, url: found.url };
}

async function live(app: WorshipApp, file: string, name: string) {
  await app.addMedia("video", file);
  await app.previewFile("Videos", name);
  await app.goLive();
  await app.projector();
  await app.control.waitForTimeout(1500);
}

for (const [label, file] of [
  ["Chromium plays (MP4)", "ndi-bar.mp4"],
  ["the media engine plays (AVI)", "ndi-bar.avi"],
] as const) {
  test(`a 1080p30 video ${label} reaches the receiver frame by frame, none lost`, async ({ app }) => {
    test.setTimeout(120_000);
    const ndi = await source(app);
    test.skip(!ndi, "no NDI runtime on this computer");
    // A second file of the same video: GO LIVE on the one already on air only uncovers it.
    for (const [play, current] of [file, file.replace(".", "-2.")].entries()) {
      await live(app, current, current.replace(/\.\w+$/, ""));
      const counted = await probe<{ fresh: number; skipped: number; nobar: number }>("count", ndi!.name, ndi!.url, "8");
      console.log(`[ndi-receiver] ${current}, play ${play + 1}: ${JSON.stringify(counted)}`);
      // 8 s at 30 fps after the first second: every number once, at most one lost at a joint.
      expect(counted.fresh).toBeGreaterThanOrEqual(0.97 * 30 * 8);
      expect(counted.skipped).toBeLessThanOrEqual(1);
    }
  });
}

for (const [label, file, name] of [
  ["Chromium plays (MP4)", "ndi-av.mp4", "ndi-av"],
  ["the media engine plays (AVI)", "ndi-av.avi", "ndi-av"],
] as const) {
  test(`a video ${label} reaches the receiver with its sound in step with its picture`, async ({ app }) => {
    test.setTimeout(120_000);
    const ndi = await source(app);
    test.skip(!ndi, "no NDI runtime on this computer");
    await live(app, file, name);
    const sync = await probe<{ pairs: number; median: number; audioFrames: number }>("avsync", ndi!.name, ndi!.url, "12");
    console.log(`[ndi-receiver] ${file}: ${JSON.stringify(sync)}`);
    expect(sync.audioFrames, "the receiver got no sound").toBeGreaterThan(100);
    expect(sync.pairs, "flashes and beeps paired").toBeGreaterThanOrEqual(8);
    // EBU R37: the sound no more than 40 ms early nor 60 ms late; a few ms more either way for the receiver's grain.
    expect(sync.median).toBeGreaterThanOrEqual(-45);
    expect(sync.median).toBeLessThanOrEqual(65);
  });
}
