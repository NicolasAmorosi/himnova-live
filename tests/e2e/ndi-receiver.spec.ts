// The NDI® output as a receiver gets it (`native/ndi-probe`): every frame of a video, once, and its sound with its
// picture. Not the status label `ndi-output.spec.ts` reads, nor frames received per second — both said «fine» while
// 2.7.0 lost 0–27 % of a video and 2.7.1 lost up to 37 % of an engine one (2026-11-10 review, agent3-02/agent2-01).
// The frame loss depended on the phase each playback started with: each case starts two plays.
// The probe and the output's setup: `support/ndi.ts`.
import { expect, test, type WorshipApp } from "./support/app";
import { probe, source } from "./support/ndi";

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
