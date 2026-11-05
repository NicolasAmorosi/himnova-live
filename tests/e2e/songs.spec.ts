import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { Page } from "@playwright/test";
import { expect, relaunch, test, type WorshipApp } from "./support/app";

/**
 * Songs, F1: written or pasted in the editor, searched without accents,
 * previewed and projected slide by slide at ONE size, edited while live, and
 * held by reference in the order of service.
 */

const tab = (app: WorshipApp) => app.control.getByRole("tabpanel", { name: "Canciones" });
const songRows = (app: WorshipApp) => tab(app).getByRole("list", { name: "Canciones" }).getByRole("listitem");
const dialog = (app: WorshipApp) => app.control.getByRole("dialog").first();
const toast = (app: WorshipApp, text: string) => app.control.getByRole("status").filter({ hasText: text });
const scheduleRows = (app: WorshipApp) =>
  app.control
    .locator("section")
    .filter({ has: app.control.getByRole("heading", { name: "Programa", exact: true }) })
    .getByRole("list")
    .first()
    .getByRole("listitem");

const GRACIA = [
  "[Estrofa 1]",
  "Sublime gracia del Señor",
  "que a un pecador salvó",
  "",
  "Fui ciego mas hoy veo yo",
  "",
  "[Coro]",
  "Aleluya, aleluya",
].join("\n");

async function createSong(app: WorshipApp, title: string, lyrics: string, order?: string): Promise<void> {
  await app.openResources("Canciones");
  await tab(app).getByRole("button", { name: "Nueva canción" }).first().click();
  await dialog(app).getByRole("textbox", { name: "Título" }).fill(title);
  await dialog(app).getByRole("textbox", { name: "Letra" }).fill(lyrics);
  if (order) await dialog(app).getByRole("textbox", { name: "Orden como texto" }).fill(order);
  await dialog(app).getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(toast(app, `Se guardó «${title}»`)).toBeVisible();
  await dialog(app).getByRole("button", { name: "Cerrar" }).first().click();
  await expect(app.control.getByRole("dialog")).toHaveCount(0);
}

/** The font size the projector draws the song's letters at, in px. */
function projectedSize(projector: Page): Promise<string> {
  return projector.locator("[data-song-block]").last().evaluate((el) => getComputedStyle(el).fontSize);
}

test("a song written in the editor is found by its lyrics without accents and goes live", async ({ app }) => {
  await createSong(app, "Sublime gracia", GRACIA);

  await tab(app).getByRole("textbox", { name: "Buscar por título, número, autor o letra" }).fill("senor");
  await expect(songRows(app)).toHaveCount(1);
  await expect(songRows(app).first()).toContainText("Señor");
  await songRows(app).first().click();

  // PREVIEW: the order expanded, each slide with its section.
  const grid = app.previewColumn().getByRole("list", { name: "Diapositivas de «Sublime gracia»" });
  await expect(grid.getByRole("listitem")).toHaveText([/Estrofa 1/, /Estrofa 1/, /Coro/]);

  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText("Sublime gracia del Señor")).toBeVisible();

  await app.control.keyboard.press("ArrowRight");
  await expect(projector.getByText("Fui ciego mas hoy veo yo")).toBeVisible();
  await app.control.keyboard.press("PageDown");
  await expect(projector.getByText("Aleluya, aleluya")).toBeVisible();
  await app.control.keyboard.press("ArrowLeft");
  await expect(projector.getByText("Fui ciego mas hoy veo yo")).toBeVisible();
  await expect(app.liveColumn().getByText("2/3")).toBeVisible();

  // A click on the LIVE grid moves the projector.
  await app.liveColumn().getByRole("listitem").nth(2).click();
  await expect(projector.getByText("Aleluya, aleluya")).toBeVisible();
});

test("every slide of a song is drawn at the same size", async ({ app }) => {
  const long = Array.from({ length: 6 }, (_, i) => `una línea bastante larga de la estrofa número ${i + 1}`);
  await createSong(app, "Tamaño único", ["[Estrofa 1]", "corta", "", ...long].join("\n"));
  await songRows(app).filter({ hasText: "Tamaño único" }).click();
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText("corta")).toBeVisible();
  const short = await projectedSize(projector);
  await app.control.keyboard.press("ArrowRight");
  await expect(projector.getByText(long[0]!)).toBeVisible();
  expect(await projectedSize(projector)).toBe(short);
});

test("pasted lyrics without headers: the block that comes back is the chorus, sung each time", async ({ app }) => {
  await createSong(app, "Pegada", ["Primera", "", "Vuelve", "", "Segunda", "", "Vuelve"].join("\n"));
  await songRows(app).filter({ hasText: "Pegada" }).click();
  const grid = app.previewColumn().getByRole("list", { name: "Diapositivas de «Pegada»" });
  await expect(grid.getByRole("listitem")).toHaveText([/Estrofa 1/, /Coro/, /Estrofa 2/, /Coro/]);
});

test("saving the song that is live changes the projector in place, on the same slide", async ({ app }) => {
  await createSong(app, "Sublime gracia", GRACIA);
  await songRows(app).first().click();
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText("Sublime gracia del Señor")).toBeVisible();
  await app.control.keyboard.press("ArrowRight");
  await app.control.keyboard.press("ArrowRight");
  await expect(projector.getByText("Aleluya, aleluya")).toBeVisible();

  await tab(app).getByRole("button", { name: "Editar canción" }).click();
  const lyrics = dialog(app).getByRole("textbox", { name: "Letra" });
  await lyrics.fill((await lyrics.inputValue()).replace("Aleluya, aleluya", "Gloria a Dios"));
  await dialog(app).getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(projector.getByText("Gloria a Dios")).toBeVisible();
  await expect(app.liveColumn().getByText("3/3")).toBeVisible();
});

test("in the editor the caret in the lyrics and the slides go together", async ({ app }) => {
  // E1 C E1 C: six slides, the verse's two and the chorus, twice.
  await createSong(app, "Sublime gracia", GRACIA, "E1 C E1 C");
  await songRows(app).first().click();
  await tab(app).getByRole("button", { name: "Editar canción" }).click();
  const editor = dialog(app);
  const lyrics = editor.getByRole("textbox", { name: "Letra" });
  const caretAt = async (needle: string) => {
    await lyrics.evaluate((el: HTMLTextAreaElement, text) => {
      el.focus();
      const at = el.value.indexOf(text) + 1;
      el.setSelectionRange(at, at);
    }, needle);
    // Moved with a real key, as the operator does: that is what reports the caret.
    await app.control.keyboard.press("ArrowLeft");
  };
  const caretLine = () => lyrics.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart).split("\n")[0]);

  await caretAt("Fui ciego");
  await expect(editor.getByText("2/6 · Estrofa 1")).toBeVisible();
  await caretAt("Aleluya");
  await expect(editor.getByText("3/6 · Coro")).toBeVisible();

  // A click on the chorus's second pass keeps that pass, and puts the caret on its words.
  await editor.getByRole("button", { name: "6 Coro" }).click();
  await expect(editor.getByText("6/6 · Coro")).toBeVisible();
  await expect.poll(caretLine).toBe("Aleluya, aleluya");
  await editor.getByRole("button", { name: "5 Estrofa 1" }).click();
  await expect.poll(caretLine).toBe("Fui ciego mas hoy veo yo");
  await expect(editor.getByText("5/6 · Estrofa 1")).toBeVisible();
});

test("a song in the order of service comes back after a restart, and deleting it asks", async ({ app }) => {
  await createSong(app, "Sublime gracia", GRACIA);
  await songRows(app).first().click();
  await tab(app).getByRole("button", { name: "Agregar al programa" }).click();
  await expect(scheduleRows(app)).toHaveText([/Sublime gracia/]);

  await app.quit("close");
  const again = await relaunch(app);
  await expect(scheduleRows(again)).toHaveText([/Sublime gracia/]);

  // A saved program sings it: deleting names the program first.
  const [song] = await again.invoke<{ id: number }[]>("song:list");
  await again.invoke("programs:save", { name: "Domingo", items: [{ kind: "song", songId: song!.id, title: null }] });
  await again.openResources("Canciones");
  await songRows(again).first().click();
  await tab(again).getByRole("button", { name: "Editar canción" }).click();
  await dialog(again).getByRole("button", { name: "Más acciones" }).click();
  await again.control.getByRole("menuitem", { name: "Eliminar", exact: true }).click();
  const confirm = again.control.getByRole("dialog", { name: "¿Eliminar esta canción?" });
  await expect(confirm.getByText("Domingo")).toBeVisible();
  await confirm.getByRole("button", { name: "Eliminar igualmente" }).click();
  await expect(tab(again).getByText("Todavía no hay canciones")).toBeVisible();
  await expect(scheduleRows(again)).toHaveCount(0);
});

test("keys jump to a section: its next time, Shift the previous, and one off the order comes back", async ({ app }) => {
  const lyrics = "[Estrofa 1]\nprimera\n\n[Estrofa 2]\nsegunda\n\n[Coro]\nel coro\n\n[Puente]\npuente uno\n\npuente dos";
  await createSong(app, "Con puente", lyrics, "E1 C E2 C");
  await songRows(app).filter({ hasText: "Con puente" }).click();
  await app.goLive();
  const projector = await app.projector();
  const live = app.liveColumn();
  await expect(projector.getByText("primera")).toBeVisible();

  await app.control.keyboard.press("c");
  await expect(projector.getByText("el coro")).toBeVisible();
  await expect(live.getByText("2/4")).toBeVisible();
  await app.control.keyboard.press("2");
  await expect(projector.getByText("segunda")).toBeVisible();
  await app.control.keyboard.press("c");
  await expect(live.getByText("4/4")).toBeVisible();
  await app.control.keyboard.press("Shift+C");
  await expect(live.getByText("2/4")).toBeVisible();

  // The bridge is not in the order: sung as a detour, then → carries on after.
  await app.control.keyboard.press("p");
  await expect(projector.getByText("puente uno")).toBeVisible();
  await expect(live.getByText("fuera del orden · 1/2")).toBeVisible();
  await app.control.keyboard.press("ArrowRight");
  await expect(projector.getByText("puente dos")).toBeVisible();
  await app.control.keyboard.press("ArrowRight");
  await expect(projector.getByText("segunda")).toBeVisible();
  await expect(live.getByText("3/4")).toBeVisible();

  // T: only the background, and T again brings the words back.
  await app.control.keyboard.press("t");
  await expect(projector.getByText("segunda")).toBeHidden();
  await expect(live.getByText("Letra oculta")).toBeVisible();
  await app.control.keyboard.press("t");
  await expect(projector.getByText("segunda")).toBeVisible();

  // The same jumps by click.
  await live.getByRole("group", { name: "Secciones de la canción" }).getByRole("button", { name: "Estrofa 1" }).click({
    modifiers: ["Shift"],
  });
  await expect(projector.getByText("primera")).toBeVisible();
  await live.getByRole("button", { name: "Ocultar la letra (T)" }).click();
  await expect(projector.getByText("primera")).toBeHidden();
});

test("a theme edited in «Temas» dresses the live song, and the footer carries the church's licence", async ({ app }) => {
  const { control } = app;
  // The church's licence, in Ajustes ▸ Canciones.
  await control.getByRole("button", { name: "Configuración" }).click();
  const settings = control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Canciones" }).click();
  await settings.getByRole("textbox", { name: "Licencia CCLI de la iglesia" }).fill("998877");
  await settings.getByRole("textbox", { name: "Licencia CCLI de la iglesia" }).press("Enter");
  await settings.getByRole("button", { name: "Volver" }).click();

  await createSong(app, "Sublime gracia", GRACIA);
  await songRows(app).first().click();
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText("Sublime gracia del Señor")).toBeVisible();
  // The footer is on the last slide only (the default theme's choice).
  await expect(projector.locator("[data-song-footer]")).toHaveCount(0);
  await app.control.keyboard.press("c");
  await expect(projector.locator("[data-song-footer]")).toContainText("998877");

  // Capitals, saved in the theme, reach the slide on the projector in place.
  await tab(app).getByRole("button", { name: "Temas" }).click();
  const themes = control.getByRole("dialog", { name: "Temas" });
  await themes.getByRole("group", { name: "Mayúsculas", exact: true }).getByRole("switch").click();
  await themes.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(toast(app, "Se guardó «Predeterminado»")).toBeVisible();
  await themes.getByRole("button", { name: "Cerrar" }).first().click();
  await expect
    .poll(() => projector.locator("[data-song-block]").last().evaluate((el) => getComputedStyle(el).textTransform))
    .toBe("uppercase");
  await expect(projector.getByText("Aleluya, aleluya")).toBeVisible();
});

/** An EasyWorship 6 song database, as EasyWorship writes it, in a profile's
 *  `v6.1/Databases/Data`. Returns the profile folder. */
function easyWorshipProfile(songs: { title: string; author: string; lyrics: string }[]): string {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "worship-e2e-ew-"));
  const data = path.join(profile, "v6.1", "Databases", "Data");
  fs.mkdirSync(data, { recursive: true });
  const db = new Database(path.join(data, "Songs.db"));
  db.exec("CREATE TABLE song (rowid integer PRIMARY KEY, title text NOT NULL, author text, copyright text, administrator text, reference_number text, vendor_id integer)");
  const words = new Database(path.join(data, "SongWords.db"));
  words.exec("CREATE TABLE word (rowid integer PRIMARY KEY, song_id integer, words text)");
  songs.forEach((song, i) => {
    db.prepare("INSERT INTO song (rowid, title, author) VALUES (?, ?, ?)").run(i + 1, song.title, song.author);
    const body = song.lyrics.split("\n").join("\\par\n\\plain ");
    words.prepare("INSERT INTO word (song_id, words) VALUES (?, ?)").run(i + 1, `{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}{\\plain ${body}}}`);
  });
  db.close();
  words.close();
  return profile;
}

test("EasyWorship's songs come in from its profile folder, and a second import skips them", async ({ app }) => {
  const profile = easyWorshipProfile([
    { title: "Amazing Grace", author: "John Newton", lyrics: "Verse 1\nAmazing grace how sweet the sound\n\nChorus\nMy chains are gone\n\nVerse 2\nT'was grace\n\nChorus\nMy chains are gone" },
    { title: "Sin letra", author: "", lyrics: "" },
  ]);
  try {
    await app.openResources("Canciones");
    await app.answerOpenDialog(profile);
    await tab(app).getByRole("button", { name: "Importar de EasyWorship" }).first().click();
    await expect(toast(app, "Se importó 1 canción · 0 repetidas · 1 sin letra")).toBeVisible();
    await songRows(app).filter({ hasText: "Amazing Grace" }).click();
    const grid = app.previewColumn().getByRole("list", { name: "Diapositivas de «Amazing Grace»" });
    await expect(grid.getByRole("listitem")).toHaveText([/Estrofa 1/, /Coro/, /Estrofa 2/, /Coro/]);

    await app.answerOpenDialog(profile);
    await tab(app).getByRole("button", { name: "Importar de EasyWorship" }).first().click();
    await expect(toast(app, "No se importó ninguna canción · 1 repetidas · 1 sin letra")).toBeVisible();
    await expect(songRows(app)).toHaveCount(1);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
