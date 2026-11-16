// Settings ▸ Proyección ▸ «Salida NDI®». Runs on any machine: with an NDI runtime (installed, or
// HIMNOVA_NDI_LIB=<path to it>) the output reports «Enviando»; without one it says what is missing and offers
// the download. Either way the projector is not touched. What reaches a receiver is checked by hand with a
// real one (OBS), on the three systems.
import { expect, test } from "./support/app";

test("the NDI output turns on and off from Settings and never touches the projector", async ({ app }) => {
  await app.addMedia("image", "photo.png");
  await app.previewFile("Imágenes", "photo");
  await app.goLive();
  const projector = await app.projector();
  const image = projector.locator('img[src^="worship://asset/"]');
  await expect(image).toBeVisible();

  await app.control.getByRole("button", { name: "Configuración" }).click();
  const settings = app.control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Proyección" }).click();
  const toggle = settings.getByRole("group", { name: "Enviar por NDI®" }).getByRole("switch");
  const status = settings.getByRole("group", { name: "Estado", exact: true });
  await expect(status).toContainText("Apagada");
  // The name and size only apply while it is on.
  await expect(settings.getByRole("textbox", { name: "Nombre", exact: true })).toBeDisabled();

  await toggle.click();
  await expect(status).toContainText(/Enviando|Falta instalar NDI/);
  const sending = !(await status.textContent())?.includes("Falta");
  if (!sending) await expect(status.getByRole("button", { name: "Descargar NDI" })).toBeVisible();
  await expect(settings.getByRole("textbox", { name: "Nombre", exact: true })).toBeEnabled();
  // The same projector window, still showing what is live.
  await expect(image).toBeVisible();
  expect(app.electron.windows().filter((page) => page.url().endsWith("/projection.html"))).toHaveLength(1);

  if (sending) {
    // With the app's sound (on by default): the capture started, on every system the suite runs on.
    await expect(status).toContainText("Sonido: se envía");
    await expect(settings.getByRole("group", { name: "Sonido", exact: true }).getByRole("switch")).toBeChecked();
    // Its own window: closing the projector and opening it again (Ajustes ▸ Pantallas) never stops it.
    const screensTab = settings.getByRole("tab", { name: "Pantallas" });
    const projectionTab = settings.getByRole("tab", { name: "Proyección" });
    await screensTab.click();
    await settings.getByRole("button", { name: "Cerrar pantalla" }).click();
    await expect.poll(() => app.hasProjector()).toBe(false);
    await projectionTab.click();
    await expect(status).toContainText("Enviando");
    // (A reopened projector starts under NEGRO, and the NDI output with it: it draws what the projector does.)
    await screensTab.click();
    await settings.getByRole("button", { name: "Abrir pantalla" }).click();
    await app.projector();
    await projectionTab.click();
    await expect(status).toContainText("Enviando");
  }

  await toggle.click();
  await expect(status).toContainText("Apagada");
  if (!sending) await expect(image).toBeVisible();
});

test("dragging the sound's sync saves it on release, and the NDI page stays: only the sender restarts", async ({ app }) => {
  await app.control.getByRole("button", { name: "Configuración" }).click();
  const settings = app.control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Proyección" }).click();
  await settings.getByRole("group", { name: "Enviar por NDI®" }).getByRole("switch").click();
  // With its sound (on by default), at 0 ms.
  await expect(settings.getByRole("group", { name: "Sonido", exact: true }).getByRole("switch")).toBeChecked();
  const status = settings.getByRole("group", { name: "Estado", exact: true });
  await expect(status).toContainText(/Enviando|Falta instalar NDI/);
  test.skip((await status.textContent())?.includes("Falta") ?? false, "no NDI runtime on this computer");

  // The only offscreen window (its URL reads empty from main).
  const ndiWindow = () =>
    app.electron.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((win) => win.webContents.isOffscreen())?.id ?? null,
    );
  const started = () => app.log.filter((line) => line.includes("[ndi] sending (")).length;
  const delay = async () => (await app.invoke<Record<string, unknown>>("settings:get"))["ndi.output.audioDelayMs"];
  const page = await ndiWindow();
  expect(page).not.toBeNull();
  await expect.poll(started).toBeGreaterThan(0);
  const senders = started();

  // A slow drag across the track, as an operator does watching OBS: each step rebuilt the page and the sender, and the
  // source left OBS and came back on every one (2026-11-15 audit, A22).
  const box = await settings.getByRole("slider", { name: "Sincronía del sonido" }).boundingBox();
  if (!box) throw new Error("no slider");
  const y = box.y + box.height / 2;
  await app.control.mouse.move(box.x + box.width / 3, y);
  await app.control.mouse.down();
  for (const fraction of [0.45, 0.6, 0.75]) {
    await app.control.mouse.move(box.x + box.width * fraction, y, { steps: 3 });
    await app.control.waitForTimeout(150);
  }
  expect(await delay()).toBe(0);
  await app.control.mouse.up();
  await expect.poll(delay).toBeGreaterThan(0);
  await expect.poll(started).toBe(senders + 1);
  await expect(status).toContainText("Enviando");
  expect(await ndiWindow()).toBe(page);
});
