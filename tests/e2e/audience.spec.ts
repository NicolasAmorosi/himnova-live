import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_BIBLE_STYLE } from "../../src/shared/types/bible-style";
import { engineCanvas, expect, relaunch, test, type WorshipApp } from "./support/app";
import { ffmpegBinary } from "./support/paths";

/**
 * What the room gets, measured where it gets it — never a proxy (2026-11-10 review, agent3: 14 of 22 mutations that
 * broke the air passed the whole suite, because tests asked «did the canvas change in 400 ms?», «currentTime > 0.5?»,
 * «is `video.volume` 0.3?», «was the setting saved?»). Frames drawn per second, seconds of video per second, the
 * window's own audible state, the app's sound level as the OS mixes it, the bytes `worship://` answers, the two
 * pictures of a transition on the stage, a verse inside the screen, the display kept awake.
 */

test("an engine video (1080p AVI, 25 fps) is drawn on the projector at 25 frames a second", async ({ app }) => {
  await app.addMedia("image", "photo.png");
  await app.addMedia("video", "long-xvid.avi");
  await app.previewFile("Imágenes", "photo");
  await app.goLive();
  const projector = await app.projector();
  await projector.evaluate(() => {
    const w = window as unknown as { qaDraws: number };
    w.qaDraws = 0;
    const proto = CanvasRenderingContext2D.prototype;
    const draw = Reflect.get(proto, "drawImage") as (...args: unknown[]) => void;
    Object.defineProperty(proto, "drawImage", {
      value(this: CanvasRenderingContext2D, ...args: unknown[]) {
        if (this.canvas.dataset["frameKey"]?.startsWith("video:")) w.qaDraws++;
        draw.apply(this, args);
      },
    });
  });
  await app.previewFile("Videos", "long-xvid");
  await app.goLive();
  await expect.poll(() => projector.evaluate(() => (window as unknown as { qaDraws: number }).qaDraws), { timeout: 20_000 }).toBeGreaterThan(0);
  await projector.waitForTimeout(1000);
  const before = await projector.evaluate(() => (window as unknown as { qaDraws: number }).qaDraws);
  await projector.waitForTimeout(5000);
  const drawn = (await projector.evaluate(() => (window as unknown as { qaDraws: number }).qaDraws)) - before;
  console.log(`[audience] engine frames drawn on the projector in 5 s: ${drawn}`);
  expect(drawn, "frames drawn in 5 s of a 25 fps video").toBeGreaterThanOrEqual(0.9 * 25 * 5);
});


test("an AVI the engine plays leaves the projector by itself at its end, like an MP4", async ({ app }) => {
  const [avi] = await app.addMedia("video", "clip-xvid.avi");
  await expect.poll(async () => (await app.invoke<number[]>("engine:assets")).includes(avi!.id), { timeout: 30_000 }).toBe(true);
  await app.previewFile("Videos", "clip-xvid");
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await engineCanvas(projector, "video:"))?.width ?? 0).toBeGreaterThan(0);
  // Six seconds long: gone well within twenty, and nothing left to uncover.
  await expect.poll(async () => engineCanvas(projector, "video:"), { timeout: 20_000 }).toBeNull();
  await expect(app.control.getByRole("button", { name: "VIVO", exact: true })).toBeDisabled();
});


test("the projector plays clip.mp4 (25 fps) in real time and presents ~25 frames a second", async ({ app }) => {
  await app.addMedia("video", "clip.mp4");
  await app.previewFile("Videos", "clip");
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projector.evaluate(() => document.querySelector("video")?.currentTime ?? 0)).toBeGreaterThan(0.5);
  const pace = await projector.evaluate(async () => {
    const video = document.querySelector("video")!;
    let presented = 0;
    const tick = () => {
      presented++;
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
    const t0 = video.currentTime;
    const w0 = performance.now();
    await new Promise((r) => setTimeout(r, 3000));
    const wall = (performance.now() - w0) / 1000;
    return { media: video.currentTime - t0, wall, fps: presented / wall };
  });
  console.log(`[audience] projector video pace: ${JSON.stringify(pace)}`);
  expect(pace.media / pace.wall, "seconds of video per second").toBeGreaterThan(0.9);
  expect(pace.media / pace.wall).toBeLessThan(1.1);
  expect(pace.fps, "frames presented per second of a 25 fps video").toBeGreaterThan(22);
});


const projectorAudible = (app: WorshipApp) =>
  app.electron.evaluate(({ webContents }) =>
    webContents.getAllWebContents().some((w) => w.getURL().endsWith("/projection.html") && w.isCurrentlyAudible()),
  );

test("a video live on the projector is audible, and the LIVE row's mute silences it", async ({ app }) => {
  await app.addMedia("video", "clip.mp4");
  await app.previewFile("Videos", "clip");
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projector.evaluate(() => document.querySelector("video")?.currentTime ?? 0)).toBeGreaterThan(0.3);
  await expect.poll(() => projectorAudible(app), { timeout: 5_000 }).toBe(true);

  await app.liveColumn().getByRole("slider", { name: "Volumen de clip" }).fill("0");
  await expect.poll(() => projectorAudible(app), { timeout: 5_000 }).toBe(false);
});


test("an engine audio is really heard: the app's sound level rises with it and falls with its volume", async ({ app }) => {
  // The NDI output's own capture of the app's sound (`native/engine/ndi-audio.h`) is the meter: what the OS mixes
  // from this app's processes. With the engine's volume at 0, a WMA passed every test (agent3-03, mutation M03).
  await app.invoke("settings:set", { "ndi.output.audio": true, "ndi.output.enabled": true });
  const status = () => app.invoke<{ state: string; audio?: { state: string; levelDb: number | null } | null }>("ndi:getStatus");
  await expect.poll(async () => (await status()).state, { timeout: 30_000 }).toMatch(/sending|runtime-missing/);
  test.skip((await status()).state === "runtime-missing", "no NDI runtime on this computer: nothing captures the sound");
  const level = async () => (await status()).audio?.levelDb ?? -120;
  await expect.poll(level, { timeout: 10_000 }).toBeLessThan(-80);
  await app.addMedia("audio", "song.wma");
  await app.previewFile("Audios", "song");
  await app.goLive();
  await expect.poll(level, { timeout: 10_000 }).toBeGreaterThan(-40);
  await app.liveColumn().getByRole("slider", { name: "Volumen de song" }).fill("0");
  await expect.poll(level, { timeout: 10_000 }).toBeLessThan(-80);
});

test("worship:// answers a byte range with 206 and exactly those bytes", async ({ app }) => {
  const [clip] = await app.addMedia("video", "clip.mp4");
  const answer = await app.control.evaluate(async (id) => {
    const res = await fetch(`worship://asset/${id}`, { headers: { Range: "bytes=100-199" } });
    const body = await res.arrayBuffer();
    return { status: res.status, range: res.headers.get("Content-Range"), accept: res.headers.get("Accept-Ranges"), length: body.byteLength };
  }, clip!.id);
  console.log(`[audience] range answer: ${JSON.stringify(answer)}`);
  expect(answer).toMatchObject({ status: 206, accept: "bytes", length: 100 });
  expect(answer.range).toMatch(/^bytes 100-199\/\d+$/);
});

/** A second picture, unlike `photo.png`, made once with the bundled FFmpeg. */
const RED = path.join(os.tmpdir(), "worship-e2e-red.png");
if (!fs.existsSync(RED)) {
  execFileSync(ffmpegBinary(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=#c0392b:size=1280x720", "-frames:v", "1", RED]);
}

/** For `ms` after `action`: how long (ms) the old and the new picture shared the projector's stage. */
async function overlapDuring(projector: Page, ms: number, action: () => Promise<void>): Promise<number> {
  const sampling = projector.evaluate(async (span) => {
    let first: number | null = null;
    let last: number | null = null;
    const end = performance.now() + span;
    while (performance.now() < end) {
      const now = performance.now();
      if (document.querySelectorAll('img[src^="worship://asset/"]').length > 1) {
        first ??= now;
        last = now;
      }
      await new Promise(requestAnimationFrame);
    }
    return first === null || last === null ? 0 : last - first;
  }, ms);
  await action();
  return sampling;
}

for (const [style, duration, min, max] of [
  ["Instantáneo", null, 0, 100],
  ["Disolvencia", "Lenta (600 ms)", 500, 900],
] as const) {
  test(`«${style}»${duration ? ` «${duration}»` : ""} chosen in Ajustes: the old picture shares the stage ${min}–${max} ms`, async ({ app }) => {
    // Through Ajustes, as the operator does: `settings:set` alone never reaches the open window's store.
    await app.control.getByRole("button", { name: "Configuración" }).click();
    const settings = app.control.getByRole("dialog", { name: "Configuración" });
    await settings.getByRole("tab", { name: "Proyección" }).click();
    await settings.getByRole("group", { name: "Estilo", exact: true }).getByRole("combobox").click();
    await app.control.getByRole("option", { name: style, exact: true }).click();
    if (duration) {
      await settings.getByRole("group", { name: "Duración", exact: true }).getByRole("combobox").click();
      await app.control.getByRole("option", { name: duration, exact: true }).click();
    }
    await settings.getByRole("button", { name: "Volver" }).click();
    const [a] = await app.addMedia("image", "photo.png");
    const [b] = await app.invoke<{ id: number }[]>("library:add", { kind: "image", paths: [RED] });
    await app.previewFile("Imágenes", "photo");
    await app.goLive();
    const projector = await app.projector();
    await expect(projector.locator(`img[src="worship://asset/${a!.id}"]`)).toBeVisible();
    await projector.waitForTimeout(2000);
    await app.previewFile("Imágenes", "worship-e2e-red");
    const overlap = await overlapDuring(projector, 2500, () => app.goLive());
    await expect(projector.locator(`img[src="worship://asset/${b!.id}"]`)).toBeVisible();
    console.log(`[audience] ${style} ${duration ?? ""}: the two pictures shared the stage for ${Math.round(overlap)} ms`);
    expect(overlap).toBeGreaterThanOrEqual(min);
    expect(overlap).toBeLessThanOrEqual(max);
  });
}


const ESTER_8_9 = "Entonces fueron llamados los escribanos del rey en el mes tercero";

test("the longest verse, at a size that needs the auto-fit, is drawn whole inside the projector", async ({ app: first }) => {
  // At the default 3.5 cqw even Ester 8:9 fits a 16:9 stage, so nothing would be measured: twice that
  // makes the auto-fit shrink it, as a church that picked a large verse size gets.
  await first.invoke("settings:set", { "bible.style": { ...DEFAULT_BIBLE_STYLE, text: { ...DEFAULT_BIBLE_STYLE.text, sizeCqw: 7 } } });
  test.setTimeout(60_000);
  await first.quit();
  const app = await relaunch(first);
  await app.openChapter("Ester 8");
  await app.control.getByRole("listitem").filter({ hasText: ESTER_8_9 }).click();
  await app.goLive();
  const projector = await app.projector();
  const verse = projector.getByText(ESTER_8_9, { exact: false });
  await expect(verse).toBeVisible();
  await projector.waitForTimeout(500); // the auto-fit measures after the first paint
  const box = await verse.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: innerWidth, h: innerHeight, clipped: el.scrollHeight > el.clientHeight + 1 };
  });
  console.log(`[audience] Ester 8:9 on the projector: ${JSON.stringify(box)}`);
  await projector.screenshot({ path: test.info().outputPath("projector.png") });
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.bottom).toBeLessThanOrEqual(box.h);
  expect(box.right).toBeLessThanOrEqual(box.w);
  await expect(projector.getByText("Ester 8:9")).toBeInViewport({ ratio: 1 });
});


const holdsDisplay = (pid: number) =>
  execFileSync("pmset", ["-g", "assertions"], { encoding: "utf8" })
    .split("\n")
    .some((line) => line.includes(`pid ${pid}(`) && /NoDisplaySleep|PreventUserIdleDisplaySleep/.test(line));

test("the open projector keeps the display awake, and closing it lets it sleep", async ({ app }) => {
  test.skip(process.platform !== "darwin", "pmset is macOS's; Windows would read `powercfg /requests`");
  expect(holdsDisplay(app.mainPid)).toBe(false);
  await app.addMedia("image", "photo.png");
  await app.previewFile("Imágenes", "photo");
  await app.goLive();
  await app.projector();
  await expect.poll(() => holdsDisplay(app.mainPid)).toBe(true);

  await app.control.getByRole("button", { name: "Configuración" }).click();
  const settings = app.control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Proyección" }).click();
  await settings.getByRole("button", { name: "Cerrar pantalla" }).click();
  await expect.poll(() => app.hasProjector()).toBe(false);
  await expect.poll(() => holdsDisplay(app.mainPid)).toBe(false);
});
