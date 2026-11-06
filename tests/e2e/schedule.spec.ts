import type { Locator } from "@playwright/test";
import { fixture } from "./support/paths";
import { audioStates, expect, relaunch, test, videoStates, type WorshipApp } from "./support/app";

/** Picks a library file and adds it to the order of service with the panel's
 *  own «Agregar al programa». */
async function addToSchedule(app: WorshipApp, tab: "Videos" | "Imágenes", name: string) {
  await app.previewFile(tab, name);
  await app.control.getByRole("tabpanel", { name: tab }).getByRole("button", { name: "Agregar al programa" }).click();
}

const scheduleRows = (app: WorshipApp) =>
  app.control.getByRole("main").getByRole("list").first().getByRole("listitem");

async function buildSchedule(app: WorshipApp) {
  await app.addMedia("video", "clip.mp4");
  await app.addMedia("image", "photo.png");
  await addToSchedule(app, "Videos", "clip");
  await addToSchedule(app, "Imágenes", "photo");
  await expect(scheduleRows(app)).toHaveText([/1\s*clip/, /2\s*photo/]);
}

test("an order of service is built, saved, cleared and opened again", async ({ app }) => {
  const { control } = app;
  await buildSchedule(app);
  await expect(control.getByText("No guardado")).toBeVisible();

  await control.getByRole("button", { name: "Guardar", exact: true }).click();
  const dialog = control.getByRole("dialog", { name: "Programas" });
  await dialog.getByRole("textbox", { name: "Nombre" }).fill("Culto de prueba");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).last().click();
  await expect(control.getByText("\"Culto de prueba\" guardado")).toBeVisible();
  await dialog.getByRole("button", { name: "Cerrar" }).click();
  await expect(control.getByText("No guardado")).toHaveCount(0);

  await control.getByRole("button", { name: "Nuevo programa" }).first().click();
  await expect(control.getByText("Programa vacío")).toBeVisible();

  await control.getByRole("button", { name: "Administrar programas" }).click();
  await dialog.getByRole("listitem").filter({ hasText: "Culto de prueba" }).click();
  await dialog.getByRole("button", { name: "Abrir" }).click();
  await expect(scheduleRows(app)).toHaveText([/1\s*clip/, /2\s*photo/]);
});

test("PREVIEW stays on the selected row when the schedule is reordered", async ({ app }) => {
  const { control } = app;
  await buildSchedule(app);
  await scheduleRows(app).filter({ hasText: "photo" }).click();
  await control.getByRole("button", { name: "Mover arriba" }).click();
  await expect(scheduleRows(app)).toHaveText([/1\s*photo/, /2\s*clip/]);

  // The photo moved, and PREVIEW — and so EN VIVO — moved with it.
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.locator('img[src^="worship://asset/"]')).toBeVisible();
  expect(await videoStates(projector)).toEqual([]);
});

test("double-clicking a row sends it live", async ({ app }) => {
  await buildSchedule(app);
  await scheduleRows(app).filter({ hasText: "clip" }).dblclick();
  const projector = await app.projector();
  await expect.poll(async () => (await videoStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.3);
});

test("an unsaved order of service survives closing the app", async ({ app }) => {
  await buildSchedule(app);
  // The close guard asks, because the schedule was never saved.
  await app.quit("close");

  const again = await relaunch(app);
  await expect(again.control.getByText("Se recuperó el programa que estabas armando")).toBeVisible();
  await expect(scheduleRows(again)).toHaveText([/1\s*clip/, /2\s*photo/]);
});

test("quitting with something on the projector asks, and «Cancelar» keeps it on", async ({ app }) => {
  const { control } = app;
  await app.addMedia("image", "photo.png");
  await app.previewFile("Imágenes", "photo");
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.locator('img[src^="worship://asset/"]')).toBeVisible();

  // Nothing unsaved — the only reason to ask is the screen.
  const quitting = app.quit("cancel");
  await expect(control.getByRole("dialog")).toContainText("¿Cerrar la app?");
  await quitting;
  await control.waitForTimeout(500);
  expect(app.hasProjector()).toBe(true);
  await expect(projector.locator('img[src^="worship://asset/"]')).toBeVisible();

  await app.quit("close");
});

const JUAN_3_16 = "Porque de tal manera amó Dios al mundo";
const row = (app: WorshipApp, text: string) => scheduleRows(app).filter({ hasText: text });
/** The on-air rail of a schedule row (`ListRow`'s `active`). */
const rail = (locator: Locator) => locator.locator("span.bg-on-air");
const undo = (app: WorshipApp) =>
  app.control.getByRole("status").filter({ hasText: "Se quitó del programa" }).last().getByRole("button", { name: "Deshacer" });

/** Files picked in the schedule's own «Agregar medios». */
async function addAll(app: WorshipApp, ...names: string[]) {
  await app.answerOpenDialog(...names.map(fixture));
  await app.control.getByRole("button", { name: "Agregar medios" }).click();
}

async function saveAs(app: WorshipApp, name: string) {
  await app.control.getByRole("button", { name: "Guardar", exact: true }).click();
  const programs = app.control.getByRole("dialog", { name: "Programas" });
  await programs.getByRole("textbox", { name: "Nombre" }).fill(name);
  await programs.getByRole("button", { name: "Guardar", exact: true }).last().click();
  await expect(app.control.getByRole("status").filter({ hasText: `"${name}" guardado` })).toBeVisible();
  await programs.getByRole("button", { name: "Cerrar" }).click();
}

test("removing the live row leaves the projector as it is; «Deshacer» brings its rail back only while it is still what is shown", async ({
  app,
}) => {
  await addAll(app, "deck.pdf", "clip.mp4");
  await expect(scheduleRows(app)).toHaveText([/deck/, /clip/]);
  await row(app, "clip").dblclick();
  const projector = await app.projector();
  await expect.poll(async () => (await videoStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.3);
  await expect(rail(row(app, "clip"))).toHaveCount(1);

  await row(app, "clip").click();
  await app.control.keyboard.press("Delete");
  await expect(scheduleRows(app)).toHaveText([/deck/]);
  await app.control.waitForTimeout(500);
  expect((await videoStates(projector))[0]?.paused).toBe(false);
  await expect(rail(row(app, "deck"))).toHaveCount(0);
  // Still on the projector, so back on air.
  await undo(app).click();
  await expect(scheduleRows(app)).toHaveText([/deck/, /clip/]);
  await expect(rail(row(app, "clip"))).toHaveCount(1);

  // Removed again, and the deck goes live before «Deshacer»: the rail stays with what is shown.
  await row(app, "clip").click();
  await app.control.keyboard.press("Delete");
  await expect(scheduleRows(app)).toHaveText([/deck/]);
  await row(app, "deck").dblclick();
  await expect(projector.locator('img[src^="worship://deck/"]').first()).toBeVisible();
  await expect(rail(row(app, "deck"))).toHaveCount(1);
  await undo(app).click();
  await expect(scheduleRows(app)).toHaveText([/deck/, /clip/]);
  await expect(rail(row(app, "clip"))).toHaveCount(0);
  await expect(rail(row(app, "deck"))).toHaveCount(1);
});

test("a drag that reorders OTHER rows leaves PREVIEW and Enter on the row the operator picked", async ({ app }) => {
  await addAll(app, "clip.mp4", "photo.png", "song.mp3");
  await expect(scheduleRows(app)).toHaveText([/clip/, /photo/, /song/]);
  await row(app, "photo").click();
  await expect(row(app, "photo")).toHaveAttribute("aria-current", "true");
  // Tidying the list: «song» moved to the top.
  await row(app, "song").dragTo(row(app, "clip"));
  await expect(scheduleRows(app)).toHaveText([/song/, /clip/, /photo/]);
  await expect(row(app, "photo")).toHaveAttribute("aria-current", "true");
  await app.control.keyboard.press("Enter");
  const projector = await app.projector();
  await expect(projector.locator('img[src^="worship://asset/"]')).toBeVisible();
  expect(await audioStates(projector)).toEqual([]);
});

test("Enter pressed twice on a video row keeps one video on the projector", async ({ app }) => {
  await addAll(app, "clip.mp4");
  await row(app, "clip").click();
  await app.control.keyboard.press("Enter");
  await app.control.keyboard.press("Enter");
  const projector = await app.projector();
  await expect.poll(async () => (await videoStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.5);
  await app.control.waitForTimeout(800);
  expect((await videoStates(projector)).filter((video) => video.opacity > 0)).toHaveLength(1);
});

test("a saved program in use, never edited, is still the schedule after a restart mid-service", async ({ app }) => {
  await addAll(app, "clip.mp4", "photo.png");
  await saveAs(app, "Culto A");
  await row(app, "photo").dblclick();
  await expect((await app.projector()).locator('img[src^="worship://asset/"]')).toBeVisible();
  await app.quit("close");
  const again = await relaunch(app);
  await expect(scheduleRows(again)).toHaveText([/clip/, /photo/]);
});

test("an unsaved schedule with a verse and a time scene comes back after a restart, and both still go live", async ({ app }) => {
  const { control } = app;
  await app.openChapter("Juan 3");
  await control.getByRole("tabpanel", { name: "Biblia" }).getByRole("listitem").filter({ hasText: JUAN_3_16 }).click();
  await control.getByRole("tabpanel", { name: "Biblia" }).getByRole("button", { name: "Agregar al programa" }).click();
  await app.openResources("Funciones", "Utilidades");
  await control.getByRole("list", { name: "Escenas de tiempo" }).getByRole("listitem").filter({ hasText: "Reloj" }).click();
  await control.getByRole("tabpanel", { name: "Utilidades" }).getByRole("button", { name: "Agregar al programa" }).click();
  await expect(scheduleRows(app)).toHaveText([/Juan 3:16/, /Reloj/]);
  await app.quit("close");

  const again = await relaunch(app);
  await expect(scheduleRows(again)).toHaveText([/Juan 3:16/, /Reloj/]);
  await row(again, "Juan 3:16").dblclick();
  const projector = await again.projector();
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toBeVisible();
  await row(again, "Reloj").dblclick();
  await expect(projector.locator("body")).toContainText(/\d{1,2}:\d{2}/);
});
