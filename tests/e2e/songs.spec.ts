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
    await expect(dialog(app)).toContainText("guardar también escribe ese archivo");
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
    await importSongs(app, path.join(profile, "v6.1", "Databases", "Data", "Songs.db"));
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

    // Dates with nothing live say so, ask nothing, and leave the dialog open to change them.
    await settings.getByRole("button", { name: "Exportar informe…" }).click();
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
