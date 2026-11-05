import { execFileSync } from "node:child_process";
import type { Locator, Page } from "@playwright/test";
import { audioStates, expect, test, videoStates, type WorshipApp } from "./support/app";
import { ffmpegBinary } from "./support/paths";

test("a video goes through PREVIEW before it reaches the projector", async ({ app }) => {
  const [clip] = await app.addMedia("video", "clip.mp4");
  await app.previewFile("Videos", "clip");

  // Selecting only previews: the projector does not even exist yet.
  await expect(app.control.getByRole("slider", { name: "Posición de clip" }).first()).toBeVisible();
  expect(app.hasProjector()).toBe(false);

  await app.goLive();
  const projector = await app.projector();
  await expect
    .poll(async () => (await videoStates(projector)).find((v) => v.src.endsWith(`/asset/${clip?.id}`))?.currentTime ?? 0)
    .toBeGreaterThan(0.5);
  const [video] = await videoStates(projector);
  expect(video).toMatchObject({ paused: false, videoWidth: 640 });
  // The LIVE panel offers to pause what is playing.
  await expect(app.control.getByRole("button", { name: "Pausar" })).toBeVisible();
});

test("NEGRO hides and pauses the video, and uncovering resumes where it was", async ({ app }) => {
  await app.addMedia("video", "clip.mp4");
  await app.previewFile("Videos", "clip");
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await videoStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(1);

  await app.control.getByRole("button", { name: "NEGRO" }).click();
  await expect.poll(async () => (await videoStates(projector))[0]).toMatchObject({ paused: true, opacity: 0 });
  const coveredAt = (await videoStates(projector))[0]?.currentTime ?? 0;
  await projector.waitForTimeout(1000);
  // Still mounted and still where it stopped: not restarted, not advancing.
  expect((await videoStates(projector))[0]?.currentTime).toBeCloseTo(coveredAt, 1);

  // B toggles it back, from the keyboard like an operator would.
  await app.control.locator("body").press("b");
  await expect.poll(async () => (await videoStates(projector))[0]).toMatchObject({ paused: false, opacity: 1 });
  expect((await videoStates(projector))[0]?.currentTime).toBeGreaterThanOrEqual(coveredAt);
});

test("an image is projected", async ({ app }) => {
  const [photo] = await app.addMedia("image", "photo.png");
  await app.previewFile("Imágenes", "photo");
  await app.goLive();
  const projector = await app.projector();
  const image = projector.locator(`img[src="worship://asset/${photo?.id}"]`);
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1280);
});

test("an audio plays without changing what is on screen", async ({ app }) => {
  const [clip] = await app.addMedia("video", "clip.mp4");
  await app.addMedia("audio", "song.mp3");
  await app.previewFile("Videos", "clip");
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await videoStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.3);

  await app.previewFile("Audios", "song");
  await app.goLive();
  await expect.poll(async () => (await audioStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.5);
  // The video is still the picture, and still playing.
  const [video] = await videoStates(projector);
  expect(video?.src).toContain(`/asset/${clip?.id}`);
  expect(video?.paused).toBe(false);
});

test("closing the projector window from outside does not strand the operator", async ({ app }) => {
  await app.addMedia("image", "photo.png");
  await app.previewFile("Imágenes", "photo");
  await app.goLive();
  const first = await app.projector();
  await first.close();
  await expect.poll(() => app.hasProjector()).toBe(false);

  // EN VIVO again reopens it, showing the same image.
  await app.goLive();
  const second = await app.projector();
  await expect(second.locator('img[src^="worship://asset/"]')).toBeVisible();
});

/** The first row under a column's monitor, relative to the column: its X and,
 *  when it has one, its position bar. `null` until it is on screen. */
async function firstRow(column: Locator) {
  const box = await column.boundingBox();
  const close = await column.getByRole("button", { name: /^(Quitar|Detener|Sacar del aire)$/ }).first().boundingBox();
  const bar = column.getByRole("slider", { name: /^Posición de / }).first();
  const barBox = (await bar.count()) > 0 ? await bar.boundingBox() : null;
  if (!box || !close) return null;
  return { x: close.x - box.x, y: close.y, barY: barBox?.y ?? null };
}

async function rowOffset(app: WorshipApp) {
  const [preview, live] = await Promise.all([firstRow(app.previewColumn()), firstRow(app.liveColumn())]);
  if (!preview || !live) return null;
  // `+ 0` folds -0 into 0: Windows measured -0.04, and `toEqual` tells them apart.
  const round = (n: number) => Math.round(n * 10) / 10 + 0;
  return {
    dx: round(live.x - preview.x),
    dy: round(live.y - preview.y),
    dBar: preview.barY === null || live.barY === null ? 0 : round(live.barY - preview.barY),
  };
}

test("the row under PREVIEW and the row under LIVE line up, whatever is on them", async ({ app }) => {
  await app.addMedia("video", "clip.mp4");
  await app.addMedia("audio", "song.mp3");
  await app.addMedia("image", "photo.png");
  await app.addMedia("ppt", "deck.pdf");
  const kinds: [string, () => Promise<void>][] = [
    ["video", () => app.previewFile("Videos", "clip")],
    ["audio", () => app.previewFile("Audios", "song")],
    ["image", () => app.previewFile("Imágenes", "photo")],
    [
      "deck",
      async () => {
        await app.previewFile("Presentaciones", "deck");
        await expect(
          app.previewColumn().getByRole("list", { name: "Presentación" }).getByRole("button", { name: "3", exact: true }),
        ).toBeVisible({ timeout: 60_000 });
      },
    ],
    [
      "verse",
      async () => {
        await app.openChapter("Juan 3");
        await app.control.getByRole("listitem").filter({ hasText: /Porque de tal manera amó Dios/ }).click();
      },
    ],
  ];
  for (const [kind, preview] of kinds) {
    await preview();
    await app.goLive();
    // Twice it drifted apart: the LIVE panel inside the padded scrolling body
    // (6px lower, narrower), then the deck strip inside PREVIEW's, and the
    // PREVIEW hint between a row and its bar.
    await expect.poll(async () => ({ kind, offset: await rowOffset(app) })).toEqual({
      kind,
      offset: { dx: 0, dy: 0, dBar: 0 },
    });
  }
});

/** The projector's mean brightness, frame by frame, while `action` runs — read
 *  off the compositor (CDP screencast): a stray frame lives between two React
 *  renders, where no DOM probe can see it. */
async function brightnessDuring(projector: Page, action: () => Promise<void>) {
  const cdp = await projector.context().newCDPSession(projector);
  const frames: Buffer[] = [];
  cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
    frames.push(Buffer.from(data, "base64"));
    void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", maxWidth: 240, maxHeight: 135 });
  await projector.waitForTimeout(300);
  const mark = frames.length;
  await action();
  await projector.waitForTimeout(900);
  await cdp.send("Page.stopScreencast");
  await cdp.detach();
  // One grey byte per frame: FFmpeg averages each JPEG down to a single pixel.
  const args = "-hide_banner -loglevel error -f mjpeg -i - -vf scale=1:1:flags=area -f rawvideo -pix_fmt gray -";
  const luma = [...execFileSync(ffmpegBinary(), args.split(" "), { input: Buffer.concat(frames) })];
  return { before: luma[mark - 1] ?? 0, during: luma.slice(mark) };
}

test("leaving a video crossfades with no black frame and no dip", async ({ app }) => {
  await app.addMedia("video", "clip.mp4");
  await app.addMedia("image", "photo.png");
  await app.previewFile("Videos", "clip");
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await videoStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.5);

  await app.previewFile("Imágenes", "photo");
  const { before, during } = await brightnessDuring(projector, () => app.goLive());
  expect(during.length).toBeGreaterThan(5);
  // A dissolve between two pictures never gets darker than the darker of the
  // two. Measured before the fix: a black frame (0) in 10 of 12 runs, and the
  // two layers fading at once bottomed out at 87 between a 131 and a 116.
  expect(Math.min(...during)).toBeGreaterThanOrEqual(0.9 * Math.min(before, during.at(-1) ?? 0));
});
