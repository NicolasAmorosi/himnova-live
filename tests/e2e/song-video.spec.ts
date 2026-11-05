import type { Page } from "@playwright/test";
import { parseLyrics } from "../../src/shared/song-text";
import { DEFAULT_SONG_THEME } from "../../src/shared/types/song";
import type { MediaAsset } from "../../src/shared/types/media";
import { engineCanvas, expect, moving, relaunch, test, type WorshipApp } from "./support/app";

/**
 * A song theme's video background (plan 2026-11-05-video-de-fondo): it loops, silent, under the
 * lyrics; the same element through the song's slides; BLACK pauses it and keeps it.
 */

const LYRICS = "[Estrofa 1]\nPrimera línea\n\nSegunda línea";

/** A song in a theme over `video`, live after a relaunch (songs and themes load at startup). */
async function songOverVideo(first: WorshipApp, video: MediaAsset): Promise<WorshipApp> {
  const theme = await first.invoke<{ id: number }>("songTheme:create", {
    name: "Con video",
    style: { ...DEFAULT_SONG_THEME, background: { kind: "video", assetId: video.id, fit: "cover" } },
  });
  await first.invoke("song:create", {
    title: "Fondo en movimiento",
    number: null,
    authors: null,
    copyright: null,
    ccliNumber: null,
    notes: null,
    sections: parseLyrics(LYRICS, "es").sections,
    order: [],
    themeId: theme.id,
  });
  await first.quit();
  const app = await relaunch(first);
  await app.openResources("Canciones");
  await app.control.getByRole("tabpanel", { name: "Canciones" }).getByRole("listitem").first().click();
  await app.goLive();
  return app;
}

const backgroundVideo = (page: Page) =>
  page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>("[data-song-video] video");
    if (!video) return null;
    // Marked once, so a remount reads as a different element.
    video.dataset["seen"] ??= String(Math.random());
    return { id: video.dataset["seen"], paused: video.paused, muted: video.muted, loop: video.loop, time: video.currentTime };
  });

test("a song's video background loops under the lyrics, through its slides, and BLACK only pauses it", async ({
  app: first,
}) => {
  const [clip] = await first.addMedia("video", "clip.mp4");
  if (!clip) throw new Error("import failed");
  const app = await songOverVideo(first, clip);
  const projector = await app.projector();
  await expect(projector.getByText("Primera línea")).toBeVisible();

  await expect.poll(async () => (await backgroundVideo(projector))?.time ?? 0).toBeGreaterThan(0.3);
  const playing = await backgroundVideo(projector);
  expect(playing).toMatchObject({ paused: false, muted: true, loop: true });

  // The next slide: the same element, still playing.
  await app.control.keyboard.press("ArrowRight");
  await expect(projector.getByText("Segunda línea")).toBeVisible();
  expect((await backgroundVideo(projector))?.id).toBe(playing?.id);

  // BLACK pauses it and keeps it; VIVO lifts BLACK and it plays on.
  await app.control.getByRole("button", { name: "NEGRO", exact: true }).click();
  await expect.poll(async () => (await backgroundVideo(projector))?.paused).toBe(true);
  expect((await backgroundVideo(projector))?.id).toBe(playing?.id);
  await app.control.getByRole("button", { name: "VIVO", exact: true }).click();
  await expect.poll(async () => (await backgroundVideo(projector))?.paused).toBe(false);
  expect((await backgroundVideo(projector))?.id).toBe(playing?.id);
});

test("a background Chromium cannot play goes through the media engine", async ({ app: first }) => {
  const [avi] = await first.addMedia("video", "clip-xvid.avi");
  if (!avi) throw new Error("import failed");
  await expect.poll(async () => (await first.invoke<number[]>("engine:assets")).includes(avi.id), { timeout: 30_000 }).toBe(true);
  const app = await songOverVideo(first, avi);
  const projector = await app.projector();
  await expect(projector.getByText("Primera línea")).toBeVisible();
  await expect.poll(async () => (await engineCanvas(projector, "songVideo:"))?.width ?? 0).toBe(640);
  await expect.poll(() => moving(projector, "songVideo:")).toBe(true);
  // No element of its own: the engine plays it.
  expect(await backgroundVideo(projector)).toBeNull();
});
