import path from "node:path";
import type { DeckDTO } from "../../src/shared/types/deck";
import type { MediaAsset } from "../../src/shared/types/media";
import { realMissing, realPath } from "../fixtures/real-material";
import { audioStates, expect, msUntilChange, test, type WorshipApp } from "./support/app";

/**
 * The decks the app exists for: the church's hymnal, legacy OLE2 `.pps` files
 * whose song is a separate `.mp3` beside them. Since 2026-10-26 they are read
 * straight from the file, with no conversion (`ppt-binary.ts`). No generated
 * fixture reproduces a real hymn whole, so this runs against the real folder
 * when the machine has it — `WORSHIP_E2E_HYMNAL=<folder with 522.pps>` on the
 * church PC — and skips otherwise. The files are only read, never changed.
 */
const HYMNAL = process.env["WORSHIP_E2E_HYMNAL"] ?? realPath("PPT test/Himnario Nuevo Cantado");
const HYMN = path.join(HYMNAL, "522.pps");

test.skip(realMissing(HYMN), `no hymnal at ${HYMNAL} (set WORSHIP_E2E_HYMNAL or WORSHIP_REAL_DIR)`);

/** The slide the projector shows now: the topmost deck image. */
function projectedSlide(page: import("@playwright/test").Page): Promise<number | null> {
  return page.evaluate(() => {
    const last = [...document.querySelectorAll<HTMLImageElement>('img[src^="worship://deck/"]')].at(-1);
    const match = last ? /\/(\d+)$/.exec(last.src) : null;
    return match ? Number(match[1]) : null;
  });
}

test("hymn 522 finds its song, keeps its timings and advances with the music", async ({ app }) => {
  test.setTimeout(240_000);
  const [asset] = await app.invoke<MediaAsset[]>("library:add", { kind: "ppt", paths: [HYMN] });
  await app.previewFile("Presentaciones", "522");
  const preview = app.previewColumn();
  // Read whole: the bar's counter says so (the grid mounts only the tiles in view).
  await expect(preview.getByText("1/14", { exact: true })).toBeVisible({ timeout: 120_000 });
  // The song next to the file, and the timings the .pptx export dropped.
  await expect(preview.getByText("522 Suenen las palabras")).toBeVisible();
  await expect(preview.getByText("Auto-avance", { exact: true })).toBeVisible();
  // Read from the file itself, not converted: its own unrounded times.
  const deck = await app.invoke<DeckDTO>("deck:get", { assetId: asset!.id });
  expect(deck.timingsSource).toBe("binary");
  expect(deck.slides[0]?.advanceAfterMs).toBe(10_515);

  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await audioStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.5);
  await expect(app.liveColumn().getByText("522 (música)")).toBeVisible();
  expect(await projectedSlide(projector)).toBe(1);
  // 10.5 s on the first slide, on the music's beat: the slide turns when the song is there, not «within 20 s».
  expect((await msUntilChange(() => projectedSlide(projector), 1, 20_000)).value).toBe(2);
  const turnedAt = (await audioStates(projector))[0]?.currentTime ?? 0;
  expect(turnedAt).toBeGreaterThan(10.515 - 0.3);
  expect(turnedAt).toBeLessThan(10.515 + 0.3);

  // NEGRO stops the song AND the slides; uncovering picks both up together.
  await app.control.locator("body").press("b");
  await expect.poll(async () => (await audioStates(projector))[0]?.paused).toBe(true);
  const coveredAt = (await audioStates(projector))[0]?.currentTime ?? 0;
  await app.control.waitForTimeout(3000);
  await app.control.locator("body").press("b");
  await expect.poll(async () => (await audioStates(projector))[0]?.paused).toBe(false);
  expect(await projectedSlide(projector)).toBe(2);
  expect((await audioStates(projector))[0]?.currentTime).toBeGreaterThanOrEqual(coveredAt);
});

// Counting the transitions, half the sung hymnal's last slides outlast their song, as they do in PowerPoint
// (2026-11-22): the deck no longer ends with its music, its last slide keeps its own time. Hymn 101's song ends 0.9 s
// into slide 8, which then has 11.1 s left.
async function lastSlideOutlastsItsSong(app: WorshipApp): Promise<void> {
  test.setTimeout(240_000);
  const hymn = path.join(HYMNAL, "101.pps");
  test.skip(realMissing(hymn), `no ${hymn}`);
  await app.invoke<MediaAsset[]>("library:add", { kind: "ppt", paths: [hymn] });
  await app.previewFile("Presentaciones", "101");
  await expect(app.previewColumn().getByText("1/8", { exact: true })).toBeVisible({ timeout: 120_000 });
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await audioStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.5);
  // To the last seconds of the song: the slides follow the music there.
  await app.invoke("projection:mediaCommand", {
    target: { kind: "audio", trackId: "deck-soundtrack" },
    action: "seek",
    timeSeconds: 150,
  });
  await expect.poll(() => projectedSlide(projector), { timeout: 5_000 }).toBe(7);
  await expect.poll(() => projectedSlide(projector), { timeout: 15_000 }).toBe(8);
  // An ended element reads paused.
  await expect.poll(async () => (await audioStates(projector))[0]?.paused, { timeout: 10_000 }).toBe(true);
  const ended = performance.now();
  // No clock left to rejoin or count down from.
  await expect(app.liveColumn().getByRole("button", { name: "Resincronizar" })).toHaveCount(0);
  await expect(app.liveColumn().getByText(/Próxima en/)).toHaveCount(0);
  // LOGO and back over the slide left: the music stays over. Lifting the cover was a `play()` of the ended <audio>,
  // which started the hymn again from 0:00 under it.
  const logo = app.control.getByRole("button", { name: "LOGO", exact: true }).first();
  const covering = performance.now();
  await logo.click();
  await expect.poll(() => projectedSlide(projector)).toBeNull();
  await logo.click();
  await expect.poll(() => projectedSlide(projector)).toBe(8);
  const coveredMs = performance.now() - covering;
  await projector.waitForTimeout(1_000);
  const [music] = await audioStates(projector);
  expect(music?.paused).toBe(true);
  expect(music?.currentTime ?? 0).toBeGreaterThan(140);
  const off = await msUntilChange(() => projectedSlide(projector), 8, 20_000);
  // Taken off to the logo (`projection.deckEnd`) after the rest of slide 8's time, the cover not counted; it used to
  // go with the music.
  expect(off.value).toBeNull();
  const tail = performance.now() - ended - coveredMs;
  expect(tail).toBeGreaterThan(9_500);
  expect(tail).toBeLessThan(12_500);
}

test("a hymn whose last slide outlasts its song keeps it up for its own time, then ends", async ({ app }) => {
  await lastSlideOutlastsItsSong(app);
});

// Off, each slide cuts in where its transition would have started and the deck's clock stays the same (owner,
// 2026-11-25): the same song, the same last slide, the same end.
test("with the presentations' transitions off, a hymn whose last slide outlasts its song still ends on time", async ({ app }) => {
  await app.control.getByRole("button", { name: "Configuración" }).click();
  const settings = app.control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Diapositivas" }).click();
  await settings.getByRole("switch", { name: "Transiciones de las presentaciones" }).click();
  await expect(settings.getByRole("switch", { name: "Transiciones de las presentaciones" })).not.toBeChecked();
  await settings.getByRole("button", { name: "Volver" }).click();
  await expect(settings).toBeHidden();
  await lastSlideOutlastsItsSong(app);
});
