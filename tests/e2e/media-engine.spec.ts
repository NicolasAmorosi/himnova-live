import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { MediaAsset } from "../../src/shared/types/media";
import { fixture } from "./support/paths";
import { audioStates, engineCanvas, expect, moving, relaunch, test, videoStates, type WorshipApp } from "./support/app";

/**
 * "Tiene que poder reproducir todo lo que le tires" (2026-10-18). Each file
 * here is one Chromium cannot play as it is — measured, not assumed; see
 * `src/main/media/media-compat.ts` — and each must end up playing on the
 * projector anyway, without the operator doing anything but importing it.
 *
 * A file like that is played by the media engine (`media/engine-sessions.ts`:
 * video since 2026-10-30, audio since the same day's step 1.2). Nothing is
 * converted since step 1.4 (2026-11-02).
 */

const engineAssets = (app: WorshipApp) => app.invoke<number[]>("engine:assets");

async function waitEngine(app: WorshipApp, asset: MediaAsset) {
  await expect.poll(async () => (await engineAssets(app)).includes(asset.id), { timeout: 30_000 }).toBe(true);
}

test("an AVI plays through the media engine at once", async ({ app }) => {
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
});

test("GO LIVE takes the engine PREVIEW opened, and picked again PREVIEW gets one of its own", async ({ app }) => {
  const [avi] = await app.addMedia("video", "long-xvid.avi");
  if (!avi) throw new Error("import failed");
  await waitEngine(app, avi);
  await app.previewFile("Videos", "long-xvid");
  await expect.poll(async () => (await engineCanvas(app.control, "preview:"))?.width ?? 0).toBe(1920);
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => moving(projector, "video:")).toBe(true);
  // It left PREVIEW when it went out (owner, 2026-11-15).
  await expect.poll(async () => (await engineCanvas(app.control, "preview:"))?.width ?? 0).toBe(0);
  await app.previewFile("Videos", "long-xvid");
  await expect.poll(async () => (await engineCanvas(app.control, "preview:"))?.width ?? 0).toBe(1920);

  // PREVIEW's scrubber moves a new engine of PREVIEW's, paused — never the one now on air.
  const before = (await engineCanvas(app.control, "preview:"))?.sample;
  const scrubber = app.previewColumn().getByRole("slider", { name: "Posición de long-xvid" });
  await scrubber.focus();
  await scrubber.press("End");
  await expect.poll(async () => (await engineCanvas(app.control, "preview:"))?.sample).not.toBe(before);
  expect(await moving(app.control, "preview:")).toBe(false);
  const position = app.liveColumn().getByRole("slider", { name: "Posición de long-xvid" });
  const live = Number(await position.getAttribute("aria-valuenow"));
  expect(live).toBeLessThan(Number(await scrubber.getAttribute("aria-valuemax")) / 2);
  await expect.poll(async () => Number(await position.getAttribute("aria-valuenow"))).toBeGreaterThan(live);
  expect(await moving(projector, "video:")).toBe(true);
});

// The owner's rule (2026-11-12): the room keeps the previous picture until the new video has a frame, never black in
// between. A push of the same scene in that wait (the LIVE fader, a mute, a plate) took the picture down and left the
// video's empty canvas on screen for the rest of the wait (~1.45 s on the owner's Windows PC); in a fade, it cut the
// fade. Pressed in the very frame the video's canvas appears, so it lands in the wait (or, if the first frame beat it,
// in the fade): the picture has to be there one frame later either way (audit A2). Read on the LIVE monitor, the same
// `OutputView` the projector draws, deciding with the same push.
test("muting LIVE while an engine video waits for its first frame leaves the picture on screen", async ({ app }) => {
  const [avi, photo] = [...(await app.addMedia("video", "long-xvid.avi")), ...(await app.addMedia("image", "photo.png"))];
  if (!avi || !photo) throw new Error("import failed");
  await waitEngine(app, avi);
  await app.previewFile("Imágenes", "photo");
  await app.goLive();
  const projector = await app.projector();
  const photoUrl = `worship://asset/${photo.id}`;
  const stage = app.liveColumn().locator(".aspect-video").first();
  await expect(stage.locator(`img[src="${photoUrl}"]`)).toHaveCount(1);
  await app.previewFile("Videos", "long-xvid");
  await expect.poll(async () => (await engineCanvas(app.control, "preview:"))?.width ?? 0).toBe(1920);

  const goLive = await app.control.getByRole("button", { name: "EN VIVO", exact: true }).first().elementHandle();
  const mute = await app.liveColumn().getByRole("button", { name: "Silenciar EN VIVO" }).elementHandle();
  const seen = await stage.evaluate(
    async (root, { goLive, mute, photoUrl }) => {
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const photoOn = () => root.querySelector(`img[src="${photoUrl}"]`) !== null;
      (goLive as HTMLButtonElement).click();
      let canvas: HTMLCanvasElement | null = null;
      for (const start = performance.now(); canvas === null && performance.now() - start < 3000; ) {
        await frame();
        canvas = root.querySelector<HTMLCanvasElement>('canvas[data-frame-key^="video:"]');
      }
      const held = canvas?.style.animationPlayState === "paused";
      const photoAtPush = photoOn();
      (mute as HTMLButtonElement).click();
      await frame();
      return { canvas: canvas !== null, held, photoAtPush, photoAfter: photoOn() };
    },
    { goLive, mute, photoUrl },
  );
  console.log(`[media-engine] A2: ${JSON.stringify(seen)}`);
  expect(seen.canvas, "the video's canvas mounted").toBe(true);
  expect(seen.photoAtPush, "the picture on screen while the video opens").toBe(true);
  expect(seen.photoAfter, "the picture still on screen after the push of the same scene").toBe(true);
  // And the video does come in.
  await expect.poll(() => moving(projector, "video:")).toBe(true);
  await expect(stage.locator(`img[src="${photoUrl}"]`)).toHaveCount(0);
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
  // Held paused until the new window showed it: told to play as the window was made, the room heard it before it
  // could see it (2026-11-15 audit, A19). How long it waited is how long it used to sound unseen.
  const held = app.log.find((line) => /\[engine\] live video held \d+ ms until the new projector showed it/.test(line));
  console.log(`[media-engine] A19: ${held?.replace(/.*\[engine\]/, "[engine]") ?? "never held"}`);
  expect(held, "the reopened projector's video waited to be seen").toBeDefined();
});

test("a projector that dies under an engine video comes back by itself, and the video waits to be seen", async ({ app }) => {
  app.crashLogExpected = true;
  const [avi] = await app.addMedia("video", "long-xvid.avi");
  if (!avi) throw new Error("import failed");
  await waitEngine(app, avi);
  await app.previewFile("Videos", "long-xvid");
  await app.goLive();
  const first = await app.projector();
  await expect.poll(() => moving(first, "video:")).toBe(true);
  await app.electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().endsWith("/projection.html"))
      ?.webContents.forcefullyCrashRenderer(),
  );
  // The reopen of A1, the hold of A19 (2026-11-15 audit).
  await expect(app.control.getByText("La ventana de proyección se cayó y se volvió a abrir sola")).toBeVisible();
  await expect
    .poll(() => app.log.some((line) => /\[engine\] live video held \d+ ms until the new projector showed it/.test(line)))
    .toBe(true);
  await expect.poll(async () => moving(await app.projector(), "video:")).toBe(true);
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
    for (const engine of execFileSync("pgrep", ["-P", String(app.mainPid), "-f", "media-engine"], { encoding: "utf8" }).split("\n")) {
      if (engine.trim()) process.kill(Number(engine), "SIGKILL");
    }
  }
  await expect(app.control.getByText("No se pudo reproducir «long-xvid» en el proyector")).toBeVisible();
  await expect(app.liveColumn().getByText("No se pudo reproducir", { exact: true })).toBeVisible();
  // Not started again on its own, and the congregation sees no error text.
  await expect.poll(() => moving(projector, "video:")).toBe(false);
  await expect(projector.locator("body")).not.toContainText("No se pudo");
  // NEGRO and back is the same video, still broken: the warning stays, and so does GO LIVE's knowledge of it. NEGRO
  // used to forget it, and then GO LIVE on the same file only uncovered the dead video (2026-11-15 audit, A18).
  await app.control.locator("body").press("b");
  await app.control.locator("body").press("b");
  await expect(app.liveColumn().getByText("No se pudo reproducir", { exact: true })).toBeVisible();
  await app.control.waitForTimeout(500);
  await expect(app.liveColumn().getByText("No se pudo reproducir", { exact: true })).toBeVisible();

  // GO LIVE again is the operator's way back — picked again: it left PREVIEW when it went out (owner, 2026-11-15).
  await app.previewFile("Videos", "long-xvid");
  await app.goLive();
  await expect.poll(() => moving(projector, "video:")).toBe(true);
});

test("a video whose picture the engine can't decode is reported, not left playing sound over black", async ({ app }) => {
  // 2026-11-10 review, agent1-06: its sound played, the projector stayed black, nobody was told.
  const [avi] = await app.addMedia("video", "no-picture.avi");
  if (!avi) throw new Error("import failed");
  await waitEngine(app, avi);
  await app.previewFile("Videos", "no-picture");
  await app.goLive();
  await expect(app.control.getByText("No se pudo reproducir «no-picture» en el proyector")).toBeVisible();
  await expect(app.liveColumn().getByText("No se pudo reproducir", { exact: true })).toBeVisible();
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

test("a file that already plays stays off the engine", async ({ app }) => {
  await app.addMedia("video", "clip.mp4");
  await app.addMedia("audio", "song.mp3");
  // Give the background check time to probe both.
  await app.control.waitForTimeout(3000);
  expect(await engineAssets(app)).toEqual([]);
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
  // The launch sweep notices the edit and re-probes: this file does not need the engine.
  await expect.poll(async () => (await engineAssets(again)).includes(asset.id), { timeout: 20_000 }).toBe(false);
  await again.previewFile("Videos", "anuncios");
  await again.goLive();
  const projector = await again.projector();
  await expect
    .poll(() => projector.evaluate(() => document.querySelector("video")?.duration ?? 0), { timeout: 30_000 })
    .toBeCloseTo(8, 0);
});

test("«Repetir en bucle» loops an engine video too: past its end it starts over, still on air", async ({ app }) => {
  await app.control.getByRole("button", { name: "Configuración" }).click();
  const settings = app.control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Proyección" }).click();
  await settings.getByRole("group", { name: "Al terminar un video" }).getByRole("combobox").click();
  await app.control.getByRole("option", { name: "Repetir en bucle", exact: true }).click();
  await settings.getByRole("button", { name: "Volver" }).click();

  const [avi] = await app.addMedia("video", "clip-xvid.avi");
  if (!avi) throw new Error("import failed");
  await waitEngine(app, avi);
  await app.previewFile("Videos", "clip-xvid");
  await app.goLive();
  const projector = await app.projector();
  const position = app.liveColumn().getByRole("slider", { name: "Posición de clip-xvid" });
  // Six seconds long: near its end, then back at the start — never cleared.
  await expect.poll(async () => Number(await position.getAttribute("aria-valuenow")), { timeout: 15_000 }).toBeGreaterThan(4);
  await expect.poll(async () => Number(await position.getAttribute("aria-valuenow")), { timeout: 15_000 }).toBeLessThan(2);
  await expect.poll(() => moving(projector, "video:")).toBe(true);
  await expect(app.control.getByRole("button", { name: "LOGO", exact: true }).first()).not.toHaveAttribute("aria-pressed", "true");
});

// The engine's textures only open on the card that made them, so it opens Chromium's (engine-7). A PC with one card
// can still put Chromium elsewhere: on WARP, whose ids read 0xffff:0xffff. Before engine-7 this drew black.
test.describe("on Windows, with Chromium on WARP", () => {
  test.skip(process.platform !== "win32", "WARP is Windows' software D3D11");
  test.use({ chromiumArgs: ["--use-angle=d3d11-warp"] });

  test("an engine video opens WARP too, and its picture moves on the projector", async ({ app }) => {
    const [avi] = await app.addMedia("video", "long-xvid.avi");
    if (!avi) throw new Error("import failed");
    await waitEngine(app, avi);
    await app.previewFile("Videos", "long-xvid");
    await app.goLive();
    const projector = await app.projector();
    await expect.poll(async () => (await engineCanvas(projector, "video:"))?.width ?? 0).toBe(1920);
    await expect.poll(() => moving(projector, "video:"), { timeout: 15_000 }).toBe(true);
    // From main.log, not the app's stdout: the spare can say it before the test listens.
    expect(fs.readFileSync(path.join(app.profile, "main.log"), "utf8")).toContain("[engine] gpu: D3D11 Microsoft Basic Render Driver (match)");
  });
});
