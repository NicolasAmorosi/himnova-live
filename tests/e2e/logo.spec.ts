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
  // A new install shows the name over a background until «Imagen» is chosen.
  await settings.getByRole("group", { name: "Mostrar", exact: true }).getByRole("button", { name: "Imagen" }).click();
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
  // Still in «Imagen»: the group's one preview is a bare black LOGO now.
  await expect(settings.getByRole("tabpanel", { name: "Proyección" }).locator('img[src^="worship://logo"]')).toHaveCount(0);
});

test("«Nombre sobre fondo» shows the church's name even with a logo image loaded, and «Imagen» brings the image back", async ({ app }) => {
  const settings = await chooseLogo(app, fixture("photo.png"));
  const panel = settings.getByRole("tabpanel", { name: "Proyección" });
  await settings.getByRole("group", { name: "Mostrar", exact: true }).getByRole("button", { name: "Nombre sobre fondo" }).click();
  // The image's own row goes, the name's comes.
  await expect(settings.getByRole("button", { name: "Elegir archivo…" })).toHaveCount(0);
  const name = settings.getByRole("textbox", { name: "Nombre de la iglesia" });
  await name.fill("Iglesia Central");
  await name.press("Enter");
  await expect(panel.locator("[data-logo-name]")).toHaveText("Iglesia Central");
  await settings.getByRole("button", { name: "Volver" }).click();

  await app.control.getByRole("button", { name: "LOGO", exact: true }).first().click();
  const projector = await app.projector();
  await expect(projector.locator("[data-logo-name]")).toHaveText("Iglesia Central");
  await expect(logoOnProjector(projector)).toHaveCount(0);

  await app.control.getByRole("button", { name: "Configuración" }).click();
  await settings.getByRole("tab", { name: "Proyección" }).click();
  await settings.getByRole("group", { name: "Mostrar", exact: true }).getByRole("button", { name: "Imagen" }).click();
  await expect(logoOnProjector(projector)).toBeVisible();
  await expect(projector.locator("[data-logo-name]")).toHaveCount(0);
});

// A web address as the church's name is ONE word: at a fixed 5.5 cqw it ran off both sides of the wall the
// congregation waits in front of (2026-11-10 review, agent4-07). A long name with spaces already wrapped.
for (const name of [
  "Iglesia Adventista del Séptimo Día Central de la Ciudad Autónoma de Buenos Aires",
  "www.iglesiaadventistacentraldebuenosaires.org.ar",
]) {
  test(`LOGO's name «${name.slice(0, 24)}…» stays inside the projector`, async ({ app }) => {
    await app.invoke("settings:set", { "logo.mode": "name", "logo.name": name });
    await app.control.reload();
    await expect(app.control.getByRole("button", { name: "EN VIVO", exact: true })).toBeVisible();
    await app.control.locator("body").press("l");
    const projector = await app.projector();
    const text = projector.locator("[data-logo-name]").last();
    await expect(text).toBeVisible();
    const box = await text.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, scrollW: el.scrollWidth, clientW: el.clientWidth, vw: window.innerWidth };
    });
    expect(box.scrollW).toBeLessThanOrEqual(box.clientW + 1);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(box.vw);
  });
}

test("a renderer cannot point LOGO at any file: worship://logo serves only what «Elegir…» picked", async ({ app }) => {
  // 2026-11-10 review, agent6-03: `settings:set` took any path and the protocol served it back.
  const secret = path.join(app.profile, "id_rsa");
  fs.writeFileSync(secret, "-----BEGIN OPENSSH PRIVATE KEY-----");
  await expect(app.invoke("settings:set", { "logo.path": secret })).rejects.toThrow();
  const status = await app.control.evaluate(async () => (await fetch("worship://logo")).status);
  expect(status).not.toBe(200);
  // Clearing it stays allowed: «Quitar» in Settings does exactly that.
  await app.invoke("settings:set", { "logo.path": null });
});
