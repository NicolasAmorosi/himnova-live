import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { fixture } from "./support/paths";
import { expect, test, type WorshipApp } from "./support/app";

// A hymnal deck's music is the audio file beside it (`linked-audio.ts`). A13 of the landing-guide audit
// (2026-11-10 review, agent4-01): a `.mid` was taken as its music and a `.wma` was handed to Chromium's
// <audio>; neither sounded, and the synced deck waited on slide 1 for a clock that never ran.

const SLIDE_SELECTOR = 'img[src^="worship://deck/"], [data-slide-model^="worship://deck/"]';
function projectedSlide(projector: Page): Promise<number | null> {
  return projector.evaluate((selector) => {
    const last = [...document.querySelectorAll<HTMLElement>(selector)].at(-1);
    const url = last instanceof HTMLImageElement ? last.src : (last?.dataset["slideModel"] ?? "");
    const match = /\/(\d+)(?:\/model)?$/.exec(url);
    return match ? Number(match[1]) : null;
  }, SLIDE_SELECTOR);
}

function audioErrors(projector: Page) {
  return projector.evaluate(() =>
    [...document.querySelectorAll("audio")].map((a) => ({
      src: a.currentSrc || a.src,
      error: a.error?.code ?? null,
      currentTime: a.currentTime,
      paused: a.paused,
    })),
  );
}

/** A one-note Standard MIDI File: what an old hymnal folder carries beside a `.pps`. */
function midi(): Buffer {
  const track = Buffer.from([0x00, 0x90, 0x3c, 0x40, 0x83, 0x60, 0x80, 0x3c, 0x40, 0x00, 0xff, 0x2f, 0x00]);
  const header = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(track.length);
  return Buffer.concat([header, Buffer.from("MTrk"), len, track]);
}

/** `hymn.pptx` (3 slides, 2 s each, no music inside) copied as `<name>.pptx`, with `sibling` beside it. */
async function hymnWithSibling(app: WorshipApp, name: string, sibling: { ext: string; bytes: Buffer } | null) {
  const dir = path.join(app.profile, "himnario");
  fs.mkdirSync(dir, { recursive: true });
  const deck = path.join(dir, `${name}.pptx`);
  fs.copyFileSync(fixture("hymn.pptx"), deck);
  if (sibling) fs.writeFileSync(path.join(dir, `${name}.${sibling.ext}`), sibling.bytes);
  await app.invoke("library:add", { kind: "ppt", paths: [deck] });
  await app.previewFile("Presentaciones", name);
  await expect(
    app.previewColumn().getByRole("list", { name: "Presentación" }).getByRole("button", { name: "3", exact: true }),
  ).toBeVisible({ timeout: 60_000 });
}

test("a MIDI beside the hymn is not its music: the deck advances on its own timings", async ({ app }) => {
  await hymnWithSibling(app, "Himno MIDI", { ext: "mid", bytes: midi() });
  await expect(app.previewColumn().getByText("Himno MIDI.mid")).toHaveCount(0);
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projectedSlide(projector)).toBe(1);
  await expect.poll(() => projectedSlide(projector), { timeout: 10_000 }).toBe(3);
  expect(await audioErrors(projector)).toEqual([]);
});

test("a WMA beside the hymn is its music, played by the media engine, and the deck follows it", async ({ app }) => {
  await hymnWithSibling(app, "Himno WMA", { ext: "wma", bytes: fs.readFileSync(fixture("song.wma")) });
  await expect(app.previewColumn().getByText("Himno WMA.wma").first()).toBeVisible();
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projectedSlide(projector)).toBe(1);
  // No <audio>: the engine plays it, and reports its clock.
  expect(await audioErrors(projector)).toEqual([]);
  await expect.poll(() => projectedSlide(projector), { timeout: 10_000 }).toBe(3);
});

test("music that fails on the projector leaves the hymn on its own timings, not stuck on slide 1", async ({ app }) => {
  await hymnWithSibling(app, "Himno roto", { ext: "mp3", bytes: Buffer.from("not an mp3 at all, just bytes".repeat(200)) });
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projectedSlide(projector)).toBe(1);
  await expect.poll(async () => (await audioErrors(projector))[0]?.error ?? null).not.toBeNull();
  await expect.poll(() => projectedSlide(projector), { timeout: 10_000 }).toBe(3);
});

test("control: the same hymn with nothing beside it advances on its own and ends", async ({ app }) => {
  await hymnWithSibling(app, "Himno solo", null);
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projectedSlide(projector)).toBe(1);
  await expect.poll(() => projectedSlide(projector), { timeout: 10_000 }).not.toBe(1);
});
