// The first second of a media-engine video over NDI®, as a receiver connected BEFORE «EN VIVO» gets it — the
// moment `ndi-receiver.spec.ts` cannot see: it connects 1.5 s after and drops its first second. The 2 h soak of 2.8.0
// (2026-11-11) saw it on every engine start: the previous picture frozen ~1.1 s, then black, then the clip at half
// its rate for ~0.6 s (0, 1, 5, 6, 8, 10, 10, 12, 12, 14…). The owner's rule (2026-11-12): the room keeps the previous
// picture until the new video has a frame — never black in between — and the video starts at its own pace.
// The probe and the output's setup: `support/ndi.ts`.
import { expect, test, type WorshipApp } from "./support/app";
import { probe, receiveFrames, source, type NdiSource, type ReceivedFrame } from "./support/ndi";

/** A frame darker than this is black (the probe's mean luma: black is ~16, `testsrc2` and `photo.png` well over 60). */
const BLACK_LUMA = 30;

async function goLiveWith(app: WorshipApp, inner: "Videos" | "Imágenes", name: string): Promise<number> {
  await app.previewFile(inner, name);
  await app.goLive();
  return Date.now();
}

/** `name` in PREVIEW, as an operator looks at it before sending it; then received from 1.5 s before «EN VIVO» to
 *  ~6.5 s after. Returns the frames and when it went live. */
async function startOver(app: WorshipApp, ndi: NdiSource, name: string) {
  await app.previewFile("Videos", name);
  const received = receiveFrames(ndi, 8);
  await app.control.waitForTimeout(1500);
  await app.goLive();
  const liveAt = Date.now();
  return { frames: await received, liveAt };
}

/**
 * The new video's first frame: the first after «EN VIVO» carrying a number of the clip's first two seconds that the
 * next frames confirm — a frame in the middle of the fade still reads as the picture it leaves.
 */
function firstNewFrame(after: ReceivedFrame[]): number {
  return after.findIndex(
    (f, i) => f.n >= 0 && f.n < 60 && after.slice(i + 1, i + 4).some((g) => g.n > f.n && g.n <= f.n + 4),
  );
}

function check(frames: ReceivedFrame[], liveAt: number, label: string) {
  expect(frames.filter((f) => f.t < liveAt).length, "the receiver was getting frames before «EN VIVO»").toBeGreaterThan(10);
  const after = frames.filter((f) => f.t >= liveAt);
  const first = firstNewFrame(after);
  expect(first, "the new video reached the receiver").toBeGreaterThanOrEqual(0);
  const waiting = after.slice(0, first);
  // The 20 frames after the first one that reads: until then the fade in (300 ms) hides the barcode, after it every
  // frame reads — and the ~0.6 s a rate seeded by the engine's starting burst kept at half falls inside them.
  const from = after[first]!.n;
  const shown = new Set(after.map((f) => f.n).filter((n) => n > from && n <= from + 20));
  console.log(
    `[ndi-start] ${label}: first frame ${after[first]!.t - liveAt} ms after «EN VIVO» (#${from}), ` +
      `${waiting.length} frames waiting (min luma ${Math.min(...waiting.map((f) => f.luma), 255)}), ` +
      `next 20 lost ${20 - shown.size}: ${after.slice(first, first + 24).map((f) => f.n).join(",")}`,
  );
  expect(waiting.filter((f) => f.luma < BLACK_LUMA).length, "black frames between the previous picture and the video").toBe(0);
  // Today's half rate (5, 7, 7, 9, 9, 11…) loses 3+ of them; one may still go to the network's or the clock's jitter.
  expect(20 - shown.size, "of the 20 frames after the first, never reached the receiver").toBeLessThanOrEqual(1);
}

test("an engine video started from a picture: the picture stays until its first frame, then every frame", async ({ app }) => {
  test.setTimeout(120_000);
  const ndi = await source(app);
  test.skip(!ndi, "no NDI runtime on this computer");
  await app.addMedia("image", "photo.png");
  await app.addMedia("video", "ndi-bar.avi");
  await goLiveWith(app, "Imágenes", "photo");
  await app.projector();
  await app.control.waitForTimeout(1000);
  const { frames, liveAt } = await startOver(app, ndi!, "ndi-bar");
  check(frames, liveAt, "from a picture");
});

test("an engine video replacing another: the last frame stays until the new first frame, then every frame", async ({ app }) => {
  test.setTimeout(120_000);
  const ndi = await source(app);
  test.skip(!ndi, "no NDI runtime on this computer");
  // A second file of the same video: GO LIVE on the one already on air only uncovers it.
  await app.addMedia("video", "ndi-bar.avi", "ndi-bar-2.avi");
  await goLiveWith(app, "Videos", "ndi-bar");
  await app.projector();
  await app.control.waitForTimeout(2000);
  const { frames, liveAt } = await startOver(app, ndi!, "ndi-bar-2");
  check(frames, liveAt, "replacing a video");
});

test("a cut into an engine video: the picture stays until its first frame, then the clip with its sound in sync", async ({ app }) => {
  test.setTimeout(120_000);
  const ndi = await source(app);
  test.skip(!ndi, "no NDI runtime on this computer");
  // Main's setting, read by the control window when it loads.
  await app.invoke("settings:set", { "projection.transition.style": "none" });
  await app.control.reload();
  await expect(app.control.getByRole("button", { name: "EN VIVO", exact: true })).toBeVisible();
  await app.addMedia("image", "photo.png");
  // A white flash and a beep together, the first at 0:00 — the clip's very first frame is a flash.
  await app.addMedia("video", "ndi-av.avi");
  await goLiveWith(app, "Imágenes", "photo");
  await app.projector();
  await app.control.waitForTimeout(1000);
  await app.previewFile("Videos", "ndi-av");
  const received = receiveFrames(ndi!, 6);
  const sync = probe<{ pairs: number; first: number; flashes: number; beeps: number }>("avsync", ndi!.name, ndi!.url, "6");
  await app.control.waitForTimeout(1500);
  await app.goLive();
  const liveAt = Date.now();
  const after = (await received).filter((f) => f.t >= liveAt);
  const av = await sync;
  const first = after.findIndex((f) => f.luma > 150);
  const waiting = after.slice(0, Math.max(first, 0));
  console.log(
    `[ndi-start] cut: first frame ${first >= 0 ? after[first]!.t - liveAt : "-"} ms after «EN VIVO», ${waiting.length} frames ` +
      `waiting (min luma ${Math.min(...waiting.map((f) => f.luma), 255)}), sound minus picture at 0:01 ${av.first} ms (${av.pairs} pairs, ${av.flashes} flashes, ${av.beeps} beeps)`,
  );
  expect(first, "the clip reached the receiver").toBeGreaterThanOrEqual(0);
  expect(waiting.filter((f) => f.luma < BLACK_LUMA).length, "black frames between the photo and the clip").toBe(0);
  // GO LIVE plays the engine PREVIEW already opened (owner, 2026-11-12): ~0.1 s on the Mac. One opening the file then
  // took 0.23 s here, and 0.8–1.2 s on a Windows PC.
  expect(after[first]!.t - liveAt, "ms from «EN VIVO» to the clip's first frame").toBeLessThanOrEqual(200);
  // Its sound, which starts at PREVIEW's level (0), at the live one — and in step from the first second, by EBU R37 as
  // `ndi-receiver.spec.ts` holds the rest of a clip. 0:00's own beep never reaches a receiver (2026-11-12, any
  // engine start), so the first pair is 0:01's.
  expect(av.pairs, "flashes and beeps paired").toBeGreaterThanOrEqual(3);
  expect(av.first).toBeGreaterThanOrEqual(-45);
  expect(av.first).toBeLessThanOrEqual(65);
});

// The NDI window decodes its own copy of a Chromium video, which follows the projector's — whose sound NDI sends. The
// first play after the app opens usually puts the copy ahead (12 of 14 measured): +109…+246 ms at 0:01, and still
// +13…+128 at 0:02 while it could slow down only 10 %. Three fresh apps, so a broken follow is all but sure to show.
// 0:00's own pair comes before the projector has said where it is, so the one that counts is 0:01's.
for (const start of [1, 2, 3])
  test(`a Chromium video over NDI: its sound in step with its picture from the first second (${start})`, async ({ app }) => {
    test.setTimeout(120_000);
    const ndi = await source(app);
    test.skip(!ndi, "no NDI runtime on this computer");
    await app.addMedia("image", "photo.png");
    await app.addMedia("video", "ndi-av.mp4");
    await goLiveWith(app, "Imágenes", "photo");
    await app.projector();
    await app.control.waitForTimeout(1000);
    await app.previewFile("Videos", "ndi-av");
    const sync = probe<{ list: [number, number][] }>("avsync", ndi!.name, ndi!.url, "6");
    await app.control.waitForTimeout(1500);
    await app.goLive();
    const liveAt = Date.now();
    const pairs = (await sync).list;
    console.log(`[ndi-start] chromium: ${pairs.map(([t, d]) => `${((t - liveAt) / 1000).toFixed(1)}s ${d}`).join(", ")}`);
    const second = pairs.find(([t]) => t >= liveAt + 700);
    expect(second, "0:01's flash and beep reached the receiver").toBeDefined();
    expect(second![1]).toBeGreaterThanOrEqual(-45);
    expect(second![1]).toBeLessThanOrEqual(65);
  });
