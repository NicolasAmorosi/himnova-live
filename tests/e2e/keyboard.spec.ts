import type { Page } from "@playwright/test";
import { expect, test, type WorshipApp } from "./support/app";

/**
 * After a mouse click on a thumbnail, the arrows are the operator's shortcuts
 * — ←/→ move what is LIVE, ↑/↓ move PREVIEW — exactly as after a click on any
 * other button (decided 2026-10-18). The grids walk their tiles with the
 * arrows only when reached from the keyboard.
 */

const previewTile = (app: WorshipApp, n: number) =>
  app.previewColumn().getByRole("list", { name: "Presentación" }).getByRole("button", { name: String(n), exact: true });
const liveTile = (app: WorshipApp, n: number) =>
  app.liveColumn().getByRole("list", { name: "Presentación" }).getByRole("button", { name: String(n), exact: true });

function projectedSlide(projector: Page): Promise<number | null> {
  return projector.evaluate(() => {
    const last = [...document.querySelectorAll<HTMLImageElement>('img[src^="worship://deck/"]')].at(-1);
    const match = last ? /\/(\d+)$/.exec(last.src) : null;
    return match ? Number(match[1]) : null;
  });
}

async function deckLive(app: WorshipApp) {
  await app.addMedia("ppt", "deck.pdf");
  await app.previewFile("Presentaciones", "deck");
  await expect(previewTile(app, 3)).toBeVisible({ timeout: 60_000 });
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projectedSlide(projector)).toBe(1);
  return projector;
}

const selectedPreviewSlide = (app: WorshipApp) =>
  app.previewColumn().getByRole("list", { name: "Presentación" }).locator('[aria-current="true"]').textContent();

test("→ after clicking a slide in PREVIEW advances the projector", async ({ app }) => {
  const projector = await deckLive(app);
  await previewTile(app, 2).click();
  await app.control.keyboard.press("ArrowRight");
  await expect.poll(() => projectedSlide(projector)).toBe(2);
});

test("→ after clicking a slide in the LIVE grid advances the projector from there", async ({ app }) => {
  const projector = await deckLive(app);
  await liveTile(app, 2).click();
  await expect.poll(() => projectedSlide(projector)).toBe(2);
  await app.control.keyboard.press("ArrowRight");
  await expect.poll(() => projectedSlide(projector)).toBe(3);
  await app.control.keyboard.press("ArrowLeft");
  await expect.poll(() => projectedSlide(projector)).toBe(2);
});

test("↓ after clicking a library tile moves PREVIEW, and Enter sends it", async ({ app }) => {
  await app.addMedia("ppt", "deck.pdf");
  await app.previewFile("Presentaciones", "deck");
  await expect(previewTile(app, 3)).toBeVisible({ timeout: 60_000 });
  await app.control.keyboard.press("ArrowDown");
  await expect.poll(() => selectedPreviewSlide(app)).toContain("2");
  await app.control.keyboard.press("Enter");
  await expect.poll(async () => projectedSlide(await app.projector())).toBe(2);
});

test("→ after clicking a verse in the LIVE grid steps the projected passage", async ({ app }) => {
  await app.openChapter("Juan 3");
  await app.control.getByRole("listitem").filter({ hasText: "Porque de tal manera amó Dios al mundo" }).click();
  await app.goLive();
  const projector = await app.projector();
  await app.liveColumn().getByRole("list", { name: "Biblia" }).getByRole("button", { name: / 16$/ }).click();
  await app.control.keyboard.press("ArrowRight");
  await expect(projector.getByText("Porque no envió Dios á su Hijo al mundo", { exact: false })).toBeVisible();
});

test("reached with the keyboard, the arrows still walk the grid", async ({ app }) => {
  const projector = await deckLive(app);
  // Tab into the PREVIEW grid: the tab stop is the selected tile.
  await previewTile(app, 1).focus();
  await app.control.keyboard.press("ArrowRight");
  await expect(previewTile(app, 2)).toBeFocused();
  // The projector did not move: these arrows were the grid's.
  expect(await projectedSlide(projector)).toBe(1);
});

test("a tile reached with the arrows and then clicked gives Enter back to EN VIVO", async ({ app }) => {
  const projector = await deckLive(app);
  await previewTile(app, 1).focus();
  await app.control.keyboard.press("ArrowRight");
  await expect(previewTile(app, 2)).toBeFocused();
  // Clicking the tile that already has focus moves no focus at all.
  await previewTile(app, 2).click();
  await app.control.keyboard.press("Enter");
  await expect.poll(() => projectedSlide(projector)).toBe(2);
});

/**
 * On the work screen the keys always work (owner, 2026-11-03): a clicked tab
 * or list, the projector window, a text field for the remote's keys, a key
 * held down. And a presentation remote is a keyboard sending PageDown/PageUp
 * for next/back and «.» for its blank-screen button.
 */
const bibleSearch = (app: WorshipApp) =>
  app.control
    .getByRole("tabpanel", { name: "Biblia" })
    .getByRole("textbox", { name: "Libro, capítulo y versículo…" });
const blackButton = (app: WorshipApp) => app.control.getByRole("button", { name: "NEGRO", exact: true }).first();

test("a remote's PageDown/PageUp step the projected deck, even while typing in a text field", async ({ app }) => {
  const projector = await deckLive(app);
  await app.control.keyboard.press("PageDown");
  await expect.poll(() => projectedSlide(projector)).toBe(2);
  // The operator types the next verse while the preacher holds the remote.
  await app.openResources("Biblia");
  await bibleSearch(app).fill("Jua");
  await app.control.keyboard.press("PageDown");
  await expect.poll(() => projectedSlide(projector)).toBe(3);
  await app.control.keyboard.press("PageUp");
  await expect.poll(() => projectedSlide(projector)).toBe(2);
  await expect(bibleSearch(app)).toBeFocused();
  await expect(bibleSearch(app)).toHaveValue("Jua");
});

test("the remote's «.» is NEGRO; in a text field it types, and Escape gives the keys back", async ({ app }) => {
  const projector = await deckLive(app);
  await app.control.keyboard.press(".");
  await expect.poll(() => projectedSlide(projector)).toBeNull();
  await app.control.keyboard.press(".");
  await expect.poll(() => projectedSlide(projector)).toBe(1);

  await app.openResources("Biblia");
  await bibleSearch(app).click();
  await app.control.keyboard.press(".");
  await expect(bibleSearch(app)).toHaveValue(".");
  await app.control.keyboard.press("ArrowRight");
  expect(await projectedSlide(projector)).toBe(1);

  await app.control.keyboard.press("Escape");
  await expect(bibleSearch(app)).not.toBeFocused();
  await app.control.keyboard.press("ArrowRight");
  await expect.poll(() => projectedSlide(projector)).toBe(2);
});

test("→ after clicking a resource tab, or choosing in a list with the mouse, advances the projector", async ({ app }) => {
  const projector = await deckLive(app);
  await app.openResources("Biblia");
  await app.control.keyboard.press("ArrowRight");
  await expect.poll(() => projectedSlide(projector)).toBe(2);
  await expect(app.control.getByRole("tab", { name: "Biblia" })).toHaveAttribute("aria-selected", "true");

  // A book chosen with the mouse in the Bible tab's own list.
  await app.control.getByRole("tabpanel", { name: "Biblia" }).getByRole("combobox").nth(1).click();
  await app.control.getByRole("listbox").getByRole("option").first().click();
  await app.control.keyboard.press("ArrowRight");
  await expect.poll(() => projectedSlide(projector)).toBe(3);
  await app.control.keyboard.press("ArrowLeft");
  await expect.poll(() => projectedSlide(projector)).toBe(2);
});

/** A key on the projector window through the real input path. Playwright's own
 *  keyboard reaches a page over CDP, which skips `before-input-event` — the
 *  hook main forwards the projector's keys from (measured: never fired). */
function pressOnProjector(app: WorshipApp, keyCode: string): Promise<void> {
  return app.electron.evaluate(({ BrowserWindow }, code) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/projection.html"));
    win?.webContents.sendInputEvent({ type: "keyDown", keyCode: code });
    win?.webContents.sendInputEvent({ type: "keyUp", keyCode: code });
  }, keyCode);
}

test("keys pressed while the projector window has the keyboard reach the control window", async ({ app }) => {
  const projector = await deckLive(app);
  await pressOnProjector(app, "Right");
  await expect.poll(() => projectedSlide(projector)).toBe(2);
  await pressOnProjector(app, "PageUp");
  await expect.poll(() => projectedSlide(projector)).toBe(1);
  await pressOnProjector(app, ".");
  await expect(blackButton(app)).toHaveAttribute("aria-pressed", "true");
});

test("held down, B toggles NEGRO once", async ({ app }) => {
  await deckLive(app);
  // A second `down` without an `up` is an auto-repeat.
  await app.control.keyboard.down("b");
  await app.control.keyboard.down("b");
  await app.control.keyboard.down("b");
  await app.control.keyboard.down("b");
  await app.control.keyboard.up("b");
  await expect(blackButton(app)).toHaveAttribute("aria-pressed", "true");
  // Settled, not caught mid-flicker: unguarded, four presses end with it off.
  await app.control.waitForTimeout(500);
  await expect(blackButton(app)).toHaveAttribute("aria-pressed", "true");
});

test("a remote's F5 and Esc, on either window, change nothing on the projector (owner, 2026-11-03)", async ({ app }) => {
  // A remote's «start/end slideshow»: there is no slideshow to start or end here.
  const projector = await deckLive(app);
  for (const key of ["F5", "Escape"]) {
    await app.control.locator("body").press(key);
    await pressOnProjector(app, key);
  }
  await app.control.waitForTimeout(600);
  expect(await projectedSlide(projector)).toBe(1);
  await expect(blackButton(app)).not.toHaveAttribute("aria-pressed", "true");
  expect(app.hasProjector()).toBe(true);
});
