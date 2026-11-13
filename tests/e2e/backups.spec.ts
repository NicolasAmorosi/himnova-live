import fs from "node:fs";
import path from "node:path";
import type { Locator } from "@playwright/test";
import Database from "better-sqlite3";
import { fixture } from "./support/paths";
import { expect, relaunch, test, type WorshipApp } from "./support/app";

/**
 * Settings › Backups (owner, 2026-11-13): a copy made now, one restored (the app restarts and swaps
 * it in before opening the database), the restore undone from its own «Before restoring» copy, and a file
 * that is not a Himnova copy refused without restarting. `app.relaunch` is a no-op here: Playwright
 * relaunches the app itself, on the same profile.
 */

const toast = (app: WorshipApp, text: string | RegExp) => app.control.getByRole("status").filter({ hasText: text });

/** Settings › Backups, opened if it is not already. */
async function backupsGroup(app: WorshipApp): Promise<Locator> {
  const settings = app.control.getByRole("dialog", { name: "Configuración" });
  if (!(await settings.isVisible())) await app.control.getByRole("button", { name: "Configuración" }).click();
  await settings.getByRole("tab", { name: "Copias de seguridad" }).click();
  return settings;
}

async function openRestore(app: WorshipApp): Promise<Locator> {
  const settings = await backupsGroup(app);
  await settings.getByRole("button", { name: "Restaurar…" }).click();
  return app.control.getByRole("dialog", { name: "Restaurar una copia" });
}

const programs = async (app: WorshipApp) =>
  (await app.invoke<{ name: string }[]>("programs:list")).map((program) => program.name).sort();

/** «Restaurar y reiniciar» with nothing at risk: the app quits, and comes back on the same profile. */
async function restoreAndRestart(app: WorshipApp, dialog: Locator): Promise<WorshipApp> {
  await app.electron.evaluate(({ app: electronApp }) => {
    electronApp.relaunch = () => undefined;
  });
  await dialog.getByRole("button", { name: "Restaurar y reiniciar" }).click();
  await app.exited;
  return relaunch(app);
}

test("a copy made now is restored, and the restore is undone from its «Antes de restaurar» copy", async ({ app }) => {
  await app.invoke("programs:save", { name: "Culto de ayer", items: [] });
  const settings = await backupsGroup(app);
  await settings.getByRole("button", { name: "Hacer una copia" }).click();
  await expect(toast(app, /^Copia hecha: /)).toBeVisible();
  await app.invoke("programs:save", { name: "Culto de hoy", items: [] });

  let dialog = await openRestore(app);
  const copy = dialog.getByRole("radio");
  await expect(copy).toHaveCount(1);
  await expect(copy).toContainText("Copia · 1 programa · 0 canciones");
  await expect(copy).toHaveAttribute("aria-checked", "true");
  let again = await restoreAndRestart(app, dialog);

  await expect(toast(again, /^Se restauró la copia del /)).toBeVisible();
  expect(await programs(again)).toEqual(["Culto de ayer"]);

  dialog = await openRestore(again);
  await expect(dialog.getByRole("radio")).toHaveCount(2);
  const before = dialog.getByRole("radio").filter({ hasText: "Antes de restaurar" });
  await expect(before).toContainText("2 programas");
  await before.click();
  again = await restoreAndRestart(again, dialog);

  await expect(toast(again, /^Se restauró la copia del /)).toBeVisible();
  expect(await programs(again)).toEqual(["Culto de hoy", "Culto de ayer"].sort());
});

test("a file that is not a Himnova copy is refused, and nothing restarts", async ({ app }) => {
  const notes = path.join(app.profile, "notas.db");
  fs.writeFileSync(notes, "esto no es una copia");
  const dialog = await openRestore(app);
  await expect(dialog.getByText("Todavía no hay copias.")).toBeVisible();

  await app.answerOpenDialog(notes);
  await dialog.getByRole("button", { name: "Elegir otra copia…" }).click();
  await expect(dialog.getByRole("radio").filter({ hasText: "Otro archivo" })).toHaveAttribute("aria-checked", "true");
  await dialog.getByRole("button", { name: "Restaurar y reiniciar" }).click();

  await expect(toast(app, "No se pudo leer ese archivo: no es una copia de Himnova Live.")).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(fs.existsSync(path.join(app.profile, "backups", "restore-pending"))).toBe(false);
});

test("another app's database is refused, and the next launch still opens the church's own", async ({ app }) => {
  await app.invoke("programs:save", { name: "Culto de hoy", items: [] });
  // A real SQLite file, opened and read to the end: the path that left the copy staged on Windows (2.9.0).
  const other = path.join(app.profile, "contactos.db");
  const sqlite = new Database(other);
  sqlite.exec("CREATE TABLE contacts (name TEXT)");
  sqlite.close();
  const dialog = await openRestore(app);
  await app.answerOpenDialog(other);
  await dialog.getByRole("button", { name: "Elegir otra copia…" }).click();
  await dialog.getByRole("button", { name: "Restaurar y reiniciar" }).click();

  await expect(toast(app, "Ese archivo no es una copia de Himnova Live.")).toBeVisible();
  expect(fs.existsSync(path.join(app.profile, "backups", "restore-pending"))).toBe(false);
  await app.quit();
  const again = await relaunch(app);
  expect(await programs(again)).toEqual(["Culto de hoy"]);
});

test("with unsaved work, restoring asks first, and «Cancelar» keeps everything as it was", async ({ app }) => {
  await app.invoke("library:add", { kind: "image", paths: [fixture("photo.png")] });
  await app.previewFile("Imágenes", "photo");
  await app.control.getByRole("tabpanel", { name: "Imágenes" }).getByRole("button", { name: "Agregar al programa" }).click();
  const settings = await backupsGroup(app);
  await settings.getByRole("button", { name: "Hacer una copia" }).click();
  await expect(toast(app, /^Copia hecha: /)).toBeVisible();

  const dialog = await openRestore(app);
  await dialog.getByRole("button", { name: "Restaurar y reiniciar" }).click();
  const question = app.control.getByRole("dialog", { name: "¿Restaurar y reiniciar?" });
  await expect(question).toContainText("cambios sin guardar");
  await question.getByRole("button", { name: "Cancelar" }).click();

  await expect(question).toBeHidden();
  await expect(dialog).toBeVisible();
  expect(fs.existsSync(path.join(app.profile, "backups", "restore-pending"))).toBe(false);
});
