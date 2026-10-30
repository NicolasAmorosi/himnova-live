import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { MediaAsset, MediaConversionUpdate } from "../../src/shared/types/media";
import { fixture } from "./support/paths";
import { audioStates, engineCanvas, expect, moving, relaunch, test, videoStates, type WorshipApp } from "./support/app";

/**
 * "Tiene que poder reproducir todo lo que le tires" (2026-10-18). Each file
 * here is one Chromium cannot play as it is — measured, not assumed; see
 * `src/main/media/media-compat.ts` — and each must end up playing on the
 * projector anyway, without the operator doing anything but importing it.
 *
 * A file like that is played by the media engine (`media/engine-sessions.ts`:
 * video since 2026-10-30, audio since the same day's step 1.2), with no copy made.
 */

const conversions = (app: WorshipApp) => app.invoke<MediaConversionUpdate[]>("conversion:list");

async function waitEngine(app: WorshipApp, asset: MediaAsset) {
  await expect
    .poll(async () => (await conversions(app)).find((c) => c.assetId === asset.id)?.engine ?? false, { timeout: 30_000 })
    .toBe(true);
}

const noCopies = (app: WorshipApp) => {
  expect(app.log.filter((line) => line.includes("[convert]") && line.includes("→"))).toEqual([]);
  const dir = path.join(app.profile, "converted-media");
  expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
};

test("an AVI plays through the media engine at once, with no copy made", async ({ app }) => {
  const [avi] = await app.addMedia("video", "long-xvid.avi");
  if (!avi) throw new Error("import failed");
  await waitEngine(app, avi);
  await app.previewFile("Videos", "long-xvid");
  // PREVIEW shows its first frame, paused, from an engine of its own.
  await expect.poll(async () => (await engineCanvas(app.control, "preview:"))?.width ?? 0).toBe(1920);
  expect(await moving(app.control, "preview:")).toBe(false);

  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await engineCanvas(projector, "video:"))?.width ?? 0).toBe(1920);
  await expect.poll(() => moving(projector, "video:")).toBe(true);
  // The LIVE monitor draws the projector's own frames: no second decode.
  await expect.poll(() => moving(app.control, "video:")).toBe(true);
  expect(await videoStates(projector)).toEqual([]);
  // The transport reads the engine's clock.
  const position = app.liveColumn().getByRole("slider", { name: "Posición de long-xvid" });
  await expect.poll(async () => Number(await position.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
  noCopies(app);
});

test("NEGRO pauses an engine video where it is, and uncovering resumes it", async ({ app }) => {
  const [avi] = await app.addMedia("video", "long-xvid.avi");
  if (!avi) throw new Error("import failed");
  await waitEngine(app, avi);
  await app.previewFile("Videos", "long-xvid");
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => moving(projector, "video:")).toBe(true);

  await app.control.locator("body").press("b");
  await expect.poll(async () => (await engineCanvas(projector, "video:"))?.opacity).toBe(0);
  await expect.poll(() => moving(projector, "video:")).toBe(false);
  const position = app.liveColumn().getByRole("slider", { name: "Posición de long-xvid" });
  const coveredAt = Number(await position.getAttribute("aria-valuenow"));
  await app.control.locator("body").press("b");
  await expect.poll(() => moving(projector, "video:")).toBe(true);
  // From where it stopped, not from the start.
  expect(Number(await position.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(coveredAt);
});

test("a projector closed from outside pauses the engine, and «Reabrir» goes on from there", async ({ app }) => {
  const [avi] = await app.addMedia("video", "long-xvid.avi");
  if (!avi) throw new Error("import failed");
  await waitEngine(app, avi);
  await app.previewFile("Videos", "long-xvid");
  await app.goLive();
  const first = await app.projector();
  const position = app.liveColumn().getByRole("slider", { name: "Posición de long-xvid" });
  await expect.poll(async () => Number(await position.getAttribute("aria-valuenow"))).toBeGreaterThan(2);

  await first.close();
  const notice = app.control.getByRole("status").filter({ hasText: "Se cerró la ventana de proyección" });
  await expect(notice).toBeVisible();
  // Silent and still while there is no projector.
  await expect.poll(() => moving(app.control, "video:")).toBe(false);
  const closedAt = Number(await position.getAttribute("aria-valuenow"));
  await notice.getByRole("button", { name: "Reabrir" }).click();

  const second = await app.projector();
  await expect.poll(() => moving(second, "video:")).toBe(true);
  expect(Number(await position.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(closedAt);
});

test("an engine that dies is reported and left to the operator", async ({ app }) => {
  const [avi] = await app.addMedia("video", "long-xvid.avi");
  if (!avi) throw new Error("import failed");
  await waitEngine(app, avi);
  await app.previewFile("Videos", "long-xvid");
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => moving(projector, "video:")).toBe(true);

  // The live engine and the spare behind it: only the live one has a file.
  // On Windows by name, which is safe with one worker; that is also the path
  // where the next engine has to close the dead one's textures.
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/F", "/IM", "media-engine.exe"]);
  } else {
    const pid = app.electron.process().pid;
    for (const engine of execFileSync("pgrep", ["-P", String(pid), "-f", "media-engine"], { encoding: "utf8" }).split("\n")) {
      if (engine.trim()) process.kill(Number(engine), "SIGKILL");
    }
  }
  await expect(app.control.getByText("No se pudo reproducir «long-xvid» en el proyector")).toBeVisible();
  await expect(app.liveColumn().getByText("No se pudo reproducir", { exact: true })).toBeVisible();
  // Not started again on its own, and the congregation sees no error text.
  await expect.poll(() => moving(projector, "video:")).toBe(false);
  await expect(projector.locator("body")).not.toContainText("No se pudo");

  // GO LIVE again is the operator's way back.
  await app.goLive();
  await expect.poll(() => moving(projector, "video:")).toBe(true);
});

test("an MP4 that played sound over a black picture now shows its picture", async ({ app }) => {
  const [mp4] = await app.addMedia("video", "sound-over-black.mp4");
  if (!mp4) throw new Error("import failed");
  await waitEngine(app, mp4);
  await app.previewFile("Videos", "sound-over-black");
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await engineCanvas(projector, "video:"))?.width ?? 0).toBe(640);
  await expect.poll(() => moving(projector, "video:")).toBe(true);
});

test("a WMA plays through the media engine: background music NEGRO leaves alone, paused with the projector", async ({ app }) => {
  const [wma] = await app.addMedia("audio", "song.wma");
  if (!wma) throw new Error("import failed");
  await waitEngine(app, wma);
  await app.previewFile("Audios", "song");
  // No element here can open it, so its length comes from main's probe: PREVIEW still picks where it starts.
  await expect(app.previewColumn().getByRole("slider", { name: "Posición de song" })).toHaveAttribute("aria-valuemax", "30");

  await app.goLive();
  const projector = await app.projector();
  const position = app.liveColumn().getByRole("slider", { name: "Posición de song" });
  const at = async () => Number(await position.getAttribute("aria-valuenow"));
  await expect.poll(at).toBeGreaterThan(0);
  expect(await audioStates(projector)).toEqual([]);
  noCopies(app);

  // A standalone audio is background music, not projector content: NEGRO does not pause it.
  await app.control.locator("body").press("b");
  const coveredAt = await at();
  await expect.poll(at).toBeGreaterThan(coveredAt + 1);
  await app.control.locator("body").press("b");

  // Closing the projector silences it where it is, as it silenced an `<audio>` in that window.
  await projector.close();
  const notice = app.control.getByRole("status").filter({ hasText: "Se cerró la ventana de proyección" });
  await expect(notice).toBeVisible();
  const closedAt = await at();
  await app.control.waitForTimeout(1500);
  expect(await at()).toBeLessThanOrEqual(closedAt + 1);
  await notice.getByRole("button", { name: "Reabrir" }).click();
  await app.projector();
  await expect.poll(at).toBeGreaterThan(closedAt + 1);
});

test("a file that already plays is never converted", async ({ app }) => {
  await app.addMedia("video", "clip.mp4");
  await app.addMedia("audio", "song.mp3");
  // Give the background check time to probe both.
  await app.control.waitForTimeout(3000);
  // Not pending, and no copy either: these play as they are.
  expect(await conversions(app)).toEqual([]);
  expect(app.log.filter((line) => line.includes("[convert]") && line.includes("→"))).toEqual([]);
  const dir = path.join(app.profile, "converted-media");
  expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
});

test("a video replaced in place is probed again, and plays as it now is", async ({ app }) => {
  // Last week's announcements needed the engine…
  const file = path.join(app.profile, "media-src", "anuncios.mp4");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(fixture("sound-over-black.mp4"), file);
  const [asset] = await app.invoke<MediaAsset[]>("library:add", { kind: "video", paths: [file] });
  if (!asset) throw new Error("import failed");
  await waitEngine(app, asset);
  await app.quit();

  // …and this week's, saved over the same file, plays as it is and is longer.
  fs.copyFileSync(fixture("clip.mp4"), file);
  const again = await relaunch(app);
  // The launch sweep notices the edit and re-probes: this file needs neither
  // the engine nor a copy.
  await expect.poll(async () => (await conversions(again)).some((c) => c.assetId === asset.id), { timeout: 20_000 }).toBe(false);
  await again.previewFile("Videos", "anuncios");
  await again.goLive();
  const projector = await again.projector();
  await expect
    .poll(() => projector.evaluate(() => document.querySelector("video")?.duration ?? 0), { timeout: 30_000 })
    .toBeCloseTo(8, 0);
});
