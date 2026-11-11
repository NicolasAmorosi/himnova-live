import type { Locator, Page } from "@playwright/test";
import { expect, msUntilChange, relaunch, test, type WorshipApp } from "./support/app";

/** Seconds left on the projected countdown, read off its `m:ss`. */
async function countdownSeconds(projector: Page): Promise<number | null> {
  const text = await projector.locator("body").innerText();
  const match = /(\d{1,2}):(\d{2})/.exec(text);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

test("a countdown is projected and runs", async ({ app }) => {
  await app.openResources("Funciones", "Utilidades");
  await app.control.getByRole("list", { name: "Escenas de tiempo" }).getByRole("listitem").filter({ hasText: "Cuenta 10 minutos" }).click();
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => countdownSeconds(projector)).not.toBeNull();
  const first = (await countdownSeconds(projector)) ?? 0;
  expect(first).toBeLessThanOrEqual(600);
  // One second a second: three seconds take 3 off (2–4 for where in its second each read falls), not «less».
  await projector.waitForTimeout(3_000);
  const later = (await countdownSeconds(projector)) ?? first;
  expect(first - later).toBeGreaterThanOrEqual(2);
  expect(first - later).toBeLessThanOrEqual(4);
});

test("a plate made in the editor goes up over what is live", async ({ app }) => {
  const { control } = app;
  const [photo] = await app.addMedia("image", "photo.png");
  await app.previewFile("Imágenes", "photo");
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.locator(`img[src="worship://asset/${photo?.id}"]`)).toBeVisible();

  // «Placas» on an empty Overlays panel opens the editor straight on a new plate.
  await app.openResources("Funciones", "Placas");
  await control.getByRole("tabpanel", { name: "Placas" }).getByRole("button", { name: "Editar placas", exact: true }).click();
  const editor = control.getByRole("dialog", { name: "Placas" });
  await editor.getByRole("group", { name: "Título", exact: true }).getByRole("textbox").fill("Pr. Juan Pérez");
  await editor.getByRole("button", { name: "Guardar", exact: true }).click();
  await editor.getByRole("button", { name: "Cerrar" }).click();

  await control.getByRole("tabpanel", { name: "Placas" }).getByRole("listitem").filter({ hasText: "Placa nueva" }).click();
  await app.goLive();
  await expect(projector.getByText("Pr. Juan Pérez")).toBeVisible();
  // Over the image, not instead of it.
  await expect(projector.locator(`img[src="worship://asset/${photo?.id}"]`)).toBeVisible();
});

test("leaving an editor with unsaved changes can save and leave in one go", async ({ app }) => {
  const { control } = app;
  await app.openResources("Funciones", "Placas");
  await control.getByRole("tabpanel", { name: "Placas" }).getByRole("button", { name: "Editar placas", exact: true }).click();
  const editor = control.getByRole("dialog", { name: "Placas" });
  await editor.getByRole("group", { name: "Título", exact: true }).getByRole("textbox").fill("Pr. Ana Gómez");
  await editor.getByRole("button", { name: "Cerrar" }).click();
  // «Guardar y salir» (owner, 2026-11-05): saved, then gone — no second step.
  await control.getByRole("dialog", { name: "Hay cambios sin guardar" }).getByRole("button", { name: "Guardar y salir" }).click();
  await expect(control.getByRole("status").filter({ hasText: "Se guardó «Placa nueva»" })).toBeVisible();
  await expect(editor).toBeHidden();
  await expect(control.getByRole("tabpanel", { name: "Placas" }).getByRole("listitem").filter({ hasText: "Placa nueva" })).toBeVisible();
});

const scenes = (app: WorshipApp) => app.control.getByRole("list", { name: "Escenas de tiempo" }).getByRole("listitem");

async function sceneLive(app: WorshipApp, name: string) {
  await app.openResources("Funciones", "Utilidades");
  await scenes(app).filter({ hasText: name }).click();
  await app.goLive();
  return app.projector();
}

test("a countdown made in the editor runs out on the projector and shows its end message", async ({ app }) => {
  const { control } = app;
  await app.openResources("Funciones", "Utilidades");
  await control.getByRole("button", { name: "Editar escenas", exact: true }).click();
  const editor = control.getByRole("dialog", { name: "Escenas de tiempo" });
  await editor.getByRole("button", { name: "Nueva escena" }).first().click();
  await editor.getByRole("textbox", { name: "Nombre", exact: true }).fill("Cuenta corta");
  await editor.getByRole("group", { name: "Duración", exact: true }).getByRole("textbox").fill("0:04");
  await editor.getByRole("group", { name: "Mensaje final", exact: true }).getByRole("textbox").fill("¡Empezamos!");
  await editor.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(control.getByRole("status").filter({ hasText: "Se guardó «Cuenta corta»" })).toBeVisible();
  await editor.getByRole("button", { name: "Cerrar" }).first().click();

  const projector = await sceneLive(app, "Cuenta corta");
  await expect.poll(() => countdownSeconds(projector)).toBeLessThanOrEqual(4);
  await expect(projector.getByText("¡Empezamos!")).toBeVisible({ timeout: 8_000 });
  await expect(app.liveColumn().getByText("Terminó")).toBeVisible();
});

test("the LIVE row pauses, resumes and restarts the countdown on the projector", async ({ app }) => {
  const projector = await sceneLive(app, "Cuenta 10 minutos");
  await expect.poll(() => countdownSeconds(projector), { timeout: 5_000 }).toBeLessThan(600);
  const live = app.liveColumn();

  await live.getByRole("button", { name: "Pausar" }).click();
  const pausedAt = await countdownSeconds(projector);
  await app.control.waitForTimeout(2200);
  expect(await countdownSeconds(projector)).toBe(pausedAt);

  await live.getByRole("button", { name: "Reanudar" }).click();
  await expect.poll(() => countdownSeconds(projector), { timeout: 4_000 }).toBeLessThan(pausedAt ?? 0);

  await live.getByRole("button", { name: "Reiniciar" }).click();
  await expect.poll(() => countdownSeconds(projector)).toBe(600);
});

test("the clock shows the time of day", async ({ app }) => {
  const projector = await sceneLive(app, "Reloj");
  await expect.poll(() => countdownSeconds(projector)).not.toBeNull();
  const shown = (await countdownSeconds(projector)) ?? -1;
  const now = new Date();
  // `countdownSeconds` reads h:mm as m:ss, so this is hours*60 + minutes.
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  expect(Math.abs(shown - minuteOfDay)).toBeLessThanOrEqual(1);
});

test("the stopwatch counts up from zero", async ({ app }) => {
  const projector = await sceneLive(app, "Cronómetro");
  await expect.poll(() => countdownSeconds(projector)).not.toBeNull();
  expect(await countdownSeconds(projector)).toBeLessThanOrEqual(1);
  await expect.poll(() => countdownSeconds(projector), { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
});

test("a time scene in the order of service goes live from its row", async ({ app }) => {
  await app.openResources("Funciones", "Utilidades");
  await scenes(app).filter({ hasText: "Cuenta 10 minutos" }).click();
  await app.control.getByRole("tabpanel", { name: "Utilidades" }).getByRole("button", { name: "Agregar al programa" }).click();
  const row = app.control.getByRole("main").getByRole("list").first().getByRole("listitem").filter({ hasText: "Cuenta 10 minutos" });
  await row.dblclick();
  const projector = await app.projector();
  await expect.poll(() => countdownSeconds(projector), { timeout: 5_000 }).toBeLessThan(600);
});

async function plateUp(app: WorshipApp, configure?: (editor: Locator) => Promise<void>) {
  const { control } = app;
  const [photo] = await app.addMedia("image", "photo.png");
  await app.previewFile("Imágenes", "photo");
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.locator(`img[src="worship://asset/${photo?.id}"]`)).toBeVisible();

  await app.openResources("Funciones", "Placas");
  await control.getByRole("tabpanel", { name: "Placas" }).getByRole("button", { name: "Editar placas", exact: true }).click();
  const editor = control.getByRole("dialog", { name: "Placas" });
  await editor.getByRole("group", { name: "Título", exact: true }).getByRole("textbox").fill("Pr. Juan Pérez");
  await configure?.(editor);
  await editor.getByRole("button", { name: "Guardar", exact: true }).click();
  await editor.getByRole("button", { name: "Cerrar" }).click();
  await control.getByRole("tabpanel", { name: "Placas" }).getByRole("listitem").filter({ hasText: "Placa nueva" }).click();
  await app.goLive();
  await expect(projector.getByText("Pr. Juan Pérez")).toBeVisible();
  return { projector, photo };
}

test("a plate taken down from the LIVE panel leaves what is under it", async ({ app }) => {
  const { projector, photo } = await plateUp(app);
  const row = app.liveColumn().getByText("Placa nueva").locator("..");
  await row.getByRole("button", { name: "Sacar del aire" }).click();
  await expect(projector.getByText("Pr. Juan Pérez")).toHaveCount(0);
  await expect(projector.locator(`img[src="worship://asset/${photo?.id}"]`)).toBeVisible();
});

test("NEGRO covers a plate too, and uncovering brings it back", async ({ app }) => {
  const { projector } = await plateUp(app);
  await app.control.locator("body").press("b");
  await expect(projector.getByText("Pr. Juan Pérez")).toBeHidden();
  await expect(app.liveColumn().getByText("Está puesta, pero NEGRO, LOGO o la falta de algo en vivo la tapan")).toBeVisible();
  await app.control.locator("body").press("b");
  await expect(projector.getByText("Pr. Juan Pérez")).toBeVisible();
});

test("a plate set to hide by itself goes down after its time", async ({ app }) => {
  const { projector } = await plateUp(app, async (editor) => {
    // A rarely used section, folded until opened (2026-11-05).
    await editor.locator("summary").filter({ hasText: "Ocultar sola" }).click();
    await editor.getByRole("group", { name: "Ocultar después de un tiempo" }).getByRole("switch").click();
    await editor.getByRole("slider", { name: "Tiempo en pantalla" }).fill("2");
  });
  // Its two seconds from GO LIVE, part of which went before it was seen: neither at once nor twice as long.
  const down = await msUntilChange(() => projector.getByText("Pr. Juan Pérez").count(), 1, 6_000);
  expect(down.value).toBe(0);
  expect(down.ms).toBeGreaterThan(1_000);
  expect(down.ms).toBeLessThan(2_600);
});

test("deleting a plate that is up takes it off the projector first", async ({ app }) => {
  const { projector } = await plateUp(app);
  const { control } = app;
  await control.getByRole("tabpanel", { name: "Placas" }).getByRole("button", { name: "Editar placas", exact: true }).click();
  const editor = control.getByRole("dialog", { name: "Placas" });
  await editor.getByRole("list", { name: "Placas guardadas" }).getByRole("listitem").filter({ hasText: "Placa nueva" }).click();
  await editor.getByRole("button", { name: "Más acciones" }).click();
  await control.getByRole("menuitem", { name: "Eliminar", exact: true }).click();
  const confirm = control.getByRole("dialog", { name: "¿Eliminar esta placa?" });
  await expect(confirm).toContainText("La placa está en el aire");
  await confirm.getByRole("button", { name: "Eliminar", exact: true }).click();
  await expect(projector.getByText("Pr. Juan Pérez")).toHaveCount(0);
});

test("the time scenes are searched by name and ordered like Media's files, and the order is remembered (owner, 2026-11-05)", async ({
  app,
}) => {
  await app.openResources("Funciones", "Utilidades");
  const panel = app.control.getByRole("tabpanel", { name: "Utilidades" });
  const rows = panel.getByRole("list", { name: "Escenas de tiempo" }).getByRole("listitem");
  // «Orden personalizado»: the editor's own order.
  await expect(rows).toHaveText([/^Cuenta 10 minutos/, /^Comenzamos 10:00/, /^Reloj/, /^Cronómetro/]);

  await panel.getByRole("button", { name: "Ordenar" }).click();
  await app.control.getByRole("menuitemradio", { name: "Nombre (Z → A)" }).click();
  await expect(rows).toHaveText([/^Reloj/, /^Cuenta 10 minutos/, /^Cronómetro/, /^Comenzamos 10:00/]);

  const search = panel.getByRole("textbox", { name: "Buscar por nombre…" });
  await search.fill("CRONOMETRO");
  await expect(rows).toHaveText([/^Cronómetro/]);
  await search.fill("zzz");
  await expect(panel).toContainText("Nada en esta lista se llama «zzz»");
  await panel.getByRole("button", { name: "Limpiar la búsqueda" }).first().click();
  await expect(rows).toHaveCount(4);

  // The order is the tab's, kept; the search is not.
  await app.openResources("Funciones", "Placas");
  await app.openResources("Funciones", "Utilidades");
  await expect(rows.first()).toHaveText(/^Reloj/);
});

/** The time scenes' full-screen editor, from the Utilidades tab. */
async function sceneEditor(app: WorshipApp): Promise<Locator> {
  await app.openResources("Funciones", "Utilidades");
  await app.control.getByRole("button", { name: "Editar escenas", exact: true }).click();
  const editor = app.control.getByRole("dialog", { name: "Escenas de tiempo" });
  await expect(editor).toBeVisible();
  return editor;
}

const savedScenes = (editor: Locator) => editor.getByRole("list", { name: "Escenas guardadas" }).getByRole("listitem");
const scheduleRows = (app: WorshipApp) => app.control.getByRole("main").getByRole("list").first().getByRole("listitem");
/** The on-air rail of a schedule row. */
const rail = (row: Locator) => row.locator("span.bg-on-air");

async function deleteScene(app: WorshipApp, editor: Locator, name: string): Promise<Locator> {
  await savedScenes(editor).filter({ hasText: name }).click();
  await editor.getByRole("button", { name: "Más acciones" }).click();
  await app.control.getByRole("menuitem", { name: "Eliminar", exact: true }).click();
  return app.control.getByRole("dialog", { name: "¿Eliminar esta escena?" });
}

test("saving the countdown that is live restyles the projector in place, and the count goes on", async ({ app }) => {
  const projector = await sceneLive(app, "Cuenta 10 minutos");
  await expect.poll(() => countdownSeconds(projector), { timeout: 6_000 }).toBeLessThanOrEqual(597);

  const editor = await sceneEditor(app);
  await savedScenes(editor).filter({ hasText: "Cuenta 10 minutos" }).click();
  await editor.getByRole("group", { name: "Línea de arriba", exact: true }).getByRole("textbox").fill("Ya empezamos");
  await editor.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(app.control.getByRole("status").filter({ hasText: "Se guardó «Cuenta 10 minutos»" })).toBeVisible();
  await editor.getByRole("button", { name: "Cerrar" }).first().click();
  await expect(projector.getByText("Ya empezamos")).toBeVisible();
  // Patched in place, never a new scene: a new one would start the count over.
  expect(await countdownSeconds(projector)).toBeLessThanOrEqual(597);
});

test("a countdown deleted in the editor while it is live keeps counting, and its LIVE row still drives it", async ({ app }) => {
  const projector = await sceneLive(app, "Cuenta 10 minutos");
  await expect.poll(() => countdownSeconds(projector), { timeout: 6_000 }).toBeLessThan(600);

  const editor = await sceneEditor(app);
  await (await deleteScene(app, editor, "Cuenta 10 minutos")).getByRole("button", { name: "Eliminar", exact: true }).click();
  await editor.getByRole("button", { name: "Cerrar" }).first().click();

  // What is projected stays until something else goes live.
  const at = (await countdownSeconds(projector)) ?? 0;
  await expect.poll(() => countdownSeconds(projector), { timeout: 4_000 }).toBeLessThan(at);
  const live = app.liveColumn();
  await live.getByRole("button", { name: "Pausar" }).click();
  const paused = await countdownSeconds(projector);
  await app.control.waitForTimeout(1500);
  expect(await countdownSeconds(projector)).toBe(paused);
  await live.getByRole("button", { name: "Reiniciar" }).click();
  await expect.poll(() => countdownSeconds(projector)).toBe(600);
});

test("deleting a time scene that is in the open order of service says so, and takes its row with it", async ({ app }) => {
  await app.openResources("Funciones", "Utilidades");
  await scenes(app).filter({ hasText: "Reloj" }).click();
  await app.control.getByRole("tabpanel", { name: "Utilidades" }).getByRole("button", { name: "Agregar al programa" }).click();
  await expect(scheduleRows(app).filter({ hasText: "Reloj" })).toHaveCount(1);

  const editor = await sceneEditor(app);
  const confirm = await deleteScene(app, editor, "Reloj");
  await expect(confirm).toContainText("También está en el programa abierto: se quita de ahí también.");
  await confirm.getByRole("button", { name: "Eliminar", exact: true }).click();
  await expect(savedScenes(editor)).toHaveCount(3);
  await editor.getByRole("button", { name: "Cerrar" }).first().click();
  // A row of a scene that is gone would go live as nothing.
  await expect(scheduleRows(app).filter({ hasText: "Reloj" })).toHaveCount(0);
});

test("a scene dragged in the editor's list reorders the Utilidades panel («Orden personalizado»), also after a restart", async ({
  app,
}) => {
  const editor = await sceneEditor(app);
  const rows = savedScenes(editor);
  await expect(rows).toHaveText([/Cuenta 10 minutos/, /Comenzamos 10:00/, /Reloj/, /Cronómetro/]);
  await rows.filter({ hasText: "Cronómetro" }).dragTo(rows.filter({ hasText: "Cuenta 10 minutos" }));
  await expect(rows).toHaveText([/Cronómetro/, /Cuenta 10 minutos/, /Comenzamos 10:00/, /Reloj/]);
  await editor.getByRole("button", { name: "Cerrar" }).first().click();
  await expect(scenes(app).first()).toHaveText(/^Cronómetro/);

  await app.quit();
  const again = await relaunch(app);
  await again.openResources("Funciones", "Utilidades");
  await expect(scenes(again).first()).toHaveText(/^Cronómetro/);
});

test("a countdown row keeps counting while another row is live, and comes back where it is", async ({ app }) => {
  await app.openResources("Funciones", "Utilidades");
  await scenes(app).filter({ hasText: "Cuenta 10 minutos" }).click();
  await app.control.getByRole("tabpanel", { name: "Utilidades" }).getByRole("button", { name: "Agregar al programa" }).click();
  await app.addMedia("image", "photo.png");
  await app.previewFile("Imágenes", "photo");
  await app.control.getByRole("tabpanel", { name: "Imágenes" }).getByRole("button", { name: "Agregar al programa" }).click();
  await expect(scheduleRows(app)).toHaveText([/Cuenta 10 minutos/, /photo/]);

  await scheduleRows(app).filter({ hasText: "Cuenta 10 minutos" }).dblclick();
  const projector = await app.projector();
  await expect.poll(() => countdownSeconds(projector), { timeout: 5_000 }).toBeLessThan(600);
  const first = (await countdownSeconds(projector)) ?? 600;
  await scheduleRows(app).filter({ hasText: "photo" }).dblclick();
  await expect(projector.locator('img[src^="worship://asset/"]')).toBeVisible();
  await app.control.waitForTimeout(3_000);
  // A countdown counts to its service's start: it did not stop while the photo was up.
  await scheduleRows(app).filter({ hasText: "Cuenta 10 minutos" }).dblclick();
  await expect.poll(() => countdownSeconds(projector)).toBeLessThanOrEqual(first - 2);
});

test("a plate edited while it is up changes on the projector in place", async ({ app }) => {
  const { projector } = await plateUp(app);
  const { control } = app;
  await control.getByRole("tabpanel", { name: "Placas" }).getByRole("button", { name: "Editar placas", exact: true }).click();
  const editor = control.getByRole("dialog", { name: "Placas" });
  await editor.getByRole("group", { name: "Título", exact: true }).first().getByRole("textbox").fill("Pr. Ana Gómez");
  await editor.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(control.getByRole("status").filter({ hasText: "Se guardó «Placa nueva»" }).last()).toBeVisible();
  await editor.getByRole("button", { name: "Cerrar" }).click();
  await expect(projector.getByText("Pr. Ana Gómez")).toBeVisible();
  await expect(projector.getByText("Pr. Juan Pérez")).toHaveCount(0);
});

test("a plate's row sent with Enter goes up over the row that is live, which keeps the rail", async ({ app }) => {
  const { control } = app;
  await app.openResources("Funciones", "Placas");
  await control.getByRole("tabpanel", { name: "Placas" }).getByRole("button", { name: "Editar placas", exact: true }).click();
  const editor = control.getByRole("dialog", { name: "Placas" });
  await editor.getByRole("group", { name: "Título", exact: true }).getByRole("textbox").fill("Pr. Juan Pérez");
  await editor.getByRole("button", { name: "Guardar", exact: true }).click();
  await editor.getByRole("button", { name: "Cerrar" }).click();
  await control.getByRole("tabpanel", { name: "Placas" }).getByRole("listitem").filter({ hasText: "Placa nueva" }).click();
  await control.getByRole("tabpanel", { name: "Placas" }).getByRole("button", { name: "Agregar al programa" }).click();
  await app.addMedia("image", "photo.png");
  await app.previewFile("Imágenes", "photo");
  await control.getByRole("tabpanel", { name: "Imágenes" }).getByRole("button", { name: "Agregar al programa" }).click();
  await expect(scheduleRows(app)).toHaveText([/Placa nueva/, /photo/]);

  await scheduleRows(app).filter({ hasText: "photo" }).dblclick();
  const projector = await app.projector();
  await expect(projector.locator('img[src^="worship://asset/"]')).toBeVisible();
  await scheduleRows(app).filter({ hasText: "Placa nueva" }).click();
  await control.keyboard.press("Enter");
  // A plate goes OVER what is live: the photo stays, and so does its rail.
  await expect(projector.getByText("Pr. Juan Pérez")).toBeVisible();
  await expect(projector.locator('img[src^="worship://asset/"]')).toBeVisible();
  await expect(rail(scheduleRows(app).filter({ hasText: "photo" }))).toHaveCount(1);
  await expect(rail(scheduleRows(app).filter({ hasText: "Placa nueva" }))).toHaveCount(0);
});
