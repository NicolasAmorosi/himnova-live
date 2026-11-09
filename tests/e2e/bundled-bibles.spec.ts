import { expect, test, type WorshipApp } from "./support/app";

/**
 * The Bible versions inside the installer: a Spanish profile starts with the RV1909 alone, and any other is one
 * click away in Ajustes ▸ Biblia — no file, no internet. Once there are two languages, the Bible tab's picker lists
 * the versions under a heading per language.
 */

const toast = (app: WorshipApp, text: string) => app.control.getByRole("status").filter({ hasText: text });
const bibleTab = (app: WorshipApp) => app.control.getByRole("tabpanel", { name: "Biblia" });

async function openBibleSettings(app: WorshipApp) {
  await app.control.getByRole("button", { name: "Configuración" }).click();
  const settings = app.control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Biblia" }).click();
  return settings;
}

test("a version included with the app is installed in Ajustes, listed under its language and projects its own text", async ({
  app,
}) => {
  const settings = await openBibleSettings(app);
  const installed = settings.getByRole("list", { name: "Versiones instaladas" });
  const included = settings.getByRole("list", { name: "Versiones incluidas" });
  await expect(installed.getByRole("list", { name: "Español" }).getByRole("group")).toHaveCount(1);
  // Every other bundled version, under its own language, with the credit its licence asks for.
  await expect(included.getByRole("list", { name: "Inglés" }).getByRole("group")).toHaveCount(3);
  await expect(included.getByRole("group", { name: "Bíblia Livre" })).toContainText("BLIVRE");

  await included.getByRole("group", { name: "King James Version" }).getByRole("button", { name: "Instalar" }).click();
  await expect(toast(app, "Se instaló King James Version")).toBeVisible();
  await expect(installed.getByRole("list", { name: "Inglés" }).getByRole("group", { name: "King James Version" })).toBeVisible();
  await expect(included.getByRole("group", { name: "King James Version" })).toHaveCount(0);
  await expect(included.getByRole("list", { name: "Inglés" }).getByRole("group")).toHaveCount(2);
  await settings.getByRole("button", { name: "Volver" }).click();

  await app.openResources("Biblia");
  await bibleTab(app).getByRole("combobox", { name: "Versión" }).click();
  const listbox = app.control.getByRole("listbox");
  // A heading per language, in the order the operator's list has them, and only the versions are options.
  await expect(listbox.getByRole("listitem")).toHaveCount(0);
  await expect(listbox).toHaveText(/^Español.*Reina-Valera 1909.*Inglés.*King James Version$/);
  await expect(listbox.getByRole("option")).toHaveText(["Reina-Valera 1909", "King James Version"]);
  await listbox.getByRole("option", { name: "King James Version" }).click();

  await bibleTab(app).getByRole("combobox", { name: "Libro" }).click();
  await app.control.getByRole("option", { name: "John", exact: true }).click();
  await bibleTab(app).getByRole("combobox", { name: "Capítulo" }).click();
  await app.control.getByRole("option", { name: "3", exact: true }).click();
  await bibleTab(app).getByRole("listitem").filter({ hasText: "For God so loved the world" }).click();
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText("For God so loved the world", { exact: false })).toBeVisible();
});
