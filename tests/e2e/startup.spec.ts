import fs from "node:fs";
import path from "node:path";
import fuses from "@electron/fuses";
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

// ELECTRON_RUN_AS_NODE or NODE_OPTIONS would let any local process run its own script inside Himnova, with the
// camera, microphone and screen permissions the operator gave the app; and the app code is only the app.asar whose
// hash the executable carries. The inspector stays on: Playwright drives the package through `--inspect=0`.
test("the package ignores ELECTRON_RUN_AS_NODE and NODE_OPTIONS and loads only its sealed app.asar", async () => {
  const executable = process.env["WORSHIP_E2E_EXECUTABLE"];
  test.skip(!executable, "only a package has its fuses flipped");
  const wire = await fuses.getCurrentFuseWire(executable!);
  // Each fuse is one ASCII byte of the wire: "1" on, "0" off.
  const on = (option: fuses.FuseV1Options): boolean => Number(wire[option]) === "1".charCodeAt(0);
  const { FuseV1Options: fuse } = fuses;
  expect({
    runAsNode: on(fuse.RunAsNode),
    nodeOptions: on(fuse.EnableNodeOptionsEnvironmentVariable),
    asarIntegrity: on(fuse.EnableEmbeddedAsarIntegrityValidation),
    onlyAsar: on(fuse.OnlyLoadAppFromAsar),
  }).toEqual({ runAsNode: false, nodeOptions: false, asarIntegrity: true, onlyAsar: true });
});
