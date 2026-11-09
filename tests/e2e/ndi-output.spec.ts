// Settings ▸ Proyección ▸ «Salida NDI®». Runs on any machine: with an NDI runtime (installed, or
// LUMINA_NDI_LIB=<path to it>) the output reports «Enviando»; without one it says what is missing and offers
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
    // Its own window: closing the projector and opening it again never stops it.
    await settings.getByRole("button", { name: "Cerrar pantalla" }).click();
    await expect.poll(() => app.hasProjector()).toBe(false);
    await expect(status).toContainText("Enviando");
    // (A reopened projector starts under NEGRO, and the NDI output with it: it draws what the projector does.)
    await settings.getByRole("button", { name: "Abrir pantalla" }).click();
    await app.projector();
    await expect(status).toContainText("Enviando");
  }

  await toggle.click();
  await expect(status).toContainText("Apagada");
  if (!sending) await expect(image).toBeVisible();
});
