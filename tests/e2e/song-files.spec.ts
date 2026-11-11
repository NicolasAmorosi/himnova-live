import fs from "node:fs";
import path from "node:path";
import { expect, test, type WorshipApp } from "./support/app";

/**
 * Songs that live in a file: imported into the library and still tied to it
 * (`Song.file`), or read straight off a linked folder (`Song.sourceFolder`).
 * Saving one writes its file back in its own format — so what the file held
 * and the editor did not show must survive, and a file deleted or changed
 * behind the app's back must be said, never overwritten. Every file is
 * written by the test under its throwaway profile.
 */

const tab = (app: WorshipApp) => app.control.getByRole("tabpanel", { name: "Canciones" });
const songRows = (app: WorshipApp) => tab(app).getByRole("list", { name: "Canciones" }).getByRole("listitem");
const editor = (app: WorshipApp) => app.control.getByRole("dialog").first();
const toast = (app: WorshipApp, text: string | RegExp) => app.control.getByRole("status").filter({ hasText: text });
const lyricsBox = (app: WorshipApp) => editor(app).getByRole("textbox", { name: "Letra" });
const field = (app: WorshipApp, name: string) => editor(app).getByRole("textbox", { name, exact: true });
const previewGrid = (app: WorshipApp, title: string) =>
  app.previewColumn().getByRole("list", { name: `Diapositivas de «${title}»` }).getByRole("listitem");

/** A new folder under the profile, for this test's song files. */
const songFolder = (app: WorshipApp) => fs.mkdtempSync(path.join(app.profile, "songs-"));

async function save(app: WorshipApp, title: string): Promise<void> {
  await editor(app).getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(toast(app, `Se guardó «${title}»`).first()).toBeVisible();
}

async function close(app: WorshipApp): Promise<void> {
  await editor(app).getByRole("button", { name: "Cerrar" }).first().click();
  await expect(app.control.getByRole("dialog")).toHaveCount(0);
}

async function edit(app: WorshipApp, title: string | RegExp): Promise<void> {
  await songRows(app).filter({ hasText: title }).first().click();
  await tab(app).getByRole("button", { name: "Editar canción" }).click();
  await expect(editor(app)).toBeVisible();
}

async function importSongs(app: WorshipApp, ...files: string[]): Promise<void> {
  await app.openResources("Canciones");
  await app.answerOpenDialog(...files);
  await tab(app).getByRole("button", { name: "Importar", exact: true }).click();
}

async function linkFolder(app: WorshipApp, dir: string): Promise<void> {
  await app.openResources("Canciones");
  await app.answerOpenDialog(dir);
  await tab(app).getByRole("button", { name: "Vincular carpeta" }).click();
  await expect(tab(app).getByRole("combobox", { name: "Origen" })).toHaveText(new RegExp(path.basename(dir)));
}

/** The files changed outside the app (a sync, another program), and the folder
 *  opened again: its songs are read from disk once more. */
async function reread(app: WorshipApp, dir: string, ...files: string[]): Promise<void> {
  const later = new Date(Date.now() + 5_000);
  for (const file of files) fs.utimesSync(file, later, later);
  const origin = tab(app).getByRole("combobox", { name: "Origen" });
  await origin.click();
  await app.control.getByRole("option", { name: "Biblioteca" }).click();
  await origin.click();
  await app.control.getByRole("option", { name: path.basename(dir) }).click();
}

test("a linked ChordPro songbook: editing one song rewrites only that one — a song with no words yet and a commented-out one stay", async ({
  app,
}) => {
  const dir = songFolder(app);
  const file = path.join(dir, "cancionero.cho");
  fs.writeFileSync(
    file,
    [
      "{title: Primera}",
      "{start_of_verse}",
      "[C]Letra de la [G]primera",
      "{end_of_verse}",
      "",
      "{new_song}",
      "{title: Segunda (sin letra todavía)}",
      "{artist: Alguien}",
      "",
      "{new_song}",
      "{title: Tercera}",
      "[D]Hello, [G]World!",
      "",
      "# Not ready yet:",
      "# {new_song}",
      "# {title: Comentada}",
      "",
    ].join("\n"),
  );
  await linkFolder(app, dir);
  // A song with no words has nothing to project: not listed, but still the file's.
  await expect(songRows(app)).toHaveText([/Primera/, /Tercera/]);
  await edit(app, "Tercera");
  await field(app, "Título").fill("Tercera (corregida)");
  await save(app, "Tercera (corregida)");
  await close(app);

  await expect.poll(() => fs.readFileSync(file, "utf8")).toContain("{title: Tercera (corregida)}");
  const text = fs.readFileSync(file, "utf8");
  for (const kept of ["{title: Primera}", "[C]Letra de la [G]primera", "{title: Segunda (sin letra todavía)}", "{artist: Alguien}", "# {title: Comentada}"]) {
    expect(text).toContain(kept);
  }
  expect(text).toMatch(/^\[D\]Hello, \[G\]World!$/m);
  expect(text.match(/^\{title: /gm)).toHaveLength(3);

  await reread(app, dir, file);
  await expect(songRows(app)).toHaveText([/Primera/, /Tercera \(corregida\)/]);
});

test("a library song's file deleted is saved with a warning; one changed meanwhile is refused, then saved", async ({ app }) => {
  const dir = songFolder(app);
  const gone = path.join(dir, "se-va.cho");
  const changed = path.join(dir, "cambia.cho");
  fs.writeFileSync(gone, "{title: Se va}\n{start_of_verse}\nEsta se va\n{end_of_verse}\n");
  fs.writeFileSync(changed, "{title: Cambia}\n{start_of_verse}\nEsta cambia\n{end_of_verse}\n");
  await importSongs(app, gone, changed);
  await expect(toast(app, "Se importaron 2 canciones · 0 repetidas · 0 sin letra")).toBeVisible();

  // The library has the song: the file was only where it also went.
  fs.rmSync(gone);
  await edit(app, "Se va");
  await field(app, "Título").fill("Se fue");
  await editor(app).getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(toast(app, /No se encontró el archivo de esta canción/)).toBeVisible();
  await expect(toast(app, "Se guardó «Se fue»")).toBeVisible();
  await close(app);

  // Someone else's edit is never overwritten without asking: the first save refuses, the second writes.
  fs.writeFileSync(changed, "{title: Cambia}\n{start_of_verse}\nCambiada afuera\n{end_of_verse}\n");
  fs.utimesSync(changed, new Date(), new Date(Date.now() + 5000));
  await edit(app, "Cambia");
  await field(app, "Título").fill("Cambia (mía)");
  await editor(app).getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(toast(app, /cambió fuera de Himnova/)).toBeVisible();
  expect(fs.readFileSync(changed, "utf8")).toContain("Cambiada afuera");
  await editor(app).getByRole("button", { name: "Guardar", exact: true }).click();
  await expect.poll(() => fs.readFileSync(changed, "utf8")).toContain("Cambia (mía)");
});

test("a linked song's file deleted or changed outside while it is open: saving says so and keeps the edit", async ({ app }) => {
  const dir = songFolder(app);
  const gone = path.join(dir, "se-va.chordpro");
  const changed = path.join(dir, "cambia.chordpro");
  fs.writeFileSync(gone, "{title: Sublime gracia}\n\nVerse 1\n[G]Sublime gracia [C]del Se[G]ñor\n");
  fs.writeFileSync(changed, "{title: Oh qué amigo}\n\nVerse 1\n[F]Oh qué amigo [Bb]nos es Cristo\n");
  await linkFolder(app, dir);

  await edit(app, "Sublime gracia");
  fs.rmSync(gone);
  await field(app, "Título").fill("Sublime gracia editada");
  await editor(app).getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(toast(app, "No se encuentra el archivo de esta canción").first()).toBeVisible();
  await expect(field(app, "Título")).toHaveValue("Sublime gracia editada");
  // A folder's song is never deleted from the editor, even once its file is gone: the folder is the computer's.
  await editor(app).getByRole("button", { name: "Más acciones" }).click();
  await expect(app.control.getByRole("menuitem", { name: "Eliminar", exact: true })).toHaveCount(0);
  await app.control.keyboard.press("Escape");
  await editor(app).getByRole("button", { name: "Cerrar" }).first().click();
  await app.control.getByRole("dialog", { name: "Hay cambios sin guardar" }).getByRole("button", { name: "Descartar cambios" }).click();
  await expect(app.control.getByRole("dialog")).toHaveCount(0);

  await edit(app, "Oh qué amigo");
  fs.appendFileSync(changed, "\n");
  const later = new Date(Date.now() + 5_000);
  fs.utimesSync(changed, later, later);
  await field(app, "Título").fill("Cambiada en Himnova");
  await editor(app).getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(toast(app, "El archivo de esta canción cambió fuera de Himnova").first()).toBeVisible();
  expect(fs.readFileSync(changed, "utf8")).toContain("{title: Oh qué amigo}");
  await save(app, "Cambiada en Himnova");
  await expect.poll(() => fs.readFileSync(changed, "utf8")).toContain("{title: Cambiada en Himnova}");
});

test("an imported hymn with a slide that starts with the word «Coro»: renaming it keeps its slides", async ({ app }) => {
  // As the HASD hymnal writes its hymns: every slide a verse of its own, and
  // the chorus's slide opening with the word «Coro» as a line of the lyrics.
  const lines = (...text: string[]) => `<lines><![CDATA[\n\t\t${text.join("\n")}\n\t  ]]></lines>`;
  const file = path.join(songFolder(app), "13.xml");
  fs.writeFileSync(
    file,
    `<?xml version='1.0' encoding='UTF-8'?>
<song xmlns="http://openlyrics.info/namespace/2009/song" version="0.8">
  <properties><titles><title>13 - Louvamos-Te, ó Deus</title></titles></properties>
  <lyrics>
    <verse name="v1a">${lines("Louvamos-Te, ó Deus")}</verse>
    <verse name="v1b">${lines("1.", "Louvamos-Te, ó Deus, pelo dom de Jesus,", "Que por nós, pecadores, foi morto na cruz.")}</verse>
    <verse name="v1c">${lines("Coro", "Aleluia! Toda a glória", "Te rendemos sem fim.")}</verse>
    <verse name="v1d">${lines("2.", "Louvamos-Te, ó Deus, pelo Espírito, luz", "Que nos tira das trevas e a Cristo conduz.")}</verse>
  </lyrics>
</song>`,
  );
  await importSongs(app, file);
  await expect(toast(app, "Se importó 1 canción").first()).toBeVisible();
  await songRows(app).first().click();
  const title = "13 - Louvamos-Te, ó Deus";
  await expect(previewGrid(app, title)).toHaveCount(4);
  const before = await previewGrid(app, title).allInnerTexts();

  await tab(app).getByRole("button", { name: "Editar canción" }).click();
  // The editor shows the song as stored, not «Coro» read as a chorus header.
  await expect(editor(app).getByRole("navigation").getByRole("listitem")).toHaveCount(4);
  const renamed = "13 - Louvamos-Te (renombrado)";
  await field(app, "Título").fill(renamed);
  await save(app, renamed);
  await close(app);
  // Only the title changed — each tile's footer carries it, so it is taken out of both sides.
  const untitled = (tiles: string[], name: string) => tiles.map((tile) => tile.split(name).join("TITLE"));
  expect(untitled(await previewGrid(app, renamed).allInnerTexts(), renamed)).toEqual(untitled(before, title));
  expect(fs.readFileSync(file, "utf8")).not.toMatch(/<verse name="c1">/);
});

test("linked SongSelect and OpenLyrics files keep what the editor saved once they are read again", async ({ app }) => {
  const dir = songFolder(app);
  const songSelect = path.join(dir, "amazing-grace.txt");
  fs.writeFileSync(
    songSelect,
    [
      "Amazing Grace",
      "",
      "",
      "Verse 1",
      "Amazing grace how sweet the sound",
      "That saved a wretch like me",
      "I once was lost but now am found",
      "Was blind but now I see",
      "",
      "",
      "Verse 2",
      "'Twas grace that taught my heart to fear",
      "And grace my fears relieved",
      "",
      "CCLI Song # 22025",
      "John Newton",
      "Public Domain",
      "For use solely with the SongSelect Terms of Use.  All rights reserved. www.ccli.com",
      "CCLI License # 000000",
      "",
    ].join("\r\n"),
  );
  // A second language in the file is the song's translation.
  const openLyrics = path.join(dir, "hava-nagila.xml");
  fs.writeFileSync(
    openLyrics,
    `<?xml version='1.0' encoding='UTF-8'?>
<song xmlns="http://openlyrics.info/namespace/2009/song" version="0.8">
  <properties>
    <titles><title lang="he">הבה נגילה</title><title lang="en">Let Us Rejoice</title></titles>
    <verseOrder>v1 c v1 c</verseOrder>
  </properties>
  <lyrics>
    <verse name="v1" lang="he"><lines>הבה נגילה<br/>הבה נגילה ונשמחה</lines></verse>
    <verse name="v1" lang="en"><lines>Let's rejoice<br/>Let's rejoice and be happy</lines></verse>
    <verse name="c" lang="he"><lines>הבה נרננה<br/>הבה נרננה ונשמחה</lines></verse>
    <verse name="c" lang="en"><lines>Let's sing<br/>Let's sing and be happy</lines></verse>
  </lyrics>
</song>`,
  );
  await linkFolder(app, dir);
  const translation = () => editor(app).getByRole("textbox", { name: "Traducción" });
  const chips = () => editor(app).getByRole("list", { name: "Orden de la canción" }).getByRole("listitem");

  // SongSelect: a number, notes, a slide break and a translation — none of them its own format's.
  await edit(app, "Amazing Grace");
  await field(app, "Número").fill("330");
  await field(app, "Notas").fill("Cantar lento");
  // A blank line inside Verse 1: two slides, as the editor's hint teaches.
  const lyrics = await lyricsBox(app).inputValue();
  await lyricsBox(app).fill(lyrics.replace("That saved a wretch like me\n", "That saved a wretch like me\n\n"));
  await editor(app).getByRole("tab", { name: "Traducción" }).click();
  await translation().fill("[Estrofa 1]\nSublime gracia");
  await save(app, "Amazing Grace");
  await close(app);

  // OpenLyrics: a title edit keeps the lyrics, the translation and the order.
  await edit(app, "הבה נגילה");
  const hebrew = await lyricsBox(app).inputValue();
  const order = await chips().allInnerTexts();
  await editor(app).getByRole("tab", { name: "Traducción" }).click();
  const english = await translation().inputValue();
  expect(english).toContain("Let's rejoice");
  await editor(app).getByRole("tab", { name: "Letra" }).click();
  await field(app, "Título").fill("הבה נגילה (2)");
  await save(app, "הבה נגילה (2)");
  await close(app);

  await reread(app, dir, songSelect, openLyrics);
  await edit(app, "Amazing Grace");
  await expect(field(app, "Número")).toHaveValue("330");
  await expect(field(app, "Notas")).toHaveValue("Cantar lento");
  await expect(lyricsBox(app)).toHaveValue(/That saved a wretch like me\n\nI once was lost/);
  await editor(app).getByRole("tab", { name: "Traducción" }).click();
  await expect(translation()).toHaveValue(/Sublime gracia/);
  await close(app);

  await edit(app, "הבה נגילה (2)");
  await expect(lyricsBox(app)).toHaveValue(hebrew);
  await expect(chips()).toHaveText(order);
  await editor(app).getByRole("tab", { name: "Traducción" }).click();
  await expect(translation()).toHaveValue(english);
});

test("an imported ChordPro song keeps its chords through an edit of its words", async ({ app }) => {
  const file = path.join(songFolder(app), "stille-nacht.chordpro");
  fs.writeFileSync(
    file,
    "{title: Stille Nacht}\n{artist: Joseph Mohr & Franz Gruber}\n\nVerse 1\n[Bb]Stille Nacht, heilige Nacht,\n[F]alles schläft, [Bb]einsam wacht\nnur das [Eb]traute hoch[Bb]heilige Paar\n",
  );
  await importSongs(app, file);
  await expect(toast(app, "Se importó 1 canción").first()).toBeVisible();
  const chords = async () => (await lyricsBox(app).inputValue()).match(/\[[A-H][#b]?m?\d?\]/g) ?? [];

  await edit(app, /Stille Nacht/);
  const before = await chords();
  expect(before).toEqual(["[Bb]", "[F]", "[Bb]", "[Eb]", "[Bb]"]);
  await lyricsBox(app).fill((await lyricsBox(app).inputValue()).replace("Stille Nacht,", "Stille, stille Nacht,"));
  await save(app, "Stille Nacht");
  await close(app);
  await edit(app, /Stille Nacht/);
  expect(await chords()).toEqual(before);
});
