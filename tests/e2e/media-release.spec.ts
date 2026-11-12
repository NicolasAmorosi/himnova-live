// A video taken off the projector lets go of its player at once (`lib/release-media.ts`), not at the next garbage
// collection: until then the whole player — demuxer, decoder, buffered data — stays in the projector's renderer. The
// 2 h soak of 2.8.0 saw that renderer's memory climb all service long; one player was always still pending
// (2026-11-12, 12 of 12 laps). Read from Chromium's own media log (the `Media` domain, as `chrome://media-internals`).
import { expect, test } from "./support/app";

test("a video taken off the projector destroys its player within 2 s, with no garbage collection", async ({ app }) => {
  await app.addMedia("image", "photo.png");
  await app.addMedia("video", "ndi-bar.mp4");
  await app.previewFile("Imágenes", "photo");
  await app.goLive();
  const projector = await app.projector();

  const session = await projector.context().newCDPSession(projector);
  const created = new Set<string>();
  const destroyed = new Set<string>();
  session.on("Media.playerEventsAdded", ({ playerId, events }) => {
    for (const event of events) {
      if (event.value.includes("kWebMediaPlayerCreated")) created.add(playerId);
      if (event.value.includes("kWebMediaPlayerDestroyed")) destroyed.add(playerId);
    }
  });
  await session.send("Media.enable");

  await app.previewFile("Videos", "ndi-bar");
  await app.goLive();
  await expect.poll(() => created.size, { message: "the projector made a player for the video" }).toBeGreaterThan(0);
  await app.control.waitForTimeout(2000);

  await app.previewFile("Imágenes", "photo");
  await app.goLive();
  await expect
    .poll(() => [...created].filter((id) => !destroyed.has(id)).length, {
      message: "players of the projector still alive after the video left it",
      timeout: 2000,
    })
    .toBe(0);
  await session.detach();
});
