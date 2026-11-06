import type { Locator, Page } from "@playwright/test";
import { expect, relaunch, test, type WorshipApp } from "./support/app";

// The one spec that starts like a church's first launch: with the look.
test.use({ starterLook: true });

/** The projector draws a background from the library: a still or a loop. */
const libraryBackground = (projector: Page) =>
  projector.locator('img[src^="worship://asset/"], video[src^="worship://asset/"], canvas').first();

/** Written in the editor and put in PREVIEW, as `songs.spec.ts` does. */
async function previewSong(app: WorshipApp, title: string, lyrics: string): Promise<void> {
  await app.openResources("Canciones");
  const tab = app.control.getByRole("tabpanel", { name: "Canciones" });
  const editor = app.control.getByRole("dialog").last();
  await tab.getByRole("button", { name: "Nueva canción" }).first().click();
  await editor.getByRole("textbox", { name: "Título" }).fill(title);
  await editor.getByRole("textbox", { name: "Letra" }).fill(lyrics);
  await editor.getByRole("button", { name: "Guardar", exact: true }).click();
  await editor.getByRole("button", { name: "Cerrar" }).first().click();
  await expect(app.control.getByRole("dialog")).toHaveCount(0);
  await tab.getByRole("list", { name: "Canciones" }).getByRole("listitem").filter({ hasText: title }).click();
}

test("a new church starts with backgrounds, song themes, a dressed verse and time scenes, and overlays", async ({ app }) => {
  // The backgrounds, in the library under their names.
  await app.openResources("Medios", "Imágenes");
  const images = app.control.getByRole("tabpanel", { name: "Imágenes" });
  for (const name of ["Noche", "Amanecer", "Océano", "Atardecer", "Bosque", "Brasas", "Grafito", "Cielo"]) {
    await expect(images.getByRole("button", { name }).first()).toBeVisible();
  }
  await app.openResources("Medios", "Videos");
  await expect(app.control.getByRole("tabpanel", { name: "Videos" }).getByRole("button", { name: "Océano" }).first()).toBeVisible();

  // A song without a theme of its own sings over the first new one.
  await previewSong(app, "Sublime gracia", "Sublime gracia del Señor");
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText("Sublime gracia del Señor")).toBeVisible();
  await expect(libraryBackground(projector)).toBeVisible();

  // The verse, over the quiet night.
  await app.openChapter("Juan 3");
  await app.control.getByRole("listitem").filter({ hasText: /de tal manera amó Dios al mundo/ }).click();
  await app.goLive();
  await expect(projector.getByText(/Porque de tal manera amó Dios al mundo/)).toBeVisible();
  await expect(libraryBackground(projector)).toBeVisible();

  // The time scenes, and three overlays to fill in.
  await app.openResources("Funciones", "Placas");
  for (const name of ["Zócalo con nombre", "Banner de anuncios", "Mosca con el nombre"]) {
    await expect(app.control.getByText(name, { exact: true })).toBeVisible();
  }
});

test("a factory theme edited and another deleted stay that way after a restart, which brings the look again", async ({ app }) => {
  const openThemes = async (on: WorshipApp) => {
    await on.openResources("Canciones");
    await on.control.getByRole("tabpanel", { name: "Canciones" }).getByRole("button", { name: "Temas" }).click();
    const editor = on.control.getByRole("dialog", { name: "Temas" });
    return { editor, rows: editor.getByRole("list", { name: "Temas guardados" }).getByRole("listitem") };
  };
  const capitals = (editor: Locator) =>
    editor.getByRole("group", { name: "Mayúsculas", exact: true }).getByRole("switch");

  const { editor, rows } = await openThemes(app);
  const count = await rows.count();
  expect(count).toBeGreaterThanOrEqual(2);
  await rows.first().click();
  await capitals(editor).click();
  await editor.getByRole("button", { name: "Guardar", exact: true }).click();
  await rows.last().click();
  const deleted = await editor.getByRole("textbox", { name: "Nombre", exact: true }).inputValue();
  await editor.getByRole("button", { name: "Más acciones" }).click();
  await app.control.getByRole("menuitem", { name: "Eliminar", exact: true }).click();
  await app.control.getByRole("dialog", { name: "¿Eliminar este tema?" }).getByRole("button", { name: "Eliminar", exact: true }).click();
  await expect(rows).toHaveCount(count - 1);
  await editor.getByRole("button", { name: "Cerrar" }).first().click();
  await app.quit();

  // Every launch brings the look to what is still factory: never back to what the church changed or took away.
  const again = await openThemes(await relaunch(app));
  await expect(again.rows).toHaveCount(count - 1);
  await expect(again.rows.filter({ hasText: deleted })).toHaveCount(0);
  await again.rows.first().click();
  await expect(capitals(again.editor)).toBeChecked();
});

test("the «Noche» image LOGO and the verse are drawn over goes only after a warning naming them, and leaves nothing broken (owner, 2026-11-06)", async ({
  app,
}) => {
  await app.openResources("Medios", "Imágenes");
  const images = app.control.getByRole("tabpanel", { name: "Imágenes" });
  await images.getByRole("button", { name: "Noche" }).first().click();
  await images.getByRole("button", { name: "Quitar", exact: true }).click();
  // In use as a background: refused, with a way through whose question names the looks drawn over it.
  await app.control.getByRole("status").filter({ hasText: "se usa como fondo" }).getByRole("button", { name: "Quitar igualmente" }).click();
  const confirm = app.control.getByRole("dialog", { name: "¿Quitar igualmente?" });
  await expect(confirm.getByText("Fondo del LOGO")).toBeVisible();
  await expect(confirm.getByText("Fondo del versículo")).toBeVisible();
  await confirm.getByRole("button", { name: "Quitar igualmente" }).click();
  await expect(images.getByRole("button", { name: "Noche" })).toHaveCount(0);

  // LOGO and the verse go on without it, never drawing a picture that is gone.
  const broken = (projector: Page) =>
    projector.evaluate(() => [...document.images].filter((img) => img.complete && img.naturalWidth === 0).map((img) => img.src));
  await app.control.getByRole("button", { name: "LOGO", exact: true }).first().click();
  const projector = await app.projector();
  await projector.waitForTimeout(800);
  expect(await broken(projector)).toEqual([]);

  await app.openChapter("Juan 3");
  await app.control.getByRole("listitem").filter({ hasText: /de tal manera amó Dios al mundo/ }).click();
  await app.goLive();
  await expect(projector.getByText(/Porque de tal manera amó Dios al mundo/)).toBeVisible();
  await projector.waitForTimeout(800);
  expect(await broken(projector)).toEqual([]);
});
