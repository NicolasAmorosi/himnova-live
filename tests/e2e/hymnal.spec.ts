import path from "node:path";
import type { DeckDTO } from "../../src/shared/types/deck";
import type { MediaAsset } from "../../src/shared/types/media";
import { realMissing, realPath } from "../fixtures/real-material";
import { audioStates, expect, msUntilChange, test } from "./support/app";

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
