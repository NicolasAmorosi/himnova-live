import type { Page } from "@playwright/test";
import { parseLyrics } from "../../src/shared/song-text";
import { DEFAULT_SONG_THEME } from "../../src/shared/types/song";
import { expect, relaunch, test, type WorshipApp } from "./support/app";

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

test("a song's chords show on the stage screen, over its words, and never on the projector", async ({ app }) => {
  const opened = app.electron.waitForEvent("window", { predicate: isStage });
  await chooseStageScreen(app, 1);
  const stage = await opened;
  await stage.waitForLoadState("domcontentloaded");

  // Written in the editor with its chords inline, as ChordPro writes them.
  await app.openResources("Canciones");
  const tab = app.control.getByRole("tabpanel", { name: "Canciones" });
  await tab.getByRole("button", { name: "Nueva canción" }).first().click();
  const editor = app.control.getByRole("dialog").last();
  await editor.getByRole("textbox", { name: "Título" }).fill("Cuán grande es Él");
  await editor.getByRole("textbox", { name: "Letra" }).fill("[Estrofa 1]\n[G]Señor mi [C]Dios\n\n[Coro]\n[D]Mi corazón");
  await editor.getByRole("button", { name: "Guardar", exact: true }).click();
  await editor.getByRole("button", { name: "Cerrar" }).first().click();
  await tab.getByRole("list", { name: "Canciones" }).getByRole("listitem").filter({ hasText: "Cuán grande" }).click();
  await app.goLive();

  const projector = await app.projector();
  await expect(projector.getByText("Señor mi Dios")).toBeVisible();
  await expect(projector.locator("[data-song-chord]")).toHaveCount(0);
  // The live slide's chords, and the next slide's.
  await expect(stage.locator("[data-song-chord]")).toHaveText(["G ", "C ", "D "]);
  await stage.screenshot({ path: process.env["STAGE_SHOT"] ?? test.info().outputPath("stage.png") });
});

test("a song's video background is drawn on the stage screen as its still, never as a second copy of the video", async ({
  app: first,
}) => {
  const [clip] = await first.addMedia("video", "clip.mp4");
  if (!clip) throw new Error("import failed");
  // A song on a theme over the video, written through IPC: the window loads songs and themes when it starts.
  const theme = await first.invoke<{ id: number }>("songTheme:create", {
    name: "Con video",
    style: { ...DEFAULT_SONG_THEME, background: { kind: "video", assetId: clip.id, fit: "cover" } },
  });
  await first.invoke("song:create", {
    title: "Fondo",
    number: null,
    authors: null,
    copyright: null,
    ccliNumber: null,
    notes: null,
    sections: parseLyrics("[Estrofa 1]\nuno\n\n[Coro]\ncoro", "es").sections,
    order: [],
    themeId: theme.id,
  });
  await first.quit();
  const app = await relaunch(first);

  const opened = app.electron.waitForEvent("window", { predicate: isStage });
  await chooseStageScreen(app, 1);
  const stage = await opened;
  await stage.waitForLoadState("domcontentloaded");
  await app.openResources("Canciones");
  await app.control.getByRole("tabpanel", { name: "Canciones" }).getByRole("listitem").first().click();
  await app.goLive();
  await expect(stage.getByText("uno", { exact: true })).toBeVisible();
  await expect(stage.getByText("coro", { exact: true })).toBeVisible();
  // The stage plays nothing: a second decoder of the same file for a screen the musicians read.
  await app.control.waitForTimeout(1000);
  await expect(stage.locator("[data-song-video] video")).toHaveCount(0);
});
