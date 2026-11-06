import type { Locator } from "@playwright/test";
import { expect, relaunch, test, type WorshipApp } from "./support/app";

/**
 * The song editor, control by control: the data fields, the lyrics and their
 * headers, the order (chips, text, «+»), saving, leaving with changes, and what
 * main would refuse. Songs on the projector and in the library are in
 * `songs.spec.ts`; songs that live in a file, in `song-files.spec.ts`.
 */

const tab = (app: WorshipApp) => app.control.getByRole("tabpanel", { name: "Canciones" });
const songRows = (app: WorshipApp) => tab(app).getByRole("list", { name: "Canciones" }).getByRole("listitem");
const editor = (app: WorshipApp) => app.control.getByRole("dialog").first();
const toast = (app: WorshipApp, text: string) => app.control.getByRole("status").filter({ hasText: text });
const field = (app: WorshipApp, name: string) => editor(app).getByRole("textbox", { name, exact: true });
const lyricsBox = (app: WorshipApp) => editor(app).getByRole("textbox", { name: "Letra" });
const saveButton = (app: WorshipApp) => editor(app).getByRole("button", { name: "Guardar", exact: true });
const closeButton = (app: WorshipApp) => editor(app).getByRole("button", { name: "Cerrar" }).first();
const askDiscard = (app: WorshipApp) => app.control.getByRole("dialog", { name: "Hay cambios sin guardar" });
/** The order's chips, as their short labels («E1», «C»…). */
const chips = (app: WorshipApp): Locator =>
  editor(app).getByRole("list", { name: "Orden de la canción" }).getByRole("listitem").filter({ hasText: /\S/ });
/** The editor's own slide column. */
const editorSlides = (app: WorshipApp) => editor(app).getByRole("navigation").getByRole("listitem");
const notProjected = (app: WorshipApp) => editor(app).getByText("No están en el orden y no se proyectan", { exact: false });

async function openNew(app: WorshipApp): Promise<void> {
  await app.openResources("Canciones");
  await tab(app).getByRole("button", { name: "Nueva canción" }).first().click();
  await expect(editor(app)).toBeVisible();
}

async function openSaved(app: WorshipApp, title: string): Promise<void> {
  await app.openResources("Canciones");
  await songRows(app).filter({ hasText: title }).first().click();
  await tab(app).getByRole("button", { name: "Editar canción" }).click();
  await expect(field(app, "Título")).toHaveValue(title);
}

async function save(app: WorshipApp, title: string): Promise<void> {
  await saveButton(app).click();
  await expect(toast(app, `Se guardó «${title}»`).first()).toBeVisible();
}

async function close(app: WorshipApp): Promise<void> {
  await closeButton(app).click();
  await expect(app.control.getByRole("dialog")).toHaveCount(0);
}

async function createSong(app: WorshipApp, title: string, lyrics: string): Promise<void> {
  await openNew(app);
  await field(app, "Título").fill(title);
  await lyricsBox(app).fill(lyrics);
  await save(app, title);
  await close(app);
}

test("every data field, the translation and the theme are saved, and come back the same after a restart", async ({ app }) => {
  // A second theme to choose.
  await app.openResources("Canciones");
  await tab(app).getByRole("button", { name: "Temas" }).click();
  const themes = app.control.getByRole("dialog", { name: "Temas" });
  await themes.getByRole("button", { name: "Nuevo tema" }).click();
  await themes.getByRole("textbox", { name: "Nombre", exact: true }).fill("Segundo tema");
  await themes.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(toast(app, "Se guardó «Segundo tema»")).toBeVisible();
  await themes.getByRole("button", { name: "Cerrar" }).first().click();

  await openNew(app);
  await field(app, "Título").fill("Todos los campos");
  await field(app, "Número").fill("  123  ");
  await field(app, "Autores").fill("Ana, Beto");
  await field(app, "Copyright").fill("© 2001 Dominio público");
  await field(app, "Número CCLI").fill("22025");
  await field(app, "Notas").fill("Primera nota\nsegunda línea");
  await lyricsBox(app).fill("[Estrofa 1]\nuno\n\n[Coro]\ncoro");
  await editor(app).getByRole("tab", { name: "Traducción" }).click();
  await editor(app).getByRole("textbox", { name: "Traducción" }).fill("[Estrofa 1]\none\n\n[Coro]\nchorus");
  await editor(app).getByRole("combobox", { name: "Tema" }).click();
  await app.control.getByRole("option", { name: "Segundo tema" }).click();
  await save(app, "Todos los campos");
  await close(app);

  await app.quit("close");
  const again = await relaunch(app);
  await openSaved(again, "Todos los campos");
  await expect(field(again, "Número")).toHaveValue("123");
  await expect(field(again, "Autores")).toHaveValue("Ana, Beto");
  await expect(field(again, "Copyright")).toHaveValue("© 2001 Dominio público");
  await expect(field(again, "Número CCLI")).toHaveValue("22025");
  await expect(field(again, "Notas")).toHaveValue("Primera nota\nsegunda línea");
  await expect(lyricsBox(again)).toHaveValue("[Estrofa 1]\nuno\n\n[Coro]\ncoro");
  await expect(editor(again).getByRole("combobox", { name: "Tema" })).toHaveText(/Segundo tema/);
  await editor(again).getByRole("tab", { name: "Traducción" }).click();
  await expect(editor(again).getByRole("textbox", { name: "Traducción" })).toHaveValue("[Estrofa 1]\none\n\n[Coro]\nchorus");
  // Nothing changed: «Guardar» stays off and nothing reads as edited.
  await expect(saveButton(again)).toBeDisabled();
  await expect(editor(again).getByText("Editado")).toHaveCount(0);
});

test("leaving with changes asks: «Cancelar» keeps them, Escape asks too, «Descartar» drops them, «Guardar y salir» saves", async ({
  app,
}) => {
  await createSong(app, "Salir", "[Estrofa 1]\nuno");
  await openSaved(app, "Salir");
  await field(app, "Notas").fill("una nota");
  await expect(editor(app).getByText("Editado")).toBeVisible();

  await closeButton(app).click();
  await askDiscard(app).getByRole("button", { name: "Cancelar" }).click();
  await expect(askDiscard(app)).toHaveCount(0);
  await expect(field(app, "Notas")).toHaveValue("una nota");

  // Escape from inside the lyrics asks the same, and Escape on the question only closes the question.
  await lyricsBox(app).click();
  await app.control.keyboard.press("Escape");
  await expect(askDiscard(app)).toBeVisible();
  await app.control.keyboard.press("Escape");
  await expect(askDiscard(app)).toHaveCount(0);
  await expect(field(app, "Notas")).toHaveValue("una nota");

  await closeButton(app).click();
  await askDiscard(app).getByRole("button", { name: "Descartar cambios" }).click();
  await expect(app.control.getByRole("dialog")).toHaveCount(0);
  await openSaved(app, "Salir");
  await expect(field(app, "Notas")).toHaveValue("");

  await field(app, "Notas").fill("guardada al salir");
  await closeButton(app).click();
  await askDiscard(app).getByRole("button", { name: "Guardar y salir" }).click();
  await expect(app.control.getByRole("dialog")).toHaveCount(0);
  await openSaved(app, "Salir");
  await expect(field(app, "Notas")).toHaveValue("guardada al salir");

  // A change that cannot be saved (no title) offers no «Guardar y salir».
  await field(app, "Título").fill("");
  await closeButton(app).click();
  await expect(askDiscard(app)).toBeVisible();
  await expect(askDiscard(app).getByRole("button", { name: "Guardar y salir" })).toHaveCount(0);
});

test("quitting the app with a song typed but not saved asks first, and «Cancelar» keeps the typing", async ({ app }) => {
  await openNew(app);
  await field(app, "Título").fill("Veinte minutos de tipeo");
  await lyricsBox(app).fill("[Estrofa 1]\nuna letra larga que nadie guardó");
  await expect(editor(app).getByText("Editado")).toBeVisible();
  // ⌘Q, through `before-quit` and the close guard.
  await app.quit("cancel");
  await expect(field(app, "Título")).toHaveValue("Veinte minutos de tipeo");
});

test("«Descartar» in the bar puts back what was saved; ⌘S and Enter in the title save", async ({ app }) => {
  await createSong(app, "Atajos", "[Estrofa 1]\nuno");
  await openSaved(app, "Atajos");
  await field(app, "Autores").fill("Alguien");
  await lyricsBox(app).fill("[Estrofa 1]\notra cosa");
  await editor(app).getByRole("button", { name: "Descartar", exact: true }).click();
  await expect(field(app, "Autores")).toHaveValue("");
  await expect(lyricsBox(app)).toHaveValue("[Estrofa 1]\nuno");
  await expect(saveButton(app)).toBeDisabled();

  await lyricsBox(app).fill("[Estrofa 1]\nuno con ⌘S");
  await app.control.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
  await expect(toast(app, "Se guardó «Atajos»").first()).toBeVisible();
  await expect(saveButton(app)).toBeDisabled();

  await field(app, "Título").fill("Atajos con Enter");
  await field(app, "Título").press("Enter");
  await expect(toast(app, "Se guardó «Atajos con Enter»").first()).toBeVisible();
  await close(app);
  await expect(songRows(app).filter({ hasText: "Atajos con Enter" })).toHaveCount(1);
});

test("two saves in a row both stick", async ({ app }) => {
  await createSong(app, "Dos veces", "[Estrofa 1]\nuno");
  await openSaved(app, "Dos veces");
  await lyricsBox(app).fill("[Estrofa 1]\nuno\n\n[Coro]\nprimer guardado");
  await save(app, "Dos veces");
  await lyricsBox(app).fill(`${await lyricsBox(app).inputValue()}\n\n[Puente]\nsegundo guardado`);
  await field(app, "Notas").fill("nota del segundo");
  await save(app, "Dos veces");
  await close(app);
  await openSaved(app, "Dos veces");
  await expect(lyricsBox(app)).toHaveValue(/primer guardado[\s\S]*\[Puente\]\nsegundo guardado/);
  await expect(field(app, "Notas")).toHaveValue("nota del segundo");
});

test("«Duplicar» with unsaved changes asks first, and the copy is the saved song; two songs may share a title", async ({ app }) => {
  await createSong(app, "Original", "[Estrofa 1]\nguardado");
  await openSaved(app, "Original");
  await lyricsBox(app).fill("[Estrofa 1]\nsin guardar");
  await editor(app).getByRole("button", { name: "Más acciones" }).click();
  await app.control.getByRole("menuitem", { name: "Duplicar" }).click();
  await askDiscard(app).getByRole("button", { name: "Descartar cambios" }).click();
  await expect(field(app, "Título")).toHaveValue("Original (copia)");
  await expect(lyricsBox(app)).toHaveValue("[Estrofa 1]\nguardado");

  // A title is not a key: the copy renamed to the original's is a second «Original».
  await field(app, "Título").fill("Original");
  await save(app, "Original");
  await close(app);
  await expect(songRows(app).filter({ hasText: "Original" })).toHaveCount(2);
  await expect(songRows(app).filter({ hasText: "(copia)" })).toHaveCount(0);
});

test("a very long line and a long title are saved whole, and the editor never scrolls sideways", async ({ app }) => {
  const long = Array.from({ length: 40 }, (_, i) => `palabra${i}`).join(" ");
  const title = `Título largo ${"x".repeat(180)}`.slice(0, 200);
  await createSong(app, title, `[Estrofa 1]\n${long}`);
  await openSaved(app, title);
  await expect(lyricsBox(app)).toHaveValue(`[Estrofa 1]\n${long}`);
  expect(await app.control.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});

test("in the «Traducción» tab, a click on a slide shows that slide in the inspector", async ({ app }) => {
  await openNew(app);
  await field(app, "Título").fill("Traducir");
  // Typed: the caret ends on the last slide.
  await lyricsBox(app).click();
  await app.control.keyboard.type("[Estrofa 1]\nuno\n\n[Estrofa 2]\ndos\n\n[Coro]\ncoro");
  await expect(editor(app).getByText("3/3 · Coro")).toBeVisible();
  await editor(app).getByRole("tab", { name: "Traducción" }).click();
  await editor(app).getByRole("navigation").getByRole("button", { name: "1 Estrofa 1" }).click();
  await expect(editor(app).getByText("1/3 · Estrofa 1")).toBeVisible();
});

test("«Escribir encabezados» keeps the order the lyrics had — written with headers, or pasted without", async ({ app }) => {
  // Rewriting the text «as the app understood it» must not change what is projected.
  for (const lyrics of ["[Estrofa 1]\nuno\n\n[Coro]\nel coro\n\n[Estrofa 2]\ndos\n\n[Coro]", "primera\n\nvuelve\n\nsegunda\n\nvuelve"]) {
    await openNew(app);
    await field(app, "Título").fill("Coro repetido");
    await lyricsBox(app).fill(lyrics);
    await expect(chips(app)).toHaveText(["E1", "C", "E2", "C"]);
    await expect(editorSlides(app)).toHaveCount(4);
    await editor(app).getByRole("button", { name: "Escribir encabezados" }).click();
    await expect(chips(app)).toHaveText(["E1", "C", "E2", "C"]);
    await expect(editorSlides(app)).toHaveCount(4);
    await closeButton(app).click();
    await askDiscard(app).getByRole("button", { name: "Descartar cambios" }).click();
    await expect(app.control.getByRole("dialog")).toHaveCount(0);
  }
});

test("the order's hint says what is projected: a saved song still follows its lyrics, and an empty order is the song as written", async ({
  app,
}) => {
  await openNew(app);
  await field(app, "Título").fill("Sigue la letra");
  await lyricsBox(app).fill("[Estrofa 1]\nuno\n\n[Coro]\nel coro\n\n[Estrofa 2]\ndos\n\n[Coro]");
  const follows = editor(app).getByText("El orden sigue a la letra.", { exact: false });
  await expect(follows).toBeVisible();
  await save(app, "Sigue la letra");
  // The operator never touched the order: saved, it is still the lyrics'…
  await expect(follows).toBeVisible();
  // …so a verse added at the end is sung, as it would have been before saving.
  await lyricsBox(app).fill(`${await lyricsBox(app).inputValue()}\n\n[Estrofa 3]\ntres`);
  await expect(chips(app).last()).toHaveText("E3");
  await expect(notProjected(app)).toHaveCount(0);

  // Every chip taken away: an empty order is «as written», and both sections still go up.
  await lyricsBox(app).fill("[Estrofa 1]\nuno\n\n[Coro]\ncoro");
  await expect(chips(app)).toHaveText(["E1", "C"]);
  await chips(app).nth(1).getByRole("button", { name: "Quitar Coro del orden" }).click();
  await chips(app).nth(0).getByRole("button", { name: "Quitar Estrofa 1 del orden" }).click();
  await expect(chips(app)).toHaveCount(0);
  await expect(editorSlides(app)).toHaveCount(2);
  await expect(notProjected(app)).toHaveCount(0);
});

test("the order: «+» sings a section once more, «Seguir la letra» goes back, and typed as text it reads any language", async ({
  app,
}) => {
  await createSong(app, "Orden escrito", "[Estrofa 1]\nuno\n\n[Coro]\ncoro\n\n[Puente]\npuente");
  await openSaved(app, "Orden escrito");
  await editor(app).getByRole("button", { name: "Agregar una sección" }).click();
  await app.control.getByRole("menuitem", { name: "C · Coro" }).click();
  await expect(chips(app)).toHaveText(["E1", "C", "P", "C"]);
  await expect(editor(app).getByText("Orden propio", { exact: false })).toBeVisible();
  await expect(editorSlides(app)).toHaveCount(4);
  await editor(app).getByRole("button", { name: "Más opciones del orden" }).click();
  await app.control.getByRole("menuitem", { name: "Seguir la letra" }).click();
  await expect(chips(app)).toHaveText(["E1", "C", "P"]);

  await editor(app).getByRole("button", { name: "Más opciones del orden" }).click();
  await app.control.getByRole("menuitem", { name: "Escribir como texto" }).click();
  const text = editor(app).getByRole("textbox", { name: "Orden como texto" });
  await text.fill("V1 Chorus estribillo P");
  await expect(chips(app)).toHaveText(["E1", "C", "C", "P"]);
  await text.fill("E1 C E5");
  await expect(editor(app).getByText("El orden nombra secciones que no existen (Estrofa 5)", { exact: false })).toBeVisible();
  await text.fill("E1 xyz C");
  await expect(editor(app).getByText("No se reconoce: xyz")).toBeVisible();
  // The last order that read stays meanwhile.
  await expect(chips(app)).toHaveText(["E1", "C", "E5"]);
  await text.fill("E1 C C");
  await save(app, "Orden escrito");
  await close(app);
  await songRows(app).filter({ hasText: "Orden escrito" }).click();
  const grid = app.previewColumn().getByRole("list", { name: "Diapositivas de «Orden escrito»" });
  await expect(grid.getByRole("listitem")).toHaveText([/Estrofa 1/, /Coro/, /Coro/]);
});

test("«Guardar» is off for a song main would refuse, and the editor says why — not that the title is missing", async ({ app }) => {
  await openNew(app);
  await field(app, "Título").fill("Demasiado");
  const missingTitle = editor(app).getByText("Una canción necesita un título y al menos una línea de letra.");
  const tooMuch = [
    // 201 lines with no blank line between them: one slide of 201 (owner, 2026-11-06: up to 200 are stored, drawn 4 by 4).
    `[Estrofa 1]\n${Array.from({ length: 201 }, (_, i) => `línea ${i + 1}`).join("\n")}`,
    // 61 sections.
    Array.from({ length: 61 }, (_, i) => `[Estrofa ${i + 1}]\nverso ${i + 1}`).join("\n\n"),
    // One line of 501 characters.
    `[Estrofa 1]\n${"a".repeat(501)}`,
  ];
  for (const lyrics of tooMuch) {
    await lyricsBox(app).fill(lyrics);
    await expect(saveButton(app)).toBeDisabled();
    await expect(missingTitle).toHaveCount(0);
  }
  // The real missing-title case does say so.
  await lyricsBox(app).fill("[Estrofa 1]\nuna");
  await field(app, "Título").fill("");
  await expect(missingTitle).toBeVisible();
});
