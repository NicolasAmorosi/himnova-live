import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { Locator, Page } from "@playwright/test";
import { parseLyrics, withTranslation } from "../../src/shared/song-text";
import { DEFAULT_SONG_THEME, type SongTheme } from "../../src/shared/types/song";
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
  if (order) {
    // The order as text lives in the order's «⋯» (2026-11-05).
    await dialog(app).getByRole("button", { name: "Más opciones del orden" }).click();
    await app.control.getByRole("menuitem", { name: "Escribir como texto" }).click();
    await dialog(app).getByRole("textbox", { name: "Orden como texto" }).fill(order);
  }
  await dialog(app).getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(toast(app, `Se guardó «${title}»`)).toBeVisible();
  await dialog(app).getByRole("button", { name: "Cerrar" }).first().click();
  await expect(app.control.getByRole("dialog")).toHaveCount(0);
}

test("a linked folder shows its song files, and editing one of them writes the file", async ({ app }) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "worship-e2e-songs-"));
  const file = path.join(folder, "roca.cho");
  fs.writeFileSync(file, "{title: Roca eterna}\n{start_of_verse}\nRoca de la eternidad\n{end_of_verse}\n");
  try {
    await createSong(app, "Cristo me ama", "[Estrofa 1]\nCristo me ama");
    await app.answerOpenDialog(folder);
    await tab(app).getByRole("button", { name: "Vincular carpeta" }).click();
    // Its songs only: the library's are in «Biblioteca».
    await expect(tab(app).getByRole("combobox", { name: "Origen" })).toHaveText(new RegExp(path.basename(folder)));
    await expect(songRows(app)).toHaveText([/Roca eterna/]);
    // A new song or an import goes to the library: not offered here.
    await expect(tab(app).getByRole("button", { name: "Nueva canción" })).toHaveCount(0);

    await songRows(app).first().click();
    await tab(app).getByRole("button", { name: "Editar canción" }).click();
    await expect(dialog(app)).toContainText(`guardar también escribe «${file}»`);
    await dialog(app).getByRole("textbox", { name: "Título" }).fill("Roca de los siglos");
    await dialog(app).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(toast(app, "Se guardó «Roca de los siglos»")).toBeVisible();
    await expect.poll(() => fs.readFileSync(file, "utf8")).toContain("Roca de los siglos");
    await dialog(app).getByRole("button", { name: "Cerrar" }).first().click();

    await tab(app).getByRole("button", { name: "Desvincular carpeta" }).click();
    await dialog(app).getByRole("button", { name: "Desvincular carpeta" }).click();
    await expect(songRows(app)).toHaveText([/Cristo me ama/]);
    expect(fs.existsSync(file)).toBe(true);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("a song imported from a file is saved into that file, and ✕ deletes it but never the file (owner, 2026-11-05)", async ({
  app,
}) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "worship-e2e-tied-"));
  const file = path.join(folder, "5.xml");
  // Like the HASD hymnal's: Windows-1252, declared in the XML.
  const xml = `<?xml version='1.0' encoding='windows-1252'?>
<song xmlns="http://openlyrics.info/namespace/2009/song" version="0.8">
  <properties><titles><title>5 - Jubilosos Te Adoramos</title></titles></properties>
  <lyrics><verse name="v1"><lines>Jubilosos Te adoramos<br/>Deus da glória, Deus do amor</lines></verse></lyrics>
</song>`;
  fs.writeFileSync(file, Buffer.from(xml, "latin1"));
  try {
    await app.openResources("Canciones");
    await app.answerOpenDialog(file);
    await tab(app).getByRole("button", { name: "Importar", exact: true }).click();
    await expect(toast(app, "Se importó 1 canción · 0 repetidas · 0 sin letra")).toBeVisible();
    await songRows(app).filter({ hasText: "Jubilosos" }).click();
    await tab(app).getByRole("button", { name: "Editar canción" }).click();
    await expect(dialog(app)).toContainText(`guardar también escribe «${file}»`);
    await dialog(app).getByRole("textbox", { name: "Título" }).fill("5 - Jubilosos (editado)");
    await dialog(app).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(toast(app, "Se guardó «5 - Jubilosos (editado)»")).toBeVisible();
    // Written back in the encoding it was read in (owner, 2026-11-06): still Windows-1252.
    await expect.poll(() => fs.readFileSync(file, "latin1")).toContain("5 - Jubilosos (editado)");
    expect(fs.readFileSync(file, "latin1")).toContain("Deus da glória");
    expect(fs.readFileSync(file, "latin1")).toContain("encoding='windows-1252'");
    await dialog(app).getByRole("button", { name: "Cerrar" }).first().click();

    await tab(app).getByRole("button", { name: "Eliminar canción" }).click();
    await expect(dialog(app)).toContainText("Su archivo queda en el disco");
    await dialog(app).getByRole("button", { name: "Eliminar", exact: true }).click();
    await expect(songRows(app)).toHaveCount(0);
    expect(fs.existsSync(file)).toBe(true);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("an order chip dragged past the middle of the next one lands after it (owner, 2026-11-05)", async ({ app }) => {
  await createSong(app, "Tres estrofas", "[Estrofa 1]\nUno\n\n[Estrofa 2]\nDos\n\n[Estrofa 3]\nTres", "E1 E2 E3");
  await songRows(app).first().click();
  await tab(app).getByRole("button", { name: "Editar canción" }).click();
  const chips = dialog(app).getByRole("list", { name: "Orden de la canción" }).getByRole("listitem").filter({ hasText: /E\d/ });
  const box = (await chips.nth(1).boundingBox())!;
  await chips.nth(0).dragTo(chips.nth(1), { targetPosition: { x: box.width - 6, y: box.height / 2 } });
  await expect(chips).toHaveText([/E2/, /E1/, /E3/]);
});

test("a button's tooltip goes when it is pressed and stays away while the pointer rests on it (owner, 2026-11-05)", async ({ app }) => {
  await app.openResources("Canciones");
  const button = tab(app).getByRole("button", { name: "Importar", exact: true });
  const bubble = app.control.getByRole("tooltip").filter({ hasText: "Importar canciones a la biblioteca" });
  await button.hover();
  await expect(bubble).toBeVisible();
  await app.answerOpenDialog();
  await button.click();
  await app.control.waitForTimeout(300);
  await expect(bubble).toHaveCount(0);
});

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

test("one more step on a song's last slide takes it off to the logo", async ({ app }) => {
  await createSong(app, "Sublime gracia", GRACIA);
  await songRows(app).first().click();
  await app.goLive();
  const projector = await app.projector();
  await app.liveColumn().getByRole("listitem").nth(2).click();
  await expect(projector.getByText("Aleluya, aleluya")).toBeVisible();
  await expect(app.liveColumn().getByRole("button", { name: "Diapositiva siguiente" })).toBeEnabled();
  await app.control.keyboard.press("ArrowRight");
  await expect(projector.getByText("Aleluya, aleluya")).toHaveCount(0);
  await expect(app.liveColumn().getByText("Sublime gracia", { exact: true })).toHaveCount(0);
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
  await expect(toast(app, "Se guardó «Clásico»")).toBeVisible();
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

/** «Importar» in the Songs footer: one picker for every format (owner, 2026-11-05). */
async function importSongs(app: WorshipApp, ...files: string[]): Promise<void> {
  await app.answerOpenDialog(...files);
  await tab(app).getByRole("button", { name: "Importar", exact: true }).click();
}

test("EasyWorship's songs come in from its Songs.db, and a second import skips them", async ({ app }) => {
  const profile = easyWorshipProfile([
    { title: "Amazing Grace", author: "John Newton", lyrics: "Verse 1\nAmazing grace how sweet the sound\n\nChorus\nMy chains are gone\n\nVerse 2\nT'was grace\n\nChorus\nMy chains are gone" },
    { title: "Sin letra", author: "", lyrics: "" },
  ]);
  try {
    await app.openResources("Canciones");
    // Either of its two databases can be picked: the words are in SongWords.db, next to Songs.db.
    await importSongs(app, path.join(profile, "v6.1", "Databases", "Data", "SongWords.db"));
    await expect(toast(app, "Se importó 1 canción · 0 repetidas · 1 sin letra")).toBeVisible();
    await songRows(app).filter({ hasText: "Amazing Grace" }).click();
    const grid = app.previewColumn().getByRole("list", { name: "Diapositivas de «Amazing Grace»" });
    await expect(grid.getByRole("listitem")).toHaveText([/Estrofa 1/, /Coro/, /Estrofa 2/, /Coro/]);

    await importSongs(app, path.join(profile, "v6.1", "Databases", "Data", "Songs.db"));
    await expect(toast(app, "No se importó ninguna canción · 1 repetidas · 1 sin letra")).toBeVisible();
    await expect(songRows(app)).toHaveCount(1);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test("OpenLyrics files come in from «Importar», a second language as the translation", async ({ app }) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "worship-e2e-ol-"));
  const file = (name: string, title: string, verses: string) => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<song xmlns="http://openlyrics.info/namespace/2009/song" version="0.8">
  <properties><titles><title>${title}</title></titles><verseOrder>v1 c v2 c</verseOrder></properties>
  <lyrics>${verses}</lyrics>
</song>`;
    fs.writeFileSync(path.join(folder, name), xml);
    return path.join(folder, name);
  };
  const gracia = file(
    "gracia.xml",
    "Sublime gracia",
    `<verse name="v1" lang="es"><lines>Sublime gracia del Señor<br/>que a un infeliz salvó</lines></verse>
     <verse name="v1" lang="en"><lines>Amazing grace, how sweet the sound<br/>that saved a wretch like me</lines></verse>
     <verse name="c" lang="es"><lines>Aleluya</lines></verse>
     <verse name="v2" lang="es"><lines>Su gracia me enseñó a temer</lines></verse>`,
  );
  const amigo = file("amigo.xml", "Oh qué amigo", `<verse name="v1"><lines>Oh qué amigo nos es Cristo</lines></verse>`);
  try {
    await app.openResources("Canciones");
    await importSongs(app, gracia, amigo);
    await expect(toast(app, "Se importaron 2 canciones · 0 repetidas · 0 sin letra")).toBeVisible();
    await expect(songRows(app)).toHaveCount(2);
    await songRows(app).filter({ hasText: "Sublime gracia" }).click();
    const grid = app.previewColumn().getByRole("list", { name: "Diapositivas de «Sublime gracia»" });
    await expect(grid.getByRole("listitem")).toHaveText([/Estrofa 1/, /Coro/, /Estrofa 2/, /Coro/]);
    await app.goLive();
    const projector = await app.projector();
    await expect(projector.getByText("Sublime gracia del Señor")).toBeVisible();
    await expect(projector.locator("[data-song-translation]").last()).toContainText("Amazing grace, how sweet the sound");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("SongSelect and ChordPro files come in from «Importar», labels into sections and chords out", async ({ app }) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "worship-e2e-txt-"));
  const songSelect = path.join(folder, "gracia.txt");
  fs.writeFileSync(
    songSelect,
    "Sublime gracia\r\n\r\n\r\nVerse 1\r\nSublime gracia del Señor\r\n\r\n\r\nChorus\r\nAleluya\r\n\r\nJohn Newton\r\nCCLI Song #22025\r\n© Public Domain\r\nFor use solely with the SongSelect® Terms of Use. All rights reserved. www.ccli.com\r\nCCLI License #11111\r\n",
  );
  const chordPro = path.join(folder, "amigo.cho");
  fs.writeFileSync(chordPro, "{title: Oh qué amigo}\n{c: Verse 1}\n[F]Oh qué amigo [Bb]nos es Cristo\n\n{soc}\n[C]Él llevó\n{eoc}\n");
  try {
    await app.openResources("Canciones");
    await importSongs(app, songSelect);
    await expect(toast(app, "Se importó 1 canción · 0 repetidas · 0 sin letra")).toBeVisible();
    await importSongs(app, chordPro);
    await expect(songRows(app)).toHaveCount(2);
    await songRows(app).filter({ hasText: "Oh qué amigo" }).click();
    const grid = app.previewColumn().getByRole("list", { name: "Diapositivas de «Oh qué amigo»" });
    await expect(grid.getByRole("listitem")).toHaveText([/^Oh qué amigo nos es Cristo.*Estrofa 1$/, /^Él llevó.*Coro$/]);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("a song that went live is in the CCLI report, once a day, saved as CSV from Ajustes ▸ Canciones", async ({ app }) => {
  await createSong(app, "Sublime gracia", GRACIA);
  await songRows(app).first().click();
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText("Sublime gracia del Señor")).toBeVisible();
  // Live again the same day: still one use.
  await app.control.getByRole("button", { name: "NEGRO", exact: true }).click();
  await app.control.getByRole("button", { name: "VIVO", exact: true }).click();
  await app.goLive();

  const file = path.join(os.tmpdir(), `worship-e2e-ccli-${Date.now()}.csv`);
  try {
    await app.control.getByRole("button", { name: "Configuración" }).click();
    const settings = app.control.getByRole("dialog", { name: "Configuración" });
    await settings.getByRole("tab", { name: "Canciones" }).click();
    // The dates live in a dialog of their own (owner, 2026-11-05), which closes once the file is written.
    await settings.getByRole("button", { name: "Exportar informe…" }).click();
    const report = app.control.getByRole("dialog", { name: "Exportar informe CCLI" });
    await app.answerSaveDialog(file);
    await report.getByRole("button", { name: "Exportar CSV" }).click();
    await expect(toast(app, "Se exportó el informe: 1 canción.")).toBeVisible();
    await expect(report).toHaveCount(0);
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(fs.readFileSync(file, "utf-8").split("\r\n")).toEqual([
      "\uFEFFTítulo;Autores;Número CCLI;Usos;Fechas",
      `Sublime gracia;;;1;${today}`,
      "",
    ]);

    // «Desde» after «Hasta» exports nothing; dates with nothing live say so, ask nothing, and leave
    // the dialog open to change them.
    await settings.getByRole("button", { name: "Exportar informe…" }).click();
    await report.getByRole("textbox", { name: "Desde" }).fill("2030-01-01");
    await expect(report.getByRole("button", { name: "Exportar CSV" })).toBeDisabled();
    await report.getByRole("textbox", { name: "Hasta" }).fill("2020-01-31");
    await report.getByRole("textbox", { name: "Desde" }).fill("2020-01-01");
    await report.getByRole("button", { name: "Exportar CSV" }).click();
    await expect(report.getByText("Ninguna canción salió en vivo entre esas fechas.")).toBeVisible();
    await expect(report).toBeVisible();
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("a translation written in its own tab goes live stacked, and the LIVE row switches the language", async ({ app }) => {
  await app.openResources("Canciones");
  await tab(app).getByRole("button", { name: "Nueva canción" }).first().click();
  await dialog(app).getByRole("textbox", { name: "Título" }).fill("Sublime gracia");
  await dialog(app).getByRole("textbox", { name: "Letra" }).fill(GRACIA);
  await dialog(app).getByRole("tab", { name: "Traducción" }).click();
  await dialog(app)
    .getByRole("textbox", { name: "Traducción" })
    .fill("[Estrofa 1]\nAmazing grace, how sweet the sound\nthat saved a wretch like me\n\nI once was lost\n\n[Coro]\nHallelujah");
  await dialog(app).getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(toast(app, "Se guardó «Sublime gracia»")).toBeVisible();
  await dialog(app).getByRole("button", { name: "Cerrar" }).first().click();

  await songRows(app).first().click();
  await app.goLive();
  const projector = await app.projector();
  const translation = projector.locator("[data-song-translation]").last();
  // «Both» first, stacked: the lyrics and, under them, the translation.
  await expect(projector.getByText("Sublime gracia del Señor")).toBeVisible();
  await expect(translation).toContainText("Amazing grace, how sweet the sound");

  const languages = app.liveColumn().getByRole("group", { name: "Idioma" });
  await expect(languages.getByRole("button", { name: "Ambos" })).toHaveAttribute("aria-pressed", "true");
  await languages.getByRole("button", { name: "Original" }).click();
  await expect(projector.locator("[data-song-translation]")).toHaveCount(0);
  await expect(projector.getByText("Sublime gracia del Señor")).toBeVisible();
  await languages.getByRole("button", { name: "Traducción" }).click();
  await expect(projector.getByText("Amazing grace, how sweet the sound")).toBeVisible();
  await expect(projector.getByText("Sublime gracia del Señor")).toHaveCount(0);
  // The same slide all along: → goes on to the next one, in that language.
  await app.control.keyboard.press("ArrowRight");
  await expect(projector.getByText("I once was lost")).toBeVisible();
});

test("a search open in the Songs tab shows a song as soon as it is written or edited to match, and drops one that stops", async ({
  app,
}) => {
  await createSong(app, "Alfa", "[Estrofa 1]\nuno solo");
  const search = tab(app).getByRole("textbox", { name: "Buscar por título, número, autor o letra" });
  await search.fill("zafiro");
  await expect(tab(app).getByText("Ninguna canción coincide")).toBeVisible();

  // Written with the search still open.
  await tab(app).getByRole("button", { name: "Nueva canción" }).first().click();
  await dialog(app).getByRole("textbox", { name: "Título" }).fill("Piedra");
  await dialog(app).getByRole("textbox", { name: "Letra" }).fill("[Estrofa 1]\nun zafiro brilla");
  await dialog(app).getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(toast(app, "Se guardó «Piedra»")).toBeVisible();
  await dialog(app).getByRole("button", { name: "Cerrar" }).first().click();
  await expect(songRows(app)).toHaveText([/Piedra/]);

  // Edited so it no longer matches.
  await search.fill("uno");
  await expect(songRows(app)).toHaveText([/Alfa/]);
  await songRows(app).first().click();
  await tab(app).getByRole("button", { name: "Editar canción" }).click();
  await dialog(app).getByRole("textbox", { name: "Letra" }).fill("[Estrofa 1]\nya no coincide");
  await dialog(app).getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(toast(app, "Se guardó «Alfa»").last()).toBeVisible();
  await dialog(app).getByRole("button", { name: "Cerrar" }).first().click();
  await expect(songRows(app)).toHaveCount(0);
});

test("Hebrew, Arabic, CJK and emoji are saved, found, reopened after a restart and projected as typed", async ({ app }) => {
  const title = "שיר הלל 🎵 讚美";
  const lyrics = "[Estrofa 1]\nהללויה לאל\n\n[Coro]\nالمجد لله في الأعالي\n\n[Puente]\n主啊我讚美你 🙏\n\n[Final]\nハレルヤ 🎶";
  await createSong(app, title, lyrics);
  await app.quit("close");
  const again = await relaunch(app);
  await again.openResources("Canciones");
  await songRows(again).first().click();
  await tab(again).getByRole("button", { name: "Editar canción" }).click();
  await expect(dialog(again).getByRole("textbox", { name: "Letra" })).toHaveValue(lyrics);
  await dialog(again).getByRole("button", { name: "Cerrar" }).first().click();

  // Scripts without spaces between words too: Chinese inside a line and inside the title, Japanese.
  const search = tab(again).getByRole("textbox", { name: "Buscar por título, número, autor o letra" });
  for (const query of ["הללויה", "المجد", "主啊", "讚美", "ハレルヤ"]) {
    await search.fill(query);
    await expect(songRows(again).filter({ hasText: "שיר הלל" }), query).toHaveCount(1);
  }
  await search.fill("");
  await songRows(again).first().click();
  await again.goLive();
  const projector = await again.projector();
  await expect(projector.getByText("הללויה לאל")).toBeVisible();
  await again.control.keyboard.press("ArrowRight");
  await expect(projector.getByText("المجد لله في الأعالي")).toBeVisible();
});

test("saving a song that is in PREVIEW and in the order of service updates both", async ({ app }) => {
  await createSong(app, "En preview", "[Estrofa 1]\nuno");
  await songRows(app).first().click();
  await tab(app).getByRole("button", { name: "Agregar al programa" }).click();
  await expect(scheduleRows(app)).toHaveText([/En preview/]);
  const grid = (title: string) => app.previewColumn().getByRole("list", { name: `Diapositivas de «${title}»` });
  await expect(grid("En preview").getByRole("listitem")).toHaveCount(1);

  await tab(app).getByRole("button", { name: "Editar canción" }).click();
  await dialog(app).getByRole("textbox", { name: "Título" }).fill("Renombrada");
  await dialog(app).getByRole("textbox", { name: "Letra" }).fill("[Estrofa 1]\nuno\n\n[Coro]\ncoro nuevo");
  await dialog(app).getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(toast(app, "Se guardó «Renombrada»")).toBeVisible();
  await dialog(app).getByRole("button", { name: "Cerrar" }).first().click();
  await expect(grid("Renombrada").getByRole("listitem")).toHaveText([/Estrofa 1/, /Coro/]);
  await expect(app.previewColumn().getByText("coro nuevo").first()).toBeVisible();
  await expect(scheduleRows(app)).toHaveText([/Renombrada/]);
});

test("the live song edited so the section on air is gone: the projector moves to the slide that took its place", async ({ app }) => {
  await createSong(app, "Vivo", "[Estrofa 1]\nuno a\n\nuno b\n\n[Coro]\nel coro");
  await songRows(app).first().click();
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText("uno a")).toBeVisible();
  await app.control.keyboard.press("ArrowRight");
  await expect(projector.getByText("uno b")).toBeVisible();
  await app.control.keyboard.press("ArrowRight");
  await expect(projector.getByText("el coro")).toBeVisible();
  await expect(app.liveColumn().getByText("3/3")).toBeVisible();

  await tab(app).getByRole("button", { name: "Editar canción" }).click();
  await dialog(app).getByRole("textbox", { name: "Letra" }).fill("[Estrofa 1]\nuno a\n\nuno b");
  await dialog(app).getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(toast(app, "Se guardó «Vivo»").last()).toBeVisible();
  await dialog(app).getByRole("button", { name: "Cerrar" }).first().click();
  await expect(projector.getByText("el coro")).toHaveCount(0);
  await expect(app.liveColumn().getByText("2/2")).toBeVisible();
  await expect(projector.getByText("uno b")).toBeVisible();
});

test("the live song edited so the slide on air is gone and its section leaves the order: the projector stays on a real slide", async ({
  app,
}) => {
  await createSong(app, "Editable", "[Estrofa 1]\nuno\n\n[Coro]\ncoro\n\n[Estrofa 2]\ndos\n\notra de dos", "E1 C E2 C");
  await songRows(app).first().click();
  await app.goLive();
  const projector = await app.projector();
  const live = app.liveColumn();
  await expect(projector.getByText("uno", { exact: true })).toBeVisible();
  await app.control.keyboard.press("2");
  await app.control.keyboard.press("ArrowRight");
  await expect(projector.getByText("otra de dos")).toBeVisible();
  await expect(live.getByText("4/5")).toBeVisible();

  await tab(app).getByRole("button", { name: "Editar canción" }).click();
  await dialog(app).getByRole("textbox", { name: "Letra" }).fill("[Estrofa 1]\nuno\n\n[Coro]\ncoro\n\n[Estrofa 2]\ndos");
  await dialog(app).getByRole("button", { name: "Más opciones del orden" }).click();
  await app.control.getByRole("menuitem", { name: "Escribir como texto" }).click();
  await dialog(app).getByRole("textbox", { name: "Orden como texto" }).fill("E1 C");
  await dialog(app).getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(toast(app, "Se guardó «Editable»").last()).toBeVisible();
  await dialog(app).getByRole("button", { name: "Cerrar" }).first().click();
  await expect(live.getByText(/^[12]\/2$/)).toBeVisible();
  await expect(projector.locator("[data-song-block]").last()).not.toBeEmpty();
});

test("the live song deleted from the library stays up and the keys still walk it; its schedule row goes", async ({ app }) => {
  await createSong(app, "Borrar en vivo", "[Estrofa 1]\nuno\n\n[Coro]\ncoro");
  await songRows(app).first().click();
  await tab(app).getByRole("button", { name: "Agregar al programa" }).click();
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText("uno", { exact: true })).toBeVisible();

  // The Songs footer's ✕.
  await tab(app).getByRole("button", { name: "Eliminar canción" }).click();
  const confirm = app.control.getByRole("dialog", { name: "¿Eliminar esta canción?" });
  await expect(confirm).toContainText("La canción está en vivo");
  await confirm.getByRole("button", { name: "Eliminar", exact: true }).click();
  await expect(songRows(app)).toHaveCount(0);
  await expect(scheduleRows(app)).toHaveCount(0);
  await expect(tab(app).getByRole("button", { name: "Editar canción" })).toBeDisabled();
  // What is projected stays until something else goes live.
  await expect(projector.getByText("uno", { exact: true })).toBeVisible();
  await app.control.keyboard.press("ArrowRight");
  await expect(projector.getByText("coro", { exact: true })).toBeVisible();
  await app.control.keyboard.press("1");
  await expect(projector.getByText("uno", { exact: true })).toBeVisible();
});

test("a song whose order names only sections that do not exist is projected as written, and the editor says so", async ({ app }) => {
  await app.openResources("Canciones");
  await tab(app).getByRole("button", { name: "Nueva canción" }).first().click();
  await dialog(app).getByRole("textbox", { name: "Título" }).fill("Sin orden");
  await dialog(app).getByRole("textbox", { name: "Letra" }).fill("[Estrofa 1]\nprimera línea");
  await dialog(app).getByRole("button", { name: "Más opciones del orden" }).click();
  await app.control.getByRole("menuitem", { name: "Escribir como texto" }).click();
  await dialog(app).getByRole("textbox", { name: "Orden como texto" }).fill("E5");
  await expect(dialog(app).getByText("El orden solo nombra secciones que no existen (Estrofa 5)", { exact: false })).toBeVisible();
  await dialog(app).getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(toast(app, "Se guardó «Sin orden»")).toBeVisible();
  await dialog(app).getByRole("button", { name: "Cerrar" }).first().click();

  await songRows(app).first().click();
  await app.goLive();
  await expect((await app.projector()).getByText("primera línea")).toBeVisible();
});

test("a section sung off the order fits the projector like every other slide", async ({ app }) => {
  const bridge = Array.from({ length: 12 }, (_, i) => `una línea bastante larga del puente, la número ${i + 1}`);
  await createSong(app, "Puente largo", ["[Estrofa 1]", "corta", "", "[Coro]", "coro corto", "", "[Puente]", ...bridge].join("\n"), "E1 C");
  await songRows(app).first().click();
  await app.goLive();
  const projector = await app.projector();
  const clipped = () => projector.locator("[data-song-block]").last().evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  await expect(projector.getByText("corta", { exact: true })).toBeVisible();
  expect(await clipped()).toBe(false);

  // P: the bridge, as a detour. Its twelve lines were never measured with the song's own slides.
  await app.control.keyboard.press("p");
  await expect(projector.getByText(bridge[0]!, { exact: true })).toBeVisible();
  await expect(app.liveColumn().getByText("fuera del orden · 1/1")).toBeVisible();
  await expect.poll(clipped).toBe(false);
});

test("a live song under NEGRO and LOGO: the keys still move it, and it comes back on the right slide", async ({ app }) => {
  await createSong(app, "Tres", "[Estrofa 1]\nuno\n\n[Estrofa 2]\ndos\n\n[Coro]\ncoro");
  await songRows(app).first().click();
  await app.goLive();
  const projector = await app.projector();
  const shown = (text: string) => projector.getByText(text, { exact: true });
  await expect(shown("uno")).toBeVisible();

  await app.control.keyboard.press("b");
  await expect(shown("uno")).toBeHidden();
  // → under NEGRO moves the song, and NEGRO stays.
  await app.control.keyboard.press("ArrowRight");
  await app.control.waitForTimeout(400);
  await expect(shown("dos")).toBeHidden();
  await app.control.keyboard.press("b");
  await expect(shown("dos")).toBeVisible();

  await app.control.keyboard.press("l");
  await expect(shown("dos")).toBeHidden();
  await app.control.keyboard.press("c");
  await app.control.keyboard.press("l");
  await expect(shown("coro")).toBeVisible();
  // T, then NEGRO on and off: the words stay hidden — only T brings them back.
  await app.control.keyboard.press("t");
  await expect(shown("coro")).toBeHidden();
  await app.control.keyboard.press("b");
  await app.control.keyboard.press("b");
  await app.control.waitForTimeout(400);
  await expect(shown("coro")).toBeHidden();
  await app.control.keyboard.press("t");
  await expect(shown("coro")).toBeVisible();
});

test("a song dragged onto the schedule goes live from its row, again after a video went live in between", async ({ app }) => {
  await app.addMedia("video", "clip.mp4");
  await createSong(app, "Arrastrada", "[Estrofa 1]\nuno\n\n[Coro]\ncoro");
  await songRows(app).first().dragTo(app.control.getByText("Programa vacío"));
  await expect(scheduleRows(app)).toHaveCount(1);
  await scheduleRows(app).first().click();
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText("uno", { exact: true })).toBeVisible();
  await app.control.keyboard.press("ArrowRight");
  await expect(projector.getByText("coro", { exact: true })).toBeVisible();

  await app.previewFile("Videos", "clip");
  await app.goLive();
  await expect(projector.locator("[data-song-block]")).toHaveCount(0);

  await scheduleRows(app).first().click();
  await app.goLive();
  await expect(projector.getByText("uno", { exact: true })).toBeVisible();
  await expect(scheduleRows(app).first().locator(".bg-on-air")).toHaveCount(1);
});

/** A song on a theme of its own, written through IPC, then a restart: the
 *  window loads songs and themes when it starts. */
async function songOnTheme(first: WorshipApp, title: string, lyrics: string, style: Partial<SongTheme>, translation?: string) {
  const theme = await first.invoke<{ id: number }>("songTheme:create", { name: "Propio", style: { ...DEFAULT_SONG_THEME, ...style } });
  const sections = parseLyrics(lyrics, "es").sections;
  await first.invoke("song:create", {
    title,
    number: null,
    authors: null,
    copyright: null,
    ccliNumber: null,
    notes: null,
    sections: translation ? withTranslation(sections, parseLyrics(translation, "es").sections) : sections,
    order: [],
    themeId: theme.id,
  });
  await first.quit();
  return relaunch(first);
}

test("switching the language of a song cut into slides by its theme keeps the projector on a slide of its own", async ({
  app: first,
}) => {
  // Two lines a slide: the translation of verse 1 is two slides where the original is one.
  const app = await songOnTheme(
    first,
    "Dos idiomas",
    "[Estrofa 1]\nuno a\nuno b\n\n[Coro]\ncoro a\ncoro b",
    { maxLines: 2 },
    "[Estrofa 1]\none a\none b\none c\none d",
  );
  await app.openResources("Canciones");
  await songRows(app).first().click();
  await app.goLive();
  const projector = await app.projector();
  const live = app.liveColumn();
  const languages = live.getByRole("group", { name: "Idioma" });
  await expect(projector.getByText("uno a")).toBeVisible();
  await app.control.keyboard.press("ArrowRight");
  await expect(projector.getByText("coro a")).toBeVisible();
  await expect(live.getByText("2/2")).toBeVisible();

  // On the chorus, which has no translation, «Traducción» leaves it as it is…
  await languages.getByRole("button", { name: "Traducción" }).click();
  await expect(projector.getByText("coro a")).toBeVisible();
  await expect(live.getByText("3/3")).toBeVisible();
  // …and back to «Original» from that last slide, which the original does not have, never leaves it without words.
  await languages.getByRole("button", { name: "Original" }).click();
  await expect(projector.getByText("coro a")).toBeVisible();
  await expect(live.getByText("2/2")).toBeVisible();
});

test("deleting the default theme while a song in it is live re-dresses the projector, and Settings follows", async ({ app }) => {
  const { control } = app;
  // A red theme, made the default.
  await app.openResources("Canciones");
  await tab(app).getByRole("button", { name: "Temas" }).click();
  const themes = control.getByRole("dialog", { name: "Temas" });
  const themeRows = themes.getByRole("list", { name: "Temas guardados" }).getByRole("listitem");
  await themes.getByRole("button", { name: "Nuevo tema" }).click();
  await themes.getByRole("textbox", { name: "Nombre", exact: true }).fill("Rojo");
  await themes.getByRole("button", { name: "Color", exact: true }).first().click();
  const colour = control.getByRole("dialog", { name: "Color", exact: true }).locator('input:not([type="color"])');
  await colour.fill("#dd1f1f");
  await colour.press("Enter");
  await control.keyboard.press("Escape");
  await themes.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(toast(app, "Se guardó «Rojo»")).toBeVisible();
  await themes.getByRole("button", { name: "Cerrar" }).first().click();

  const settings = control.getByRole("dialog", { name: "Configuración" });
  const openSongSettings = async (): Promise<Locator> => {
    await control.getByRole("button", { name: "Configuración" }).click();
    await settings.getByRole("tab", { name: "Canciones" }).click();
    return settings.getByRole("combobox", { name: "Tema por defecto", exact: true });
  };
  await (await openSongSettings()).click();
  await control.getByRole("option", { name: "Rojo", exact: true }).click();
  await settings.getByRole("button", { name: "Volver" }).click();

  await createSong(app, "Cristo me ama", "[Estrofa 1]\nCristo me ama");
  await songRows(app).first().click();
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText("Cristo me ama").first()).toBeVisible();
  const red = () =>
    projector.evaluate(() => [...document.querySelectorAll("*")].some((el) => getComputedStyle(el).backgroundColor === "rgb(221, 31, 31)"));
  await expect.poll(red).toBe(true);

  await tab(app).getByRole("button", { name: "Temas" }).click();
  await themeRows.filter({ hasText: "Rojo" }).click();
  await themes.getByRole("button", { name: "Más acciones" }).click();
  await control.getByRole("menuitem", { name: "Eliminar", exact: true }).click();
  await control.getByRole("dialog", { name: "¿Eliminar este tema?" }).getByRole("button", { name: "Eliminar", exact: true }).click();
  await expect(themeRows).toHaveCount(1);
  // The last theme cannot go: a song always has one to be drawn in.
  await themes.getByRole("button", { name: "Más acciones" }).click();
  await expect(control.getByRole("menuitem", { name: "Eliminar", exact: true })).toBeDisabled();
  await control.keyboard.press("Escape");
  await themes.getByRole("button", { name: "Cerrar" }).first().click();

  await expect.poll(red).toBe(false);
  await expect(projector.getByText("Cristo me ama").first()).toBeVisible();
  await expect(await openSongSettings()).toHaveText(/Clásico/);
  expect((await app.invoke<Record<string, unknown>>("settings:get"))["songs.defaultThemeId"]).toBeNull();
});
