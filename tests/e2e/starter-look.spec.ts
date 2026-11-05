import type { Page } from "@playwright/test";
import { expect, test, type WorshipApp } from "./support/app";

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
