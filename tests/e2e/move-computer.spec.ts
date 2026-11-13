import fs from "node:fs";
import path from "node:path";
import type { MediaAsset } from "../../src/shared/types/media";
import type { Locale, SettingsMap } from "../../src/shared/types/settings";
import type { Song } from "../../src/shared/types/song";
import mainEn from "../../src/main/i18n/messages/en";
import { fixture } from "./support/paths";
import { expect, test, videoStates, WorshipApp } from "./support/app";

/**
 * Everything carried to another computer, as the guide «Llevar todo a otra computadora» tells a church
 * to do it (2026-11-13): the user's files copied to a computer where the user is called something else
 * (`…\Users\juan` → `…\Users\maria`), and the app's data either as its whole profile folder, or as a
 * copy on a pen drive restored into a fresh install. Then ONE file is relocated and the rest follows:
 * the library, a deck's chosen music, Media's and Songs' linked folders, the folder's songs, and the
 * factory backgrounds the song themes and the verse are dressed with. The old computer is gone: its
 * folders are deleted, so nothing can be read from there.
 */

const PROFILE = path.join("AppData", "Roaming", "worship-app");

/** A user's files, the way a church keeps them. */
const FILES = [
  ["clip.mp4", "Videos/Iglesia/clip.mp4"],
  ["clip.mp4", "Videos/Iglesia/clip2.mp4"],
  ["photo.png", "Pictures/foto.png"],
  ["intro.mp3", "Music/intro.mp3"],
  ["song.mp3", "Music/himno.mp3"],
  ["hymn.pptx", "Documents/Himnos/hymn.pptx"],
] as const;

const SONG = "{title: Primera}\n{start_of_verse}\nLetra de la primera\n{end_of_verse}\n";

const toast = (app: WorshipApp, text: string | RegExp) => app.control.getByRole("status").filter({ hasText: text });
const panel = (app: WorshipApp, tab: "Videos" | "Imágenes") => app.control.getByRole("tabpanel", { name: tab });

/** Whether `file` exists under `folder`. By real path: macOS's temp folder is behind a symlink, and the
 *  profile's own paths come back resolved. */
const existsUnder = (file: string, folder: string) =>
  fs.existsSync(file) && fs.realpathSync(file).startsWith(fs.realpathSync(folder) + path.sep);

const launched: WorshipApp[] = [];
async function launch(profile: string, locale: Locale = "es"): Promise<WorshipApp> {
  const app = await WorshipApp.launch(profile, false, locale, true);
  launched.push(app);
  return app;
}

// eslint-disable-next-line no-empty-pattern -- Playwright's fixture signature
test.afterEach(async ({}, testInfo) => {
  for (const app of launched.splice(0)) {
    await app.kill();
    await testInfo.attach(`app-${path.basename(path.dirname(path.dirname(path.dirname(app.profile))))}.log`, {
      body: app.log.join("\n"),
    });
    expect(app.unexpectedErrors(), "the app logged an unexpected error").toEqual([]);
  }
});

/** The old computer: juan's files, a library, a deck with its music, both linked folders, a folder song,
 *  a saved program and the order of service on screen. Returns a copy made from Settings. */
async function oldComputer(juan: string): Promise<string> {
  for (const [name, as] of FILES) {
    fs.mkdirSync(path.dirname(path.join(juan, as)), { recursive: true });
    fs.copyFileSync(fixture(name), path.join(juan, as));
  }
  fs.mkdirSync(path.join(juan, "Documents", "Canciones"), { recursive: true });
  fs.writeFileSync(path.join(juan, "Documents", "Canciones", "primera.cho"), SONG);

  const app = await launch(path.join(juan, PROFILE));
  const file = (as: string) => path.join(juan, as);
  const [clip] = await app.invoke<MediaAsset[]>("library:add", { kind: "video", paths: [file("Videos/Iglesia/clip.mp4"), file("Videos/Iglesia/clip2.mp4")] });
  const [photo] = await app.invoke<MediaAsset[]>("library:add", { kind: "image", paths: [file("Pictures/foto.png")] });
  const [intro] = await app.invoke<MediaAsset[]>("library:add", { kind: "audio", paths: [file("Music/intro.mp3")] });
  const [deck] = await app.invoke<MediaAsset[]>("library:add", { kind: "ppt", paths: [file("Documents/Himnos/hymn.pptx")] });
  await app.invoke("library:setLinkedAudio", { id: deck!.id, path: file("Music/himno.mp3") });

  // The order of service on screen, recovered on the next launch.
  await app.previewFile("Videos", "clip");
  await panel(app, "Videos").getByRole("button", { name: "Agregar al programa" }).click();
  await app.answerOpenDialog(file("Videos/Iglesia"));
  await panel(app, "Videos").getByRole("button", { name: "Vincular carpeta" }).click();
  const songsTab = app.control.getByRole("tabpanel", { name: "Canciones" });
  await app.openResources("Canciones");
  await app.answerOpenDialog(file("Documents/Canciones"));
  await songsTab.getByRole("button", { name: "Vincular carpeta" }).click();
  await expect(songsTab.getByRole("list", { name: "Canciones" }).getByRole("listitem").filter({ hasText: "Primera" })).toBeVisible();
  const [song] = await app.invoke<Song[]>("song:listFolder", { path: file("Documents/Canciones") });
  await app.invoke("programs:save", {
    name: "Culto",
    items: [
      { kind: "media", mediaAssetId: clip!.id, title: null },
      { kind: "ppt", mediaAssetId: deck!.id, title: null },
      { kind: "media", mediaAssetId: photo!.id, title: null },
      { kind: "media", mediaAssetId: intro!.id, title: null },
      { kind: "song", songId: song!.id, title: null },
    ],
  });

  // The order of service reaches the database 600 ms after its last change (`draft-autosave.ts`).
  await expect.poll(() => app.invoke("program:loadDraft")).not.toBeNull();
  const settings = app.control.getByRole("dialog", { name: "Configuración" });
  await app.control.getByRole("button", { name: "Configuración" }).click();
  await settings.getByRole("tab", { name: "Copias de seguridad" }).click();
  await settings.getByRole("button", { name: "Hacer una copia" }).click();
  await expect(toast(app, /^Copia hecha: /)).toBeVisible();
  await app.quit("close");

  const daily = path.join(juan, PROFILE, "backups", "daily");
  const newest = fs
    .readdirSync(daily)
    .filter((name) => name.endsWith(".db"))
    .map((name) => path.join(daily, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  return newest!;
}

/** On the new computer, with the data in place: ONE file relocated, and everything else found. */
async function relocateOneAndCheck(app: WorshipApp, user: string): Promise<void> {
  const profile = path.join(user, PROFILE);
  // The factory backgrounds follow the profile on their own, before anything is relocated.
  const looks = async () =>
    [
      ...(await app.invoke<MediaAsset[]>("library:list", { kind: "image" })),
      ...(await app.invoke<MediaAsset[]>("library:list", { kind: "video" })),
    ].filter((asset) => path.basename(path.dirname(asset.path)) === "backgrounds");
  const backgrounds = await looks();
  expect(backgrounds).toHaveLength(12);
  for (const asset of backgrounds) expect(existsUnder(asset.path, path.join(profile, "backgrounds")), asset.path).toBe(true);

  await app.control.getByRole("main").getByRole("list").first().getByRole("listitem").filter({ hasText: "clip" }).click();
  await expect(app.previewColumn().getByText("Media no encontrada").first()).toBeVisible();
  await app.answerOpenDialog(path.join(user, "Videos", "Iglesia", "clip.mp4"));
  await app.previewColumn().getByRole("button", { name: "Relocalizar…" }).click();
  await expect(toast(app, /^«clip» quedó apuntando al archivo nuevo\. También se encontraron \d+ más que se movieron con él\./)).toBeVisible();

  for (const kind of ["video", "image", "audio", "ppt"] as const) {
    for (const asset of await app.invoke<MediaAsset[]>("library:list", { kind })) {
      expect(existsUnder(asset.path, user), asset.path).toBe(true);
      if (asset.linkedAudioPath) expect(existsUnder(asset.linkedAudioPath, user), asset.linkedAudioPath).toBe(true);
    }
  }
  const [deck] = await app.invoke<MediaAsset[]>("library:list", { kind: "ppt" });
  expect(deck?.linkedAudioPath).toBe(path.join(user, "Music", "himno.mp3"));
  const settings = await app.invoke<SettingsMap>("settings:get");
  expect(settings["library.linkedFolders"].video).toEqual([path.join(user, "Videos", "Iglesia")]);
  expect(settings["songs.linkedFolders"]).toEqual([path.join(user, "Documents", "Canciones")]);

  // What the operator sees: no file missing anywhere, the folder's song, the deck's slides, the video on air.
  await app.openResources("Medios", "Videos");
  await expect(panel(app, "Videos").getByRole("combobox", { name: "Origen" })).toHaveText("Iglesia");
  await expect(panel(app, "Videos").getByText("No encontrado")).toHaveCount(0);
  await app.openResources("Medios", "Imágenes");
  await expect(panel(app, "Imágenes").getByRole("button", { name: "foto" })).toBeVisible();
  await expect(panel(app, "Imágenes").getByText("No encontrado")).toHaveCount(0);
  const songsTab = app.control.getByRole("tabpanel", { name: "Canciones" });
  await app.openResources("Canciones");
  await expect(songsTab.getByRole("list", { name: "Canciones" }).getByRole("listitem").filter({ hasText: "Primera" })).toBeVisible();
  await app.previewFile("Presentaciones", "hymn");
  await expect(
    app.previewColumn().getByRole("list", { name: "Presentación" }).getByRole("button", { name: "3", exact: true }),
  ).toBeVisible({ timeout: 90_000 });
  await app.control.getByRole("main").getByRole("list").first().getByRole("listitem").filter({ hasText: "clip" }).click();
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await videoStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.3);
}

test("the whole profile folder carried to another computer: relocating one file finds the rest", async ({ profileDir }) => {
  test.setTimeout(240_000);
  const juan = path.join(profileDir, "Users", "juan");
  const maria = path.join(profileDir, "Users", "maria");
  await oldComputer(juan);
  fs.cpSync(juan, maria, { recursive: true });
  fs.rmSync(juan, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

  await relocateOneAndCheck(await launch(path.join(maria, PROFILE)), maria);
});

test("a copy on a pen drive restored into a fresh install on another computer: relocating one file finds the rest", async ({ profileDir }) => {
  test.setTimeout(240_000);
  const juan = path.join(profileDir, "Users", "juan");
  const ana = path.join(profileDir, "Users", "ana");
  const pendrive = path.join(profileDir, "pendrive", "himnova.db");
  const copy = await oldComputer(juan);
  fs.mkdirSync(path.dirname(pendrive), { recursive: true });
  fs.copyFileSync(copy, pendrive);
  // Only the user's files: the app's data travels on the pen drive.
  for (const folder of ["Videos", "Pictures", "Music", "Documents"]) {
    fs.cpSync(path.join(juan, folder), path.join(ana, folder), { recursive: true });
  }
  fs.rmSync(juan, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

  // A computer in another language: its new profile seeds the factory backgrounds as «Night.webp», not «Noche.webp».
  const fresh = await launch(path.join(ana, PROFILE), "en");
  expect(fs.existsSync(path.join(ana, PROFILE, "backgrounds", `${mainEn.look.backgrounds.night}.webp`))).toBe(true);
  await fresh.control.getByRole("button", { name: fresh.tr("Configuración") }).click();
  const settings = fresh.control.getByRole("dialog", { name: fresh.tr("Configuración") });
  await settings.getByRole("tab", { name: fresh.tr("Copias de seguridad") }).click();
  await settings.getByRole("button", { name: fresh.tr("Restaurar…") }).click();
  const dialog = fresh.control.getByRole("dialog", { name: fresh.tr("Restaurar una copia") });
  await fresh.answerOpenDialog(pendrive);
  await dialog.getByRole("button", { name: fresh.tr("Elegir otra copia…") }).click();
  await expect(dialog.getByRole("radio").filter({ hasText: fresh.tr("Otro archivo") })).toHaveAttribute("aria-checked", "true");
  // Under Playwright a relaunched app waits for a debugger: the test starts it again instead.
  await fresh.electron.evaluate(({ app }) => {
    app.relaunch = () => undefined;
  });
  await dialog.getByRole("button", { name: fresh.tr("Restaurar y reiniciar") }).click();
  await fresh.exited;

  const restored = await launch(path.join(ana, PROFILE));
  await expect(toast(restored, /^Se restauró la copia del /)).toBeVisible();
  await relocateOneAndCheck(restored, ana);
});
