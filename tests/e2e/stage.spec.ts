import type { Page } from "@playwright/test";
import { expect, test, type WorshipApp } from "./support/app";

const JUAN_3_16 = "Porque de tal manera amó Dios al mundo";
const JUAN_3_17 = "Porque no envió Dios á su Hijo al mundo";

const isStage = (page: Page) => page.url().endsWith("/stage.html");

/** Picks the stage screen in Ajustes ▸ Proyección: `index` 0 is «Ninguna»,
 *  1 the first screen (on a one-screen machine, the operator's own). */
async function chooseStageScreen(app: WorshipApp, index: number): Promise<void> {
  await app.control.getByRole("button", { name: "Configuración" }).click();
  const settings = app.control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Proyección" }).click();
  await settings.getByRole("combobox", { name: "Pantalla de escenario" }).click();
  await app.control.getByRole("option").nth(index).click();
  await app.control.keyboard.press("Escape");
}

test("the stage screen shows the live verse and the next, and keeps it under NEGRO", async ({ app }) => {
  const opened = app.electron.waitForEvent("window", { predicate: isStage });
  await chooseStageScreen(app, 1);
  const stage = await opened;
  await stage.waitForLoadState("domcontentloaded");
  // The time, before anything is live.
  await expect(stage.locator("time")).toHaveText(/\d{1,2}:\d{2}/);

  await app.openChapter("Juan 3");
  await app.control.getByRole("listitem").filter({ hasText: JUAN_3_16 }).click();
  await app.goLive();
  await expect(stage.getByText(JUAN_3_16, { exact: false })).toBeVisible();
  await expect(stage.getByText(JUAN_3_17, { exact: false })).toBeVisible();

  await app.control.getByRole("button", { name: "NEGRO", exact: true }).click();
  await expect(stage.getByText("NEGRO", { exact: true })).toBeVisible();
  await expect(stage.getByText(JUAN_3_16, { exact: false })).toBeVisible();

  // «Ninguna» closes it.
  const closed = stage.waitForEvent("close");
  await chooseStageScreen(app, 0);
  await closed;
  expect(app.electron.windows().some(isStage)).toBe(false);
});
