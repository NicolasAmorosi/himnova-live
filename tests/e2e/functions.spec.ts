import type { Locator, Page } from "@playwright/test";
import { expect, test, type WorshipApp } from "./support/app";

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
  await expect.poll(() => countdownSeconds(projector), { timeout: 5_000 }).toBeLessThan(first);
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
  await expect(projector.getByText("Pr. Juan Pérez")).toHaveCount(0, { timeout: 6_000 });
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
