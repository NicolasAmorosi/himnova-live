import { fixture } from "./support/paths";
import { expect, test, type WorshipApp } from "./support/app";

/**
 * The order of service and the saved programs: everything an operator does to
 * a schedule before and between services. What is projected from it is in
 * `schedule.spec.ts` and `service.spec.ts`.
 */

const scheduleSection = (app: WorshipApp) =>
  app.control.locator("section").filter({ has: app.control.getByRole("heading", { name: "Programa", exact: true }) });
const rows = (app: WorshipApp) => scheduleSection(app).getByRole("list").first().getByRole("listitem");
const toast = (app: WorshipApp, text: string) => app.control.getByRole("status").filter({ hasText: text });
const manager = (app: WorshipApp) => app.control.getByRole("dialog", { name: "Programas" });
const programRow = (app: WorshipApp, name: string) =>
  manager(app).getByRole("listitem").filter({ has: app.control.getByText(name, { exact: true }) });

/** «Vaciar» is the trash icon at the foot of the schedule's tool strip (2026-11-05). */
async function clearSchedule(app: WorshipApp) {
  await scheduleSection(app).getByRole("button", { name: "Vaciar", exact: true }).click();
}

async function addAll(app: WorshipApp, ...names: string[]) {
  await app.answerOpenDialog(...names.map(fixture));
  await scheduleSection(app).getByRole("button", { name: "Agregar medios" }).click();
}

async function saveAs(app: WorshipApp, name: string) {
  await app.control.getByRole("button", { name: "Guardar", exact: true }).click();
  await manager(app).getByRole("textbox", { name: "Nombre" }).fill(name);
  await manager(app).getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(toast(app, `"${name}" guardado`)).toBeVisible();
  await manager(app).getByRole("button", { name: "Cerrar" }).click();
}

test("«Agregar medios» adds files of every kind in one pick", async ({ app }) => {
  await addAll(app, "clip.mp4", "photo.png", "song.mp3", "deck.pdf");
  await expect(rows(app)).toHaveText([/clip/, /photo/, /song/, /deck/]);
  await expect(app.control.getByText("No guardado")).toBeVisible();
});

test("a row goes with «Quitar» or the Delete key, and «Vaciar» asks before throwing away unsaved work", async ({ app }) => {
  await addAll(app, "clip.mp4", "photo.png", "song.mp3");
  await expect(rows(app)).toHaveCount(3);

  await rows(app).filter({ hasText: "photo" }).click();
  await scheduleSection(app).getByRole("button", { name: "Quitar", exact: true }).click();
  await expect(rows(app)).toHaveText([/clip/, /song/]);

  await rows(app).filter({ hasText: "song" }).click();
  await app.control.keyboard.press("Delete");
  await expect(rows(app)).toHaveText([/clip/]);
  // The library still has it: removing a row is not removing the file.
  await app.openResources("Medios", "Audios");
  await expect(app.control.getByRole("tabpanel", { name: "Audios" }).getByRole("button", { name: "song" })).toBeVisible();

  // Unsaved: «Vaciar» asks first, the same way «Nuevo programa» does.
  await clearSchedule(app);
  const warning = app.control.getByRole("dialog", { name: "Cambios sin guardar" });
  await expect(warning).toContainText("Hay cambios sin guardar en el programa actual");
  await expect(rows(app)).toHaveText([/clip/]);
  await warning.getByRole("button", { name: "Descartar y vaciar" }).click();
  await expect(app.control.getByText("Programa vacío")).toBeVisible();
});

test("«Vaciar» on a saved program empties it at once, and the saved copy is still there", async ({ app }) => {
  await addAll(app, "clip.mp4", "photo.png");
  await saveAs(app, "Culto A");
  await clearSchedule(app);
  await expect(app.control.getByText("Programa vacío")).toBeVisible();

  await app.control.getByRole("button", { name: "Administrar programas" }).click();
  await programRow(app, "Culto A").click();
  await manager(app).getByRole("button", { name: "Abrir" }).click();
  await expect(rows(app)).toHaveText([/clip/, /photo/]);
});

test("a saved program is duplicated, renamed, made a favourite and found by search", async ({ app }) => {
  await addAll(app, "clip.mp4", "photo.png");
  await saveAs(app, "Culto A");
  await app.control.getByRole("button", { name: "Administrar programas" }).click();

  await programRow(app, "Culto A").click();
  await manager(app).getByRole("button", { name: "Más acciones" }).click();
  await app.control.getByRole("menuitem", { name: "Duplicar" }).click();
  // Like every editor's «Duplicar»: a copy of what is saved, saved at once and chosen.
  await expect(toast(app, '"Culto A (copia)" guardado')).toBeVisible();
  await expect(programRow(app, "Culto A (copia)")).toBeVisible();
  await expect(manager(app).getByRole("textbox", { name: "Nombre" })).toHaveValue("Culto A (copia)");

  await manager(app).getByRole("textbox", { name: "Nombre" }).fill("Culto B");
  await manager(app).getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(toast(app, '"Culto B" actualizado')).toBeVisible();
  // The copy carries the items, not just the name.
  await expect(manager(app).getByText("2 elementos")).toBeVisible();

  await programRow(app, "Culto B").getByRole("button", { name: "Marcar como favorito" }).click();
  await expect(programRow(app, "Culto B").getByRole("button", { name: "Quitar de favoritos" })).toBeVisible();

  await manager(app).getByRole("textbox", { name: "Buscar programa…" }).fill("Culto A");
  await expect(programRow(app, "Culto A")).toBeVisible();
  await expect(programRow(app, "Culto B")).toHaveCount(0);
});

test("deleting the program in use empties the schedule with it, after saying so", async ({ app }) => {
  await addAll(app, "clip.mp4", "photo.png");
  await saveAs(app, "Culto A");
  await app.control.getByRole("button", { name: "Administrar programas" }).click();
  await expect(programRow(app, "Culto A")).toContainText("En uso");

  await programRow(app, "Culto A").click();
  await manager(app).getByRole("button", { name: "Más acciones" }).click();
  await app.control.getByRole("menuitem", { name: "Eliminar", exact: true }).click();
  const confirm = app.control.getByRole("dialog", { name: "Eliminar programa" });
  await expect(confirm).toContainText('Se va a eliminar "Culto A" y todos sus elementos.');
  await confirm.getByRole("button", { name: "Eliminar", exact: true }).click();
  await expect(toast(app, "Programa eliminado")).toBeVisible();
  await expect(manager(app).getByText("No hay programas guardados").or(manager(app).getByText("Programa sin guardar"))).toBeVisible();
  await manager(app).getByRole("button", { name: "Cerrar" }).click();

  await expect(app.control.getByText("Programa vacío")).toBeVisible();
  // And «Guardar» starts a new program instead of writing to the deleted one.
  await addAll(app, "photo.png");
  await saveAs(app, "Culto nuevo");
});

test("opening a program over unsaved changes asks before throwing them away", async ({ app }) => {
  await addAll(app, "clip.mp4");
  await saveAs(app, "Culto A");
  await addAll(app, "photo.png");
  await expect(app.control.getByText("No guardado")).toBeVisible();

  await app.control.getByRole("button", { name: "Administrar programas" }).click();
  await programRow(app, "Culto A").click();
  await manager(app).getByRole("button", { name: "Abrir" }).click();
  const confirm = app.control.getByRole("dialog", { name: "Cambios sin guardar" });
  await expect(confirm).toContainText("Hay cambios sin guardar en el programa actual");
  await confirm.getByRole("button", { name: "Cancelar" }).click();
  await manager(app).getByRole("button", { name: "Cerrar" }).click();
  await expect(rows(app)).toHaveText([/clip/, /photo/]);

  await app.control.getByRole("button", { name: "Administrar programas" }).click();
  await programRow(app, "Culto A").click();
  await manager(app).getByRole("button", { name: "Abrir" }).click();
  await confirm.getByRole("button", { name: "Descartar y abrir" }).click();
  await expect(rows(app)).toHaveText([/clip/]);
});

test("«Nuevo programa» in the manager makes an empty program, and opens it only when asked", async ({ app }) => {
  await addAll(app, "clip.mp4");
  await saveAs(app, "Culto A");
  await app.control.getByRole("button", { name: "Administrar programas" }).click();
  await manager(app).getByRole("button", { name: "Nuevo programa" }).click();
  // Something new to name: the caret is already in the bar.
  await expect(manager(app).getByRole("textbox", { name: "Nombre" })).toBeFocused();
  await manager(app).getByRole("group", { name: "Crear y abrir" }).getByRole("switch").uncheck();
  await manager(app).getByRole("textbox", { name: "Nombre" }).fill("Vacío");
  // Enter in the name saves.
  await app.control.keyboard.press("Enter");
  await expect(toast(app, '"Vacío" guardado')).toBeVisible();
  await expect(manager(app).getByText("0 elementos")).toBeVisible();
  await manager(app).getByRole("button", { name: "Cerrar" }).click();
  await expect(rows(app)).toHaveText([/clip/]);
});

test("«Nuevo programa» over unsaved changes warns, and only starts over when told to", async ({ app }) => {
  await addAll(app, "clip.mp4");
  await app.control.getByRole("button", { name: "Nuevo programa" }).first().click();
  const warning = app.control.getByRole("dialog", { name: "Cambios sin guardar" });
  await expect(warning).toContainText("Hay cambios sin guardar en el programa actual");
  await expect(rows(app)).toHaveText([/clip/]);
  await warning.getByRole("button", { name: "Descartar y empezar" }).click();
  await expect(app.control.getByText("Programa vacío")).toBeVisible();
});

test("a library tile dragged onto the schedule lands where it is dropped", async ({ app }) => {
  await addAll(app, "clip.mp4", "song.mp3");
  await app.addMedia("image", "photo.png");
  await app.openResources("Medios", "Imágenes");
  await app.control.getByRole("tabpanel", { name: "Imágenes" }).getByRole("button", { name: "photo" }).dragTo(rows(app).filter({ hasText: "song" }));
  await expect(rows(app)).toHaveText([/clip/, /photo/, /song/]);
});

test("a schedule row dragged onto another moves there", async ({ app }) => {
  await addAll(app, "clip.mp4", "photo.png", "song.mp3");
  await rows(app).filter({ hasText: "song" }).dragTo(rows(app).filter({ hasText: "clip" }));
  await expect(rows(app)).toHaveText([/song/, /clip/, /photo/]);
});

test("a verse and a time scene can be dragged into the schedule too", async ({ app }) => {
  const { control } = app;
  await app.openChapter("Juan 3");
  const verse = control
    .getByRole("tabpanel", { name: "Biblia" })
    .getByRole("listitem")
    .filter({ hasText: "Porque de tal manera amó Dios al mundo" });
  // Far down the chapter: in view first, or the press lands outside the list.
  await verse.scrollIntoViewIfNeeded();
  await verse.dragTo(scheduleSection(app).getByText("Programa vacío"));
  await expect(rows(app)).toHaveText([/Juan 3:16/]);

  await app.openResources("Funciones", "Utilidades");
  await control.getByRole("list", { name: "Escenas de tiempo" }).getByRole("listitem").filter({ hasText: "Reloj" }).dragTo(rows(app).first());
  await expect(rows(app)).toHaveText([/Reloj/, /Juan 3:16/]);
});
