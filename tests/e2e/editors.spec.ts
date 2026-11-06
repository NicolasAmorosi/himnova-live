import type { Locator } from "@playwright/test";
import { expect, relaunch, test, type WorshipApp } from "./support/app";

/**
 * The full-screen look editors — song themes, time scenes, plates, the verse's
 * style — and what they share: unsaved changes, «Duplicar», names, validation,
 * Escape, the fonts they offer. What each look does on the projector is in its
 * feature's spec (`songs`, `functions`, `bible`).
 */

const toast = (app: WorshipApp, text: string) => app.control.getByRole("status").filter({ hasText: text });
const listRows = (editor: Locator, list: string) => editor.getByRole("list", { name: list }).getByRole("listitem");
const nameBox = (editor: Locator) => editor.getByRole("textbox", { name: "Nombre", exact: true });
const saveButton = (editor: Locator) => editor.getByRole("button", { name: "Guardar", exact: true });
const askDiscard = (app: WorshipApp) => app.control.getByRole("dialog", { name: "Hay cambios sin guardar" });

async function openThemes(app: WorshipApp): Promise<Locator> {
  await app.openResources("Canciones");
  await app.control.getByRole("tabpanel", { name: "Canciones" }).getByRole("button", { name: "Temas" }).click();
  const editor = app.control.getByRole("dialog", { name: "Temas" });
  await expect(editor).toBeVisible();
  return editor;
}

async function openScenes(app: WorshipApp): Promise<Locator> {
  await app.openResources("Funciones", "Utilidades");
  await app.control.getByRole("button", { name: "Editar escenas", exact: true }).click();
  const editor = app.control.getByRole("dialog", { name: "Escenas de tiempo" });
  await expect(editor).toBeVisible();
  return editor;
}

async function openPlates(app: WorshipApp): Promise<Locator> {
  await app.openResources("Funciones", "Placas");
  await app.control.getByRole("tabpanel", { name: "Placas" }).getByRole("button", { name: "Editar placas", exact: true }).click();
  const editor = app.control.getByRole("dialog", { name: "Placas" });
  await expect(editor).toBeVisible();
  return editor;
}

async function closeEditor(editor: Locator) {
  await editor.getByRole("button", { name: "Cerrar" }).first().click();
  await expect(editor).toBeHidden();
}

/** A command of the editor's «⋯». */
async function more(app: WorshipApp, editor: Locator, command: "Duplicar" | "Eliminar") {
  await editor.getByRole("button", { name: "Más acciones" }).click();
  await app.control.getByRole("menuitem", { name: command, exact: true }).click();
}

async function choose(app: WorshipApp, scope: Locator, field: string, option: string) {
  await scope.getByRole("combobox", { name: field, exact: true }).click();
  await app.control.getByRole("option", { name: option, exact: true }).click();
}

test("«Duplicar» over unsaved changes, then «Guardar y salir»: the copy is of what was just saved — theme, scene, plate", async ({
  app,
}) => {
  // A theme: the capitals just switched on travel into the copy.
  let editor = await openThemes(app);
  const caps = editor.getByRole("group", { name: "Mayúsculas", exact: true }).getByRole("switch");
  await expect(caps).not.toBeChecked();
  await caps.click();
  await more(app, editor, "Duplicar");
  await askDiscard(app).getByRole("button", { name: "Guardar y salir" }).click();
  await expect(toast(app, "Se guardó «Clásico (copia)»")).toBeVisible();
  await expect(nameBox(editor)).toHaveValue("Clásico (copia)");
  await expect(caps).toBeChecked();
  await closeEditor(editor);

  // A scene: renamed, the copy is named after the new name.
  editor = await openScenes(app);
  await listRows(editor, "Escenas guardadas").filter({ hasText: "Cuenta 10 minutos" }).click();
  await nameBox(editor).fill("Previa del culto");
  await more(app, editor, "Duplicar");
  await askDiscard(app).getByRole("button", { name: "Guardar y salir" }).click();
  await expect(toast(app, "Se guardó «Previa del culto»")).toBeVisible();
  await expect(listRows(editor, "Escenas guardadas").filter({ hasText: "(copia)" })).toHaveCount(1);
  await expect(nameBox(editor)).toHaveValue("Previa del culto (copia)");
  await closeEditor(editor);

  // A plate: the same.
  editor = await openPlates(app);
  await saveButton(editor).click();
  await expect(toast(app, "Se guardó «Placa nueva»")).toBeVisible();
  await nameBox(editor).fill("Predicador");
  await more(app, editor, "Duplicar");
  await askDiscard(app).getByRole("button", { name: "Guardar y salir" }).click();
  await expect(toast(app, "Se guardó «Predicador»")).toBeVisible();
  await expect(nameBox(editor)).toHaveValue("Predicador (copia)");
});

test("a name typed up to the field's own limit can still be duplicated — theme, scene, plate", async ({ app }) => {
  // 80 characters, every name field's `maxLength`: the copy's « (copia)» must not overflow what main accepts.
  const longName = "Nombre larguísimo para probar el límite de ochenta caracteres en el editor xxxxx".slice(0, 80);
  expect(longName).toHaveLength(80);
  const cases: [() => Promise<Locator>, string, number][] = [
    [() => openThemes(app), "Temas guardados", 2],
    [() => openScenes(app), "Escenas guardadas", 5],
    [() => openPlates(app), "Placas guardadas", 2],
  ];
  for (const [open, list, after] of cases) {
    const editor = await open();
    await nameBox(editor).fill(longName);
    await saveButton(editor).click();
    await expect(toast(app, `Se guardó «${longName}»`).last()).toBeVisible();
    await more(app, editor, "Duplicar");
    await expect(listRows(editor, list)).toHaveCount(after);
    await expect(toast(app, "No se pudo guardar")).toHaveCount(0);
    await closeEditor(editor);
  }
});

test("a theme's «Imagen» picked with no image yet stays with that theme — not on another, nor after reopening", async ({ app }) => {
  let editor = await openThemes(app);
  await more(app, editor, "Duplicar");
  await expect(listRows(editor, "Temas guardados")).toHaveCount(2);
  await listRows(editor, "Temas guardados").filter({ hasText: /^Clásico$/ }).click();
  const background = editor.getByRole("combobox", { name: "Tipo de fondo", exact: true });
  await expect(background).toHaveText(/Color sólido/);

  await choose(app, editor, "Tipo de fondo", "Imagen");
  await expect(background).toHaveText(/Imagen/);
  // Nothing chosen yet is not a change: moving on asks nothing…
  await listRows(editor, "Temas guardados").filter({ hasText: "(copia)" }).click();
  await expect(askDiscard(app)).toHaveCount(0);
  // …and the other theme, a solid colour, says so.
  await expect(background).toHaveText(/Color sólido/);

  await closeEditor(editor);
  editor = await openThemes(app);
  await expect(editor.getByRole("combobox", { name: "Tipo de fondo", exact: true })).toHaveText(/Color sólido/);
});

test("a theme with an empty or blank name cannot be saved and says why; leaving offers no «Guardar y salir»", async ({ app }) => {
  const editor = await openThemes(app);
  await nameBox(editor).fill("");
  await expect(saveButton(editor)).toBeDisabled();
  await expect(editor.getByRole("status").filter({ hasText: "Un tema necesita un nombre." })).toBeVisible();
  await nameBox(editor).fill("   ");
  await expect(saveButton(editor)).toBeDisabled();
  await nameBox(editor).press("Enter");
  await expect(toast(app, "Se guardó")).toHaveCount(0);

  await app.control.keyboard.press("Escape");
  await expect(askDiscard(app)).toBeVisible();
  // A draft that cannot be saved cannot be saved on the way out either.
  await expect(askDiscard(app).getByRole("button", { name: "Guardar y salir" })).toHaveCount(0);
  await askDiscard(app).getByRole("button", { name: "Descartar cambios" }).click();
  await expect(editor).toBeHidden();
  await expect(nameBox(await openThemes(app))).toHaveValue("Clásico");
});

test("two themes may share a name; «Descartar» undoes every change; ⌘S saves; the edits survive a restart", async ({ app }) => {
  let editor = await openThemes(app);
  await editor.getByRole("button", { name: "Nuevo tema" }).click();
  await nameBox(editor).fill("Clásico");
  await saveButton(editor).click();
  await expect(toast(app, "Se guardó «Clásico»")).toBeVisible();
  await expect(listRows(editor, "Temas guardados").filter({ hasText: /^Clásico$/ })).toHaveCount(2);

  const caps = () => editor.getByRole("group", { name: "Mayúsculas", exact: true }).getByRole("switch");
  await caps().click();
  await expect(editor.getByText("Editado")).toBeVisible();
  await editor.getByRole("button", { name: "Descartar", exact: true }).click();
  await expect(caps()).not.toBeChecked();
  await expect(editor.getByText("Editado")).toHaveCount(0);

  // ⌘S with the focus in the inspector.
  await nameBox(editor).fill("Para relanzar");
  await caps().click();
  await editor.getByRole("slider", { name: "Espacio entre letras" }).fill("0.2");
  await app.control.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
  await expect(toast(app, "Se guardó «Para relanzar»")).toBeVisible();
  await closeEditor(editor);
  await app.quit();

  const again = await relaunch(app);
  editor = await openThemes(again);
  await listRows(editor, "Temas guardados").filter({ hasText: "Para relanzar" }).click();
  await expect(caps()).toBeChecked();
  await expect(editor.getByRole("slider", { name: "Espacio entre letras" })).toHaveValue("0.2");
});

test("a scene's duration that does not read is flagged and not saved, and leaving the field puts the saved one back", async ({
  app,
}) => {
  const editor = await openScenes(app);
  const duration = editor.getByRole("group", { name: "Duración", exact: true }).getByRole("textbox");
  await expect(duration).toHaveValue("10:00");
  for (const typed of ["abc", "0:00", "99999"]) {
    await duration.fill(typed);
    await expect(duration).toHaveAttribute("aria-invalid", "true");
    await expect(editor.getByText("Editado")).toHaveCount(0);
  }
  await nameBox(editor).click();
  await expect(duration).toHaveValue("10:00");
  // Bare minutes read as minutes.
  await duration.fill("5");
  await nameBox(editor).click();
  await expect(duration).toHaveValue(/^0?5:00$/);
});

test("a plate with nothing to show cannot be saved and says why; a lower third made a bug keeps its title", async ({ app }) => {
  const editor = await openPlates(app);
  await choose(app, editor, "Tipo", "Mosca");
  const title = editor.getByRole("group", { name: "Título", exact: true }).first().getByRole("textbox");
  await expect(title).toHaveValue("Placa nueva");
  await title.fill("");
  await expect(saveButton(editor)).toBeDisabled();
  await expect(editor.getByRole("status").filter({ hasText: "Una placa necesita un nombre y algo que mostrar" })).toBeVisible();
  // The width of a picture that is not there means nothing.
  await expect(editor.getByRole("slider", { name: "Ancho" })).toBeDisabled();
});

test("Escape in an open dropdown or colour popover closes only that, and keeps what was typed in it", async ({ app }) => {
  const editor = await openThemes(app);
  await editor.getByRole("combobox", { name: "Tipo de fondo", exact: true }).click();
  await expect(app.control.getByRole("option", { name: "Degradado" })).toBeVisible();
  await app.control.keyboard.press("Escape");
  await expect(app.control.getByRole("option", { name: "Degradado" })).toHaveCount(0);
  await expect(editor).toBeVisible();

  await editor.getByRole("button", { name: "Color", exact: true }).first().click();
  const popover = app.control.getByRole("dialog", { name: "Color", exact: true });
  await expect(popover).toBeVisible();
  await popover.locator('input:not([type="color"])').fill("#123456");
  await app.control.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(editor).toBeVisible();
  // The hex was applied: the theme is edited, and the next Escape asks.
  await expect(editor.getByText("Editado")).toBeVisible();
  await app.control.keyboard.press("Escape");
  await expect(askDiscard(app)).toBeVisible();
});

test("a font whose name the validators refuse is never offered — the verse style and a song theme (owner, 2026-11-06)", async ({
  app,
}) => {
  // «Mom's Typewriter» is a real free font, and an apostrophe is what the
  // validators refuse: picking it could only fail. The machine's font list is
  // replaced before an editor asks for it.
  const font = "Mom's Typewriter";
  await app.control.evaluate((family) => {
    (window as unknown as { queryLocalFonts: () => Promise<{ family: string }[]> }).queryLocalFonts = () =>
      Promise.resolve([{ family }, { family: "Helvetica" }]);
  }, font);
  const expectNotOffered = async (editor: Locator) => {
    await editor.getByRole("combobox", { name: "Fuente", exact: true }).first().click();
    await expect(app.control.getByRole("option", { name: "Helvetica", exact: true })).toBeVisible();
    await expect(app.control.getByRole("option", { name: font, exact: true })).toHaveCount(0);
    await app.control.keyboard.press("Escape");
  };

  await app.openResources("Biblia");
  await app.control.getByRole("button", { name: "Estilo del versículo" }).click();
  const verse = app.control.getByRole("dialog", { name: "Estilo del versículo" });
  await expectNotOffered(verse);
  await verse.getByRole("button", { name: "Volver" }).click();
  await expect(verse).toBeHidden();

  await expectNotOffered(await openThemes(app));
});
