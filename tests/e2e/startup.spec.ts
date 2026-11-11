import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./support/paths";
import { expect, test } from "./support/app";

test("a first launch on an empty profile opens clean", async ({ app }) => {
  const { control } = app;
  await expect(control.getByText("Programa vacío")).toBeVisible();
  // Nothing to save either: a fresh launch is not «No guardado».
  await expect(control.getByRole("button", { name: "Guardar", exact: true })).toBeDisabled();
  await expect(control.getByText("No guardado")).toHaveCount(0);
  // Nothing is in PREVIEW, so there is nothing to send live.
  await expect(control.getByRole("button", { name: "EN VIVO", exact: true })).toBeDisabled();
  // The projector is opened by the first EN VIVO/NEGRO/LOGO, never at launch.
  expect(app.hasProjector()).toBe(false);
  await expect(control.getByText("Ocurrió un error inesperado")).toHaveCount(0);
});

test("Ajustes › Acerca de names the product and the build that is running", async ({ app }) => {
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string };
  await app.control.getByRole("button", { name: "Configuración" }).click();
  const dialog = app.control.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Acerca de" }).click();
  await expect(dialog.getByText(version, { exact: true })).toBeVisible();
  await expect(dialog.getByRole("img", { name: "Himnova Live" })).toBeVisible();
});
