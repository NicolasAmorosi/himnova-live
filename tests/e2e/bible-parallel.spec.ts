import fs from "node:fs";
import path from "node:path";
import { expect, relaunch, test, type WorshipApp } from "./support/app";
import type { Locator } from "@playwright/test";

const JUAN_3_16 = "Porque de tal manera amó Dios al mundo";
const JUAN_3_17 = "Porque no envió Dios á su Hijo al mundo";
const JOHN_3_16 = "For God so loved the world.";
const JOHN_3_17 = "For God did not send his Son into the world to judge the world.";

/** A second version, in another language: what «En paralelo» is for. */
async function importEnglish(app: WorshipApp) {
  const file = path.join(app.profile, "English.xml");
  fs.writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>
<XMLBIBLE biblename="English">
  <BIBLEBOOK bnumber="43" bname="John">
    <CHAPTER cnumber="3">
      <VERS vnumber="16">${JOHN_3_16}</VERS>
      <VERS vnumber="17">${JOHN_3_17}</VERS>
    </CHAPTER>
  </BIBLEBOOK>
</XMLBIBLE>`,
  );
  await app.control.getByRole("button", { name: "Configuración" }).click();
  const settings = app.control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Biblia" }).click();
  await app.answerOpenDialog(file);
  await settings.getByRole("button", { name: "Importar", exact: true }).click();
  await expect(app.control.getByRole("status").filter({ hasText: "Se importó English" })).toBeVisible();
  await settings.getByRole("button", { name: "Volver" }).click();
}

/** Both columns of a monitor's verse: the two verses start on the same line,
 *  each with its own reference in its own language. */
async function expectSideBySide(monitor: Locator, texts: [string, string], references: [string, string]) {
  // The last: during a scene's fade the verse leaving is still there, under it.
  const block = monitor.locator("[data-bible-parallel]").last();
  for (const text of [...texts, ...references]) await expect(block).toContainText(text);
  const verses = block.locator('p[dir="auto"]');
  await expect(verses).toHaveCount(2);
  const [left, right] = [await verses.nth(0).boundingBox(), await verses.nth(1).boundingBox()];
  expect(left && right && Math.abs(left.y - right.y) < 1 && left.x < right.x).toBe(true);
}

test("«En paralelo»: a verse of the tab and a schedule row go out in two versions side by side, after a restart too", async ({
  app,
}) => {
  const { control } = app;
  await importEnglish(app);
  await app.openChapter("Juan 3");
  const tab = control.getByRole("tabpanel", { name: "Biblia" });
  await tab.getByRole("listitem").filter({ hasText: JUAN_3_16 }).click();
  await expect(app.previewColumn().locator("[data-bible-parallel]")).toHaveCount(0);

  // Chosen with a verse in PREVIEW: PREVIEW shows it at once.
  await tab.getByRole("button", { name: "En paralelo" }).click();
  await control.getByRole("menuitemradio", { name: "English" }).click();
  await expectSideBySide(app.previewColumn(), [JUAN_3_16, JOHN_3_16], ["Juan 3:16", "John 3:16"]);

  await app.goLive();
  await expectSideBySide(app.liveColumn(), [JUAN_3_16, JOHN_3_16], ["Juan 3:16", "John 3:16"]);
  const projector = await app.projector();
  await expectSideBySide(projector.locator("body"), [JUAN_3_16, JOHN_3_16], ["Juan 3:16", "John 3:16"]);

  // A schedule row: its passage looked up in the parallel version as it goes live.
  await tab.getByRole("listitem").filter({ hasText: JUAN_3_17 }).click();
  await tab.getByRole("button", { name: "Agregar al programa" }).click();
  await control.getByRole("main").getByRole("list").first().getByRole("listitem").filter({ hasText: "Juan 3:17" }).click();
  await app.goLive();
  await expectSideBySide(app.liveColumn(), [JUAN_3_17, JOHN_3_17], ["Juan 3:17", "John 3:17"]);

  // The choice is kept.
  await app.quit();
  const again = await relaunch(app);
  await again.openChapter("Juan 3");
  await again.control.getByRole("tabpanel", { name: "Biblia" }).getByRole("listitem").filter({ hasText: JUAN_3_16 }).click();
  await again.goLive();
  await expectSideBySide(again.liveColumn(), [JUAN_3_16, JOHN_3_16], ["Juan 3:16", "John 3:16"]);

  // «Ninguna» brings the one column back.
  await again.control.getByRole("tabpanel", { name: "Biblia" }).getByRole("button", { name: "En paralelo" }).click();
  await again.control.getByRole("menuitemradio", { name: "Ninguna" }).click();
  await again.control.getByRole("tabpanel", { name: "Biblia" }).getByRole("listitem").filter({ hasText: JUAN_3_17 }).dblclick();
  await expect(again.liveColumn().getByText(JUAN_3_17, { exact: false }).first()).toBeVisible();
  await expect(again.liveColumn().locator("[data-bible-parallel]")).toHaveCount(0);
});
