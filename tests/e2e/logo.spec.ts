import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { fixture } from "./support/paths";
import { expect, relaunch, test, type WorshipApp } from "./support/app";

/** LOGO: the picture the projector rests on, picked through the real dialog. */

const logoOnProjector = (projector: Page) => projector.locator('img[src^="worship://logo"]');

async function chooseLogo(app: WorshipApp, file: string) {
  await app.control.getByRole("button", { name: "Configuración" }).click();
  const settings = app.control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Proyección" }).click();
  await app.answerOpenDialog(file);
  await settings.getByRole("button", { name: "Elegir archivo…" }).click();
  return settings;
}

test("LOGO with no logo chosen says so to the operator, and a chosen one is projected", async ({ app }) => {
  const { control } = app;
  await control.getByRole("button", { name: "LOGO", exact: true }).click();
  const projector = await app.projector();
  await expect(app.liveColumn().getByText("No hay logo cargado")).toBeVisible();
  await expect(logoOnProjector(projector)).toHaveCount(0);

  const settings = await chooseLogo(app, fixture("photo.png"));
  await expect(settings.getByRole("tabpanel", { name: "Proyección" }).locator('img[src^="worship://logo"]')).toBeVisible();
  await settings.getByRole("button", { name: "Volver" }).click();
  await expect(logoOnProjector(projector)).toBeVisible();
  await expect.poll(() => logoOnProjector(projector).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1280);
  await expect(app.liveColumn().getByText("No hay logo cargado")).toHaveCount(0);
});

test("L covers what is live with the logo and uncovers it again, also after a restart", async ({ app }) => {
  const settings = await chooseLogo(app, fixture("photo.png"));
  await settings.getByRole("button", { name: "Volver" }).click();
  const [clip] = await app.addMedia("video", "clip.mp4");
  await app.previewFile("Videos", "clip");
  await app.goLive();
  const projector = await app.projector();
  const video = projector.locator(`video[src*="/asset/${clip?.id}"]`);
  await expect(video).toHaveCSS("opacity", "1");

  await app.control.locator("body").press("l");
  await expect(logoOnProjector(projector)).toBeVisible();
  await expect(video).toHaveCSS("opacity", "0");
  await app.control.locator("body").press("l");
  await expect(video).toHaveCSS("opacity", "1");

  await app.quit("close");
  const again = await relaunch(app);
  await again.control.locator("body").press("l");
  await expect(logoOnProjector(await again.projector())).toBeVisible();
});

test("an image that cannot be read is refused and the previous logo stays", async ({ app }) => {
  const broken = path.join(app.profile, "broken.png");
  fs.writeFileSync(broken, Buffer.alloc(2048, 1));
  let settings = await chooseLogo(app, fixture("photo.png"));
  await settings.getByRole("button", { name: "Volver" }).click();

  settings = await chooseLogo(app, broken);
  await expect(app.control.getByRole("status").filter({ hasText: "Esa imagen no se pudo leer. Se conserva el logo anterior." })).toBeVisible();
  const stored = await app.invoke<Record<string, unknown>>("settings:get");
  expect(stored["logo.path"]).toBe(fixture("photo.png"));
  await expect(settings.getByRole("tabpanel", { name: "Proyección" }).locator('img[src^="worship://logo"]')).toBeVisible();
});

test("removing the logo while it is on the projector asks first", async ({ app }) => {
  const settings = await chooseLogo(app, fixture("photo.png"));
  await settings.getByRole("button", { name: "Volver" }).click();
  await app.control.getByRole("button", { name: "LOGO", exact: true }).click();
  const projector = await app.projector();
  await expect(logoOnProjector(projector)).toBeVisible();

  await app.control.getByRole("button", { name: "Configuración" }).click();
  await settings.getByRole("tab", { name: "Proyección" }).click();
  await settings.getByRole("button", { name: "Quitar", exact: true }).click();
  const confirm = app.control.getByRole("dialog", { name: "¿Quitar el logo?" });
  await confirm.getByRole("button", { name: "Cancelar" }).click();
  await expect(logoOnProjector(projector)).toBeVisible();

  await settings.getByRole("button", { name: "Quitar", exact: true }).click();
  await confirm.getByRole("button", { name: "Quitar", exact: true }).click();
  await expect(logoOnProjector(projector)).toHaveCount(0);
  // The group's one preview now shows the name-over-background LOGO instead.
  await expect(settings.getByRole("tabpanel", { name: "Proyección" }).locator('img[src^="worship://logo"]')).toHaveCount(0);
});
