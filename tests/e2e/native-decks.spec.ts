import type { Page } from "@playwright/test";
import type { DeckDTO } from "../../src/shared/types/deck";
import { expect, test } from "./support/app";

/**
 * A legacy `.pps` made of pictures — what the hymnal is — read straight from
 * the file (`ppt-binary.ts`): no conversion, nothing copied.
 * And each slide entering the way the file says, only when the deck moves
 * forward (decided by the owner, 2026-10-26).
 */

/** Every slide image on the projector: one at rest, two during a fade, one
 *  per bar (plus the slide leaving) while random bars come in. */
function deckImages(projector: Page): Promise<number> {
  return projector.evaluate(() => document.querySelectorAll('img[src^="worship://deck/"]').length);
}

function projectedSlide(projector: Page): Promise<number | null> {
  return projector.evaluate(() => {
    const last = [...document.querySelectorAll<HTMLImageElement>('img[src^="worship://deck/"]')].at(-1);
    const match = last ? /\/(\d+)$/.exec(last.src) : null;
    return match ? Number(match[1]) : null;
  });
}

test("a hymn made of pictures is read straight from the file, and each slide enters as the file says", async ({ app }) => {
  const [asset] = await app.addMedia("ppt", "legacy-hymn.pps");

  await app.previewFile("Presentaciones", "legacy-hymn");
  const grid = app.previewColumn().getByRole("list", { name: "Presentación" });
  await expect(grid.getByRole("button", { name: "3", exact: true })).toBeAttached();
  const deck = await app.invoke<DeckDTO>("deck:get", { assetId: asset!.id });
  expect(deck.timingsSource).toBe("binary");
  expect(deck.slides.map((slide) => slide.transition)).toEqual([
    null,
    { style: "crossfade", durationMs: 1000 },
    { style: "random-bars-vertical", durationMs: 500 },
  ]);

  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projectedSlide(projector)).toBe(1);
  // The first slide carries the logo, so it is composed from the file's two
  // pictures; it still has to have loaded on the projector.
  await expect
    .poll(() => projector.evaluate(() => document.querySelector<HTMLImageElement>('img[src$="/1"]')?.naturalWidth ?? 0))
    .toBeGreaterThan(0);

  // Forward onto a slow fade: both slides are on the stage for a moment.
  await app.control.locator("body").press("ArrowRight");
  await expect.poll(() => deckImages(projector), { intervals: [20] }).toBe(2);
  await expect.poll(() => deckImages(projector)).toBe(1);
  expect(await projectedSlide(projector)).toBe(2);

  // Forward onto random bars: the slide arriving is drawn once per bar.
  await app.control.locator("body").press("ArrowRight");
  await expect.poll(() => deckImages(projector), { intervals: [20] }).toBeGreaterThan(30);
  await expect.poll(() => deckImages(projector)).toBe(1);
  expect(await projectedSlide(projector)).toBe(3);

  // Back is a cut: never two slides on the stage.
  await app.control.locator("body").press("ArrowLeft");
  await expect.poll(() => projectedSlide(projector)).toBe(2);
  for (let i = 0; i < 5; i++) {
    expect(await deckImages(projector)).toBe(1);
    await projector.waitForTimeout(60);
  }
});
