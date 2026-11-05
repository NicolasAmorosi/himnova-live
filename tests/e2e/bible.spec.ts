import fs from "node:fs";
import path from "node:path";
import { expect, relaunch, test, type WorshipApp } from "./support/app";

const JUAN_3_16 = "Porque de tal manera amó Dios al mundo";
const JUAN_3_17 = "Porque no envió Dios á su Hijo al mundo";

test("a verse found by book and chapter is previewed, projected and stepped through", async ({ app }) => {
  const { control } = app;
  await app.openChapter("Juan 3");
  await control.getByRole("listitem").filter({ hasText: JUAN_3_16 }).click();

  // PREVIEW has it; nothing reached a projector.
  await expect(control.getByText("Juan 3:16").first()).toBeVisible();
  expect(app.hasProjector()).toBe(false);

  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toBeVisible();

  // → steps the projected passage, not just the preview.
  await control.keyboard.press("ArrowRight");
  await expect(projector.getByText(JUAN_3_17, { exact: false })).toBeVisible();
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toHaveCount(0);
});

test("a word search across the whole Bible finds the verse", async ({ app }) => {
  const { control } = app;
  await control.getByRole("button", { name: /Cambiar a búsqueda de texto completo/ }).click();
  await control.getByRole("textbox", { name: "Buscar texto…" }).fill("unigénito para que todo aquel");
  await control.keyboard.press("Enter");
  // Each hit says which verse it is, not just the snippet around the match.
  const hit = control.getByRole("tabpanel", { name: "Biblia" }).getByRole("listitem").first();
  await expect(hit).toContainText("Juan 3:16");
  await hit.click();
  await app.goLive();
  await expect((await app.projector()).getByText(JUAN_3_16, { exact: false })).toBeVisible();
});

test("after clicking EN VIVO, the arrows and Space still belong to the operator", async ({ app }) => {
  const { control } = app;
  await app.openChapter("Juan 3");
  await control.getByRole("listitem").filter({ hasText: JUAN_3_16 }).click();
  // A real mouse click leaves EN VIVO focused, the way an operator's does.
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toBeVisible();

  await control.keyboard.press("ArrowRight");
  await expect(projector.getByText(JUAN_3_17, { exact: false })).toBeVisible();
  // Space must not press EN VIVO again: that would send PREVIEW (still 3:16)
  // back to the projector.
  await control.keyboard.press("Space");
  await control.waitForTimeout(800);
  await expect(projector.getByText(JUAN_3_17, { exact: false })).toBeVisible();
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toHaveCount(0);
});

/** A small Zefania XML Bible, the most common free format there is. */
function writeZefania(dir: string, name: string): string {
  const file = path.join(dir, `${name}.xml`);
  fs.writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>
<XMLBIBLE biblename="${name}">
  <BIBLEBOOK bnumber="1" bname="Génesis">
    <CHAPTER cnumber="1"><VERS vnumber="1">Primer versículo de prueba.</VERS></CHAPTER>
  </BIBLEBOOK>
  <BIBLEBOOK bnumber="43" bname="Juan">
    <CHAPTER cnumber="3">
      <VERS vnumber="16">Texto de prueba dieciséis.</VERS>
      <VERS vnumber="17">Texto de prueba diecisiete.</VERS>
    </CHAPTER>
  </BIBLEBOOK>
</XMLBIBLE>`,
  );
  return file;
}

async function openBibleSettings(app: WorshipApp) {
  await app.control.getByRole("button", { name: "Configuración" }).click();
  const settings = app.control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Biblia" }).click();
  return settings;
}

/** The verse's look: the palette at the foot of the Bible tab, a full-screen editor. */
async function openVerseStyle(app: WorshipApp) {
  await app.openResources("Biblia");
  await app.control.getByRole("tabpanel", { name: "Biblia" }).getByRole("button", { name: "Estilo del versículo" }).click();
  return app.control.getByRole("dialog", { name: "Estilo del versículo" });
}

async function verseLive(app: WorshipApp) {
  await app.openChapter("Juan 3");
  await app.control.getByRole("listitem").filter({ hasText: JUAN_3_16 }).click();
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toBeVisible();
  return projector;
}

const toast = (app: WorshipApp, text: string) => app.control.getByRole("status").filter({ hasText: text });

test("a Bible imported in Ajustes becomes the default and projects its own text", async ({ app }) => {
  const settings = await openBibleSettings(app);
  await app.answerOpenDialog(writeZefania(app.profile, "Prueba"));
  await settings.getByRole("button", { name: "Importar", exact: true }).click();
  await expect(toast(app, "Se importó Prueba (3 versículos)")).toBeVisible();

  const row = settings.getByRole("list", { name: "Versiones instaladas" }).getByRole("group", { name: "Prueba" });
  await row.getByRole("button", { name: "Usar por defecto" }).click();
  await expect(toast(app, "La pestaña Biblia va a abrir en Prueba")).toBeVisible();
  await app.quit();

  const again = await relaunch(app);
  await again.openChapter("Juan 3");
  await again.control.getByRole("listitem").filter({ hasText: "Texto de prueba dieciséis." }).click();
  await again.goLive();
  await expect((await again.projector()).getByText("Texto de prueba dieciséis.")).toBeVisible();
});

test("an imported version is renamed and deleted, and the Bible tab falls back to RV1909", async ({ app }) => {
  const settings = await openBibleSettings(app);
  await app.answerOpenDialog(writeZefania(app.profile, "Prueba"));
  await settings.getByRole("button", { name: "Importar", exact: true }).click();
  await expect(toast(app, "Se importó Prueba")).toBeVisible();
  const versions = settings.getByRole("list", { name: "Versiones instaladas" });

  await versions.getByRole("group", { name: "Prueba" }).getByRole("button", { name: "Renombrar" }).click();
  const name = settings.getByRole("textbox", { name: "Nombre de la versión" });
  await name.fill("PRB");
  await name.press("Enter");
  await expect(toast(app, "Ahora se llama «PRB»")).toBeVisible();

  await versions.getByRole("group", { name: "PRB" }).getByRole("button", { name: "Eliminar" }).click();
  await app.control.getByRole("dialog", { name: "¿Eliminar esta versión?" }).getByRole("button", { name: "Eliminar" }).click();
  await expect(toast(app, "Se eliminó «PRB»")).toBeVisible();
  await expect(versions.getByRole("group", { name: "PRB" })).toHaveCount(0);
  await expect(versions.getByRole("group", { name: /RV1909|Reina/ })).toHaveCount(1);
});

for (const [file, contents] of [
  ["notas.xml", '<?xml version="1.0"?><notas><nota>hola</nota></notas>'],
  ["config.json", '{"hola": 1}'],
] as const) {
  test(`a file that is not a Bible (${file}) is refused in Spanish, and nothing is installed`, async ({ app }) => {
    const notABible = path.join(app.profile, file);
    fs.writeFileSync(notABible, contents);
    const settings = await openBibleSettings(app);
    const before = await settings.getByRole("list", { name: "Versiones instaladas" }).getByRole("group").count();
    await app.answerOpenDialog(notABible);
    await settings.getByRole("button", { name: "Importar", exact: true }).click();
    const refusal = app.control.getByRole("status").last();
    await expect(refusal).toBeVisible();
    // Whatever the wording, it is for the operator: Spanish, not a parser's English.
    expect(await refusal.innerText()).not.toMatch(/root element|Unrecognized|shape|Error:|undefined/i);
    await expect(settings.getByRole("list", { name: "Versiones instaladas" }).getByRole("group")).toHaveCount(before);
  });
}

test("the verse style edited from the Bible tab reaches the verse already on the projector", async ({ app }) => {
  const projector = await verseLive(app);
  const stage = projector.locator("body");
  await expect(stage).toContainText("Juan 3:16");

  const settings = await openVerseStyle(app);
  await settings.getByRole("group", { name: "Mayúsculas" }).getByRole("combobox").click();
  await app.control.getByRole("option", { name: "TODO EN MAYÚSCULAS" }).click();
  await expect(stage).toContainText("JUAN 3:16");

  await settings.getByRole("group", { name: "Mostrar la referencia" }).getByRole("switch").click();
  await expect(stage).not.toContainText(/juan 3:16/i);
  await expect(stage).toContainText(JUAN_3_16);

  await settings.getByRole("button", { name: "Restaurar el estilo original" }).click();
  await app.control.getByRole("dialog", { name: "¿Restaurar el estilo del versículo?" }).getByRole("button", { name: /Restaurar|Confirmar/ }).click();
  await expect(stage).toContainText("Juan 3:16");
  // Restyled in place, never re-sent: still the same verse.
  await expect(stage).toContainText(JUAN_3_16);
});

test("an image background for the verse can be picked: nothing is saved until the image is", async ({ app }) => {
  const [photo] = await app.addMedia("image", "photo.png");
  const projector = await verseLive(app);
  const settings = await openVerseStyle(app);

  await settings.getByRole("group", { name: "Tipo de fondo" }).getByRole("combobox").click();
  await app.control.getByRole("option", { name: "Imagen", exact: true }).click();
  // It used to save `assetId: 0` at once, which main refuses: an error toast
  // and the kind snapping back to the solid colour.
  const picker = settings.getByRole("group", { name: "Imagen", exact: true });
  await expect(picker.getByRole("combobox")).toHaveText(/Elegí una imagen/);
  await app.control.waitForTimeout(500);
  await expect(app.control.getByRole("status").filter({ hasText: "error inesperado" })).toHaveCount(0);

  await picker.getByRole("combobox").click();
  await app.control.getByRole("option", { name: "photo" }).click();
  await expect(projector.locator(`img[src="worship://asset/${photo?.id}"]`)).toBeVisible();
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toBeVisible();
});

test("↑/↓ only move PREVIEW; the LIVE transport and grid step the projected passage", async ({ app }) => {
  const projector = await verseLive(app);
  const live = app.liveColumn();
  await expect(live.getByText("16/36", { exact: true })).toBeVisible();

  // PREVIEW walks on, the projector does not…
  await app.control.keyboard.press("ArrowDown");
  await app.control.keyboard.press("ArrowDown");
  await app.control.waitForTimeout(500);
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toBeVisible();
  // …until EN VIVO.
  await app.control.keyboard.press("Enter");
  await expect(projector.getByText("El que en él cree, no es condenado", { exact: false })).toBeVisible();
  await expect(live.getByText("18/36", { exact: true })).toBeVisible();

  await live.getByRole("button", { name: "Siguiente" }).click();
  await expect(projector.getByText("Y esta es la condenación", { exact: false })).toBeVisible();
  await live.getByRole("button", { name: "Anterior" }).click();
  await expect(projector.getByText("El que en él cree, no es condenado", { exact: false })).toBeVisible();
  await live.getByRole("list", { name: "Biblia" }).getByRole("button", { name: / 16$/ }).click();
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toBeVisible();
  await expect(live.getByText("16/36", { exact: true })).toBeVisible();
});

test("a verse put in the order of service is projected from the saved program", async ({ app }) => {
  const { control } = app;
  await app.openChapter("Juan 3");
  await control.getByRole("listitem").filter({ hasText: JUAN_3_16 }).click();
  await control.getByRole("tabpanel", { name: "Biblia" }).getByRole("button", { name: "Agregar al programa" }).click();
  const rows = control.getByRole("main").getByRole("list").first().getByRole("listitem");
  await expect(rows).toHaveText([/Juan 3:16/]);

  await control.getByRole("button", { name: "Guardar", exact: true }).click();
  const dialog = control.getByRole("dialog", { name: "Programas" });
  await dialog.getByRole("textbox", { name: "Nombre" }).fill("Con versículo");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).last().click();
  await dialog.getByRole("button", { name: "Cerrar" }).click();
  await app.quit();

  const again = await relaunch(app);
  await again.control.getByRole("button", { name: "Administrar programas" }).click();
  const programs = again.control.getByRole("dialog", { name: "Programas" });
  await programs.getByRole("listitem").filter({ hasText: "Con versículo" }).click();
  await programs.getByRole("button", { name: "Abrir" }).click();
  await again.control.getByRole("main").getByRole("list").first().getByRole("listitem").filter({ hasText: "Juan 3:16" }).dblclick();
  await expect((await again.projector()).getByText(JUAN_3_16, { exact: false })).toBeVisible();
});
