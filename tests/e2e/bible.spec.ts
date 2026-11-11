import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, relaunch, test, type WorshipApp } from "./support/app";
import { fixture } from "./support/paths";

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
  await control.getByRole("group", { name: "Modo de búsqueda" }).getByRole("button", { name: "Texto", exact: true }).click();
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
  await row.getByRole("button", { name: "Usar como predeterminada" }).click();
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

  const rename = versions.getByRole("group", { name: "Prueba" }).getByRole("button", { name: "Renombrar" });
  await rename.click();
  const name = settings.getByRole("textbox", { name: "Nombre de la versión" });
  // A blank name is no name: the version keeps its own.
  await name.fill("   ");
  await name.press("Enter");
  await expect(versions.getByRole("group", { name: "Prueba" })).toBeVisible();
  await rename.click();
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
  await settings.getByRole("combobox", { name: "Mayúsculas" }).click();
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

  // Importing lives inside the picker (owner, 2026-11-05) and leaves the new image chosen.
  const other = path.join(os.tmpdir(), `worship-e2e-imported-${Date.now()}.png`);
  fs.copyFileSync(fixture("photo.png"), other);
  try {
    await app.answerOpenDialog(other);
    await picker.getByRole("combobox").click();
    await app.control.getByRole("option", { name: "Importar imagen…" }).click();
    await expect(picker.getByRole("combobox")).toHaveText(/worship-e2e-imported/);
  } finally {
    fs.rmSync(other, { force: true });
  }
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

  // Projected from the program, never from the Bible tab: a recent passage all the same.
  await again.openResources("Biblia");
  const tab = again.control.getByRole("tabpanel", { name: "Biblia" });
  await tab.getByRole("button", { name: "Favoritos y recientes" }).click();
  await expect(tab.getByRole("region", { name: "Recientes" }).getByRole("listitem")).toHaveText(["Juan 3:16"]);
});

test("a verse of the program previews its whole chapter, and another verse is walked as in the Bible tab", async ({ app }) => {
  const { control } = app;
  await app.openChapter("Juan 3");
  await control.getByRole("listitem").filter({ hasText: JUAN_3_16 }).click();
  await control.getByRole("tabpanel", { name: "Biblia" }).getByRole("button", { name: "Agregar al programa" }).click();
  // The Bible tab elsewhere: the chapter PREVIEW shows has to be the row's own.
  await app.openChapter("Salmos 23");
  await control.getByRole("main").getByRole("list").first().getByRole("listitem").filter({ hasText: "Juan 3:16" }).click();

  const grid = app.previewColumn().getByRole("list", { name: "Biblia" });
  await expect(grid.getByRole("button", { name: / 16$/ })).toHaveAttribute("aria-current", "true");
  await expect(grid.getByText(JUAN_3_17)).toBeVisible();
  await expect(grid.locator('[aria-current="true"]')).toHaveCount(1);
  // Only selecting a row moved nothing in the Bible tab.
  await expect(control.getByRole("tabpanel", { name: "Biblia" }).getByText("JEHOVA es mi pastor", { exact: false })).toBeVisible();

  // EN VIVO sends the row itself.
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toBeVisible();

  // ↓ walks out of the row into its chapter, which the Bible tab now holds —
  // its pickers too.
  await control.keyboard.press("ArrowDown");
  await expect(grid.getByRole("button", { name: / 17$/ })).toHaveAttribute("aria-current", "true");
  const tab = control.getByRole("tabpanel", { name: "Biblia" });
  await expect(tab.getByText(JUAN_3_17)).toBeVisible();
  await expect(tab.getByRole("combobox", { name: "Libro", exact: true })).toHaveText("Juan");
  // The row's verse is the live one of that chapter: → walks the projector on from it.
  await control.keyboard.press("ArrowRight");
  await expect(projector.getByText(JUAN_3_17, { exact: false })).toBeVisible();
});

test("a starred verse and the passage read live come back from Favoritos y recientes, after a restart too", async ({
  app,
}) => {
  const { control } = app;
  const panel = control.getByRole("tabpanel", { name: "Biblia" });
  await app.openChapter("Juan 3");
  await panel.getByRole("listitem").filter({ hasText: JUAN_3_16 }).click();
  await panel.getByRole("button", { name: "Marcar como favorito" }).click();
  await expect(panel.getByRole("button", { name: "Quitar de favoritos" })).toHaveAttribute("aria-pressed", "true");

  // Read on through the chapter: one recent passage, not two.
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toBeVisible();
  await control.keyboard.press("ArrowRight");
  await expect(projector.getByText(JUAN_3_17, { exact: false })).toBeVisible();
  await app.quit();

  const again = await relaunch(app);
  const tab = again.control.getByRole("tabpanel", { name: "Biblia" });
  await again.openChapter("Salmos 23");
  await tab.getByRole("button", { name: "Favoritos y recientes" }).click();
  await expect(tab.getByRole("region", { name: "Favoritos" }).getByRole("listitem")).toHaveText(["Juan 3:16"]);
  await expect(tab.getByRole("region", { name: "Recientes" }).getByRole("listitem")).toHaveText(["Juan 3:16-17"]);

  // A click opens the chapter with that verse in PREVIEW, starred.
  await tab.getByRole("region", { name: "Favoritos" }).getByRole("listitem").click();
  await expect(tab.getByRole("listitem").filter({ hasText: JUAN_3_16 })).toHaveAttribute("aria-current", "true");
  await expect(tab.getByRole("button", { name: "Quitar de favoritos" })).toBeVisible();
  // The pickers follow it, so the next chapter is one step away.
  await expect(tab.getByRole("combobox", { name: "Libro" })).toHaveText("Juan");
  await expect(tab.getByRole("combobox", { name: "Capítulo" })).toHaveText("3");
});

const bibleTab = (app: WorshipApp) => app.control.getByRole("tabpanel", { name: "Biblia" });
const scheduleRows = (app: WorshipApp) => app.control.getByRole("main").getByRole("list").first().getByRole("listitem");

/** «Prueba» imported in Ajustes ▸ Biblia, which is left open. */
async function importPrueba(app: WorshipApp) {
  const settings = await openBibleSettings(app);
  await app.answerOpenDialog(writeZefania(app.profile, "Prueba"));
  await settings.getByRole("button", { name: "Importar", exact: true }).click();
  await expect(toast(app, "Se importó Prueba")).toBeVisible();
  return settings;
}

async function deletePrueba(app: WorshipApp) {
  const settings = await openBibleSettings(app);
  await settings.getByRole("list", { name: "Versiones instaladas" }).getByRole("group", { name: "Prueba" }).getByRole("button", { name: "Eliminar" }).click();
  const confirm = app.control.getByRole("dialog", { name: "¿Eliminar esta versión?" });
  return { settings, confirm };
}

async function pickVersion(app: WorshipApp, name: string) {
  await app.openResources("Biblia");
  await bibleTab(app).getByRole("combobox", { name: "Versión" }).click();
  await app.control.getByRole("option", { name, exact: true }).click();
}

async function saveProgramAs(app: WorshipApp, name: string) {
  await app.control.getByRole("button", { name: "Guardar", exact: true }).click();
  const programs = app.control.getByRole("dialog", { name: "Programas" });
  await programs.getByRole("textbox", { name: "Nombre" }).fill(name);
  await programs.getByRole("button", { name: "Guardar", exact: true }).last().click();
  await expect(toast(app, `"${name}" guardado`)).toBeVisible();
  await programs.getByRole("button", { name: "Cerrar" }).click();
}

test("the reference finder reads Spanish abbreviations and whole references as the book they mean", async ({ app }) => {
  await app.openChapter("Juan 3");
  const search = bibleTab(app).getByRole("textbox", { name: "Libro, capítulo y versículo…" });
  const first = bibleTab(app).getByRole("listitem").first();
  // The standard Spanish abbreviations, as RVR, NVI and DHH print them.
  for (const [typed, book] of [
    ["Ro 8", "Romanos 8"],
    ["Is 40", "Isaías 40"],
    ["Os 1", "Oseas 1"],
    ["Am 1", "Amós 1"],
    ["Ec 3", "Eclesiastés 3"],
    ["He 11", "Hebreos 11"],
    ["Jn 3", "Juan 3"],
    ["Lc 15", "Lucas 15"],
    ["Mr 1", "Marcos 1"],
    ["Hch 2", "Hechos 2"],
    ["Ap 21", "Apocalipsis 21"],
    ["1 Co 13", "1 Corintios 13"],
    ["genesis 1", "Génesis 1"],
  ]) {
    await search.fill(typed!);
    await expect(first, typed).toHaveText(book!);
  }
  // A verse, a range, a dot for the colon: still its chapter.
  for (const typed of ["Juan 3:16", "Juan 3:16-18", "Jn 3.16"]) {
    await search.fill(typed);
    await expect(first, typed).toContainText("Juan 3");
  }
});

test("the pickers are typed: a book by its abbreviation, its chapter, then the verse in the search field (owner, 2026-11-10)", async ({ app }) => {
  const { control } = app;
  await app.openResources("Biblia");
  const tab = bibleTab(app);
  await tab.getByRole("combobox", { name: "Libro" }).click();
  await control.keyboard.type("apoc");
  await control.keyboard.press("Enter");
  await expect(tab.getByRole("combobox", { name: "Libro" })).toHaveText("Apocalipsis");
  // Picked with the keyboard, the chapter's picker opened by itself with its filter focused: «2» lists 2, 12, 20–22 and the 2 is the pick.
  await control.keyboard.type("2");
  await control.keyboard.press("Enter");
  await expect(tab.getByRole("combobox", { name: "Capítulo" })).toHaveText("2");
  await expect(tab.getByRole("listitem").first()).toContainText("al ángel de la iglesia en EFESO");
  // Picked with the keyboard, the chapter hands the keys to the search field: a number alone is its verse.
  const search = tab.getByRole("textbox", { name: "Libro, capítulo y versículo…" });
  await expect(search).toBeFocused();
  await control.keyboard.type("10");
  await expect(tab.getByRole("listitem")).toHaveText(["Apocalipsis 2:10"]);
  await control.keyboard.press("Enter");
  await expect(control.getByText("Apocalipsis 2:10").first()).toBeVisible();
  expect(app.hasProjector()).toBe(false);
  // «Juan 3 16», with a space: the verse too.
  await search.fill("Juan 3 16");
  await expect(tab.getByRole("listitem").first()).toHaveText("Juan 3:16");
});

test("a word search finds without accents, and quotes or search operators typed in it break nothing", async ({ app }) => {
  await app.openResources("Biblia");
  await bibleTab(app).getByRole("group", { name: "Modo de búsqueda" }).getByRole("button", { name: "Texto", exact: true }).click();
  const search = bibleTab(app).getByRole("textbox", { name: "Buscar texto…" });
  await search.fill("jehova es mi pastor");
  await expect(bibleTab(app).getByRole("listitem").first()).toContainText("Salmos 23:1");
  // What FTS5 would read as its own syntax is the operator's text, never a query error.
  for (const typed of ['amor"', '"""', "***", "dios OR", "NEAR(dios", "-dios", "^dios", "dios:", "a.b.c", "((("]) {
    await search.fill(typed);
    await app.control.waitForTimeout(350);
  }
  await expect(toast(app, "error inesperado")).toHaveCount(0);
  await search.fill("senor");
  await expect(bibleTab(app).getByRole("listitem").first()).toBeVisible();
});

test("the same Bible file imported twice is refused, naming the version it already is (2026-11-06)", async ({ app }) => {
  const settings = await openBibleSettings(app);
  const file = writeZefania(app.profile, "Doble");
  await app.answerOpenDialog(file);
  await settings.getByRole("button", { name: "Importar", exact: true }).click();
  await expect(toast(app, "Se importó Doble")).toBeVisible();
  await app.answerOpenDialog(file);
  await settings.getByRole("button", { name: "Importar", exact: true }).click();
  await expect(toast(app, "Ese archivo ya está instalado: es «Doble».")).toBeVisible();
  expect((await app.invoke<{ name: string }[]>("bible:versions")).filter((version) => version.name === "Doble")).toHaveLength(1);
});

test("switching the version keeps the chapter being read", async ({ app }) => {
  const settings = await importPrueba(app);
  await settings.getByRole("button", { name: "Volver" }).click();
  await app.openChapter("Juan 3");
  await bibleTab(app).getByRole("listitem").filter({ hasText: JUAN_3_16 }).click();
  await pickVersion(app, "Prueba");
  await expect(bibleTab(app).getByRole("listitem").filter({ hasText: "Texto de prueba dieciséis." })).toBeVisible();
});

test("a verse whose version was deleted, in the unsaved order of service, still lets the program be saved", async ({ app }) => {
  const settings = await importPrueba(app);
  await settings.getByRole("button", { name: "Volver" }).click();
  await pickVersion(app, "Prueba");
  await app.openChapter("Juan 3");
  await bibleTab(app).getByRole("listitem").filter({ hasText: "Texto de prueba dieciséis." }).click();
  await bibleTab(app).getByRole("button", { name: "Agregar al programa" }).click();
  await expect(scheduleRows(app)).toHaveText([/Juan 3:16/]);

  const { settings: again, confirm } = await deletePrueba(app);
  await confirm.getByRole("button", { name: /Eliminar/ }).last().click();
  await expect(toast(app, "Se eliminó «Prueba»")).toBeVisible();
  await again.getByRole("button", { name: "Volver" }).click();

  // The row keeps its text and reference (the version's key is `set null` by design)…
  await expect(scheduleRows(app)).toHaveText([/Juan 3:16/]);
  // …and carries no id of what is gone, or the new program would be refused.
  await saveProgramAs(app, "Con versión borrada");
  await expect(toast(app, "No se pudo")).toHaveCount(0);
});

test("a saved program whose verse's version was deleted is named before, and can be saved again after", async ({ app }) => {
  const settings = await importPrueba(app);
  await settings.getByRole("button", { name: "Volver" }).click();
  await pickVersion(app, "Prueba");
  await app.openChapter("Juan 3");
  await bibleTab(app).getByRole("listitem").filter({ hasText: "Texto de prueba dieciséis." }).click();
  await bibleTab(app).getByRole("button", { name: "Agregar al programa" }).click();
  await saveProgramAs(app, "Culto");

  const { settings: again, confirm } = await deletePrueba(app);
  await expect(confirm).toContainText("Culto");
  await confirm.getByRole("button", { name: /Eliminar/ }).last().click();
  await expect(toast(app, "Se eliminó «Prueba»")).toBeVisible();
  await again.getByRole("button", { name: "Volver" }).click();

  // An edit to the open program, then the top bar's «Guardar» writes over it.
  await app.openChapter("Juan 3");
  await bibleTab(app).getByRole("listitem").filter({ hasText: JUAN_3_16 }).click();
  await bibleTab(app).getByRole("button", { name: "Agregar al programa" }).click();
  await app.control.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(toast(app, '"Culto" guardado').last()).toBeVisible();
  await expect(toast(app, "No se pudo guardar")).toHaveCount(0);
  const [saved] = await app.invoke<{ itemCount: number }[]>("programs:list");
  expect(saved?.itemCount).toBe(2);
});

test("a program's verse sent live: → and a remote's PageDown walk on through its chapter, and a verse sent from PREVIEW takes the rail", async ({
  app,
}) => {
  const { control } = app;
  await app.openChapter("Juan 3");
  await control.getByRole("listitem").filter({ hasText: JUAN_3_16 }).click();
  await bibleTab(app).getByRole("button", { name: "Agregar al programa" }).click();
  // The Bible tab elsewhere: the chapter walked has to be the row's own.
  await app.openChapter("Salmos 23");
  const row = scheduleRows(app).filter({ hasText: "Juan 3:16" });
  const rail = row.locator("span.bg-on-air");

  await row.dblclick();
  const projector = await app.projector();
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toBeVisible();
  await expect(rail).toHaveCount(1);
  await control.keyboard.press("ArrowRight");
  await expect(projector.getByText(JUAN_3_17, { exact: false })).toBeVisible();

  // The preacher's remote, right after the row went live.
  await row.dblclick();
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toBeVisible();
  await control.keyboard.press("PageDown");
  await expect(projector.getByText(JUAN_3_17, { exact: false })).toBeVisible();

  // Another verse of the row's chapter, double-clicked in PREVIEW: live, and no longer the row's.
  await row.dblclick();
  await expect(rail).toHaveCount(1);
  await app.previewColumn().getByRole("list", { name: "Biblia" }).getByRole("button", { name: / 17$/ }).dblclick();
  await expect(projector.getByText(JUAN_3_17, { exact: false })).toBeVisible();
  await expect(rail).toHaveCount(0);
  await control.keyboard.press("ArrowLeft");
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toBeVisible();
});

test("a colour picked for the verse reaches the live verse at once and is kept after a restart; «Restaurar» undoes it", async ({
  app,
}) => {
  const projector = await verseLive(app);
  const verse = projector.getByText(JUAN_3_16, { exact: false });
  const style = await openVerseStyle(app);
  await style.locator("details").filter({ hasText: "El versículo" }).getByRole("button", { name: "Color", exact: true }).first().click();
  const hex = app.control.getByRole("dialog", { name: "Color", exact: true }).locator('input:not([type="color"])');
  await hex.fill("#ffa92d");
  await hex.press("Enter");
  await app.control.keyboard.press("Escape");
  await expect.poll(() => verse.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(255, 169, 45)");
  await style.getByRole("button", { name: "Volver" }).click();
  await app.quit("close");

  type Stored = Record<string, { text: { color: string } } | undefined>;
  const again = await relaunch(app);
  expect((await again.invoke<Stored>("settings:get"))["bible.style"]?.text.color).toBe("#ffa92d");
  await (await openVerseStyle(again)).getByRole("button", { name: "Restaurar el estilo original" }).click();
  await again.control.getByRole("dialog", { name: "¿Restaurar el estilo del versículo?" }).getByRole("button", { name: "Confirmar" }).click();
  await expect(toast(again, "Se restauró el estilo original")).toBeVisible();
  expect((await again.invoke<Stored>("settings:get"))["bible.style"]?.text.color).not.toBe("#ffa92d");
});
