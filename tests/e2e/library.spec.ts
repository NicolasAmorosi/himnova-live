import fs from "node:fs";
import path from "node:path";
import type { MediaAsset } from "../../src/shared/types/media";
import { fixture } from "./support/paths";
import { engineStates, expect, relaunch, test, videoStates, type WorshipApp } from "./support/app";

/**
 * The library as the operator meets it: files picked with the native dialog,
 * found by name, removed (and un-removed), moved behind the app's back, and
 * browsed straight off a linked folder. Files a test changes are copies under
 * the throwaway profile, never the shared fixtures.
 */

/** A copy of a fixture under this test's profile, so it can be moved,
 *  overwritten or deleted. */
function copyFixture(app: WorshipApp, name: string, as: string = name): string {
  const target = path.join(app.profile, "media-src", as);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(fixture(name), target);
  return target;
}

const panel = (app: WorshipApp, tab: "Videos" | "Imágenes" | "Audios" | "Presentaciones") =>
  app.control.getByRole("tabpanel", { name: tab });

const tileNames = (app: WorshipApp, tab: "Videos" | "Imágenes" | "Audios" | "Presentaciones") =>
  panel(app, tab).getByRole("list").getByRole("button").evaluateAll((tiles) => tiles.map((tile) => tile.textContent?.trim()));

const toast = (app: WorshipApp, text: string | RegExp) => app.control.getByRole("status").filter({ hasText: text });

test("«Agregar» imports what the dialog returns, and a cancelled dialog adds nothing", async ({ app }) => {
  await app.openResources("Medios", "Videos");
  await expect(panel(app, "Videos").getByText("No hay archivos")).toBeVisible();

  await app.answerOpenDialog();
  await panel(app, "Videos").getByRole("button", { name: "Agregar", exact: true }).click();
  await app.control.waitForTimeout(500);
  await expect(panel(app, "Videos").getByText("No hay archivos")).toBeVisible();

  await app.answerOpenDialog(fixture("clip.mp4"));
  await panel(app, "Videos").getByRole("button", { name: "Agregar", exact: true }).click();
  await expect(panel(app, "Videos").getByRole("button", { name: "clip" })).toBeVisible();
  // And it is a real asset, ready to project.
  await panel(app, "Videos").getByRole("button", { name: "clip" }).dblclick();
  const projector = await app.projector();
  await expect.poll(async () => (await videoStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.3);
});

test("a file is found by name, and the chosen order survives a restart", async ({ app }) => {
  const paths = ["alba.png", "coro.png", "zeta.png"].map((name) => copyFixture(app, "photo.png", name));
  await app.invoke<MediaAsset[]>("library:add", { kind: "image", paths });
  await app.openResources("Medios", "Imágenes");

  await app.control.getByRole("button", { name: "Ordenar" }).click();
  await app.control.getByRole("menuitemradio", { name: "Nombre (A → Z)" }).click();
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(["alba", "coro", "zeta"]);
  await app.control.getByRole("button", { name: "Ordenar" }).click();
  await app.control.getByRole("menuitemradio", { name: "Nombre (Z → A)" }).click();
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(["zeta", "coro", "alba"]);

  const search = panel(app, "Imágenes").getByRole("textbox", { name: "Buscar por nombre…" });
  await search.fill("co");
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(["coro"]);
  await search.fill("nada");
  await expect(panel(app, "Imágenes").getByText("Sin resultados")).toBeVisible();
  await search.press("Escape");
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(["zeta", "coro", "alba"]);

  await app.quit();
  const again = await relaunch(app);
  await again.openResources("Medios", "Imágenes");
  // The order is durable; the search is not.
  await expect.poll(() => tileNames(again, "Imágenes")).toEqual(["zeta", "coro", "alba"]);
  await expect(panel(again, "Imágenes").getByRole("textbox", { name: "Buscar por nombre…" })).toHaveValue("");
});

test("removing a file can be undone, and otherwise it is gone for good — off the projector too", async ({ app }) => {
  await app.addMedia("image", "photo.png");
  await app.previewFile("Imágenes", "photo");
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.locator('img[src^="worship://asset/"]')).toBeVisible();
  await panel(app, "Imágenes").getByRole("button", { name: "Quitar", exact: true }).click();
  await expect(panel(app, "Imágenes").getByRole("button", { name: "photo" })).toHaveCount(0);

  await toast(app, "Se quitó «photo» de la biblioteca.").getByRole("button", { name: "Deshacer" }).click();
  await expect(panel(app, "Imágenes").getByRole("button", { name: "photo" })).toBeVisible();

  // The Delete key does the same thing to the selected tile.
  await panel(app, "Imágenes").getByRole("button", { name: "photo" }).click();
  await app.control.keyboard.press("Delete");
  await expect(panel(app, "Imágenes").getByRole("button", { name: "photo" })).toHaveCount(0);
  // Once the undo window closes, main has really dropped it.
  await expect.poll(() => app.invoke<MediaAsset[]>("library:list", { kind: "image" }), { timeout: 12_000 }).toEqual([]);
  // A file that is gone is not left on the projector, pointing at nothing.
  await expect(projector.locator('img[src^="worship://asset/"]')).toHaveCount(0);
});

test("a file used in a saved program is only removed after a warning naming it", async ({ app }) => {
  const { control } = app;
  await app.addMedia("image", "photo.png");
  await app.previewFile("Imágenes", "photo");
  await panel(app, "Imágenes").getByRole("button", { name: "Agregar al programa" }).click();
  await control.getByRole("button", { name: "Guardar", exact: true }).click();
  const programs = control.getByRole("dialog", { name: "Programas" });
  await programs.getByRole("textbox", { name: "Nombre" }).fill("Culto del sábado");
  await programs.getByRole("button", { name: "Guardar", exact: true }).last().click();
  await programs.getByRole("button", { name: "Cerrar" }).click();

  await panel(app, "Imágenes").getByRole("button", { name: "photo" }).click();
  await panel(app, "Imágenes").getByRole("button", { name: "Quitar", exact: true }).click();
  // Refused, with a way through.
  await toast(app, "No se puede quitar: se usa en un programa guardado.").getByRole("button", { name: "Quitar igualmente" }).click();
  const confirm = control.getByRole("dialog", { name: "¿Quitar igualmente?" });
  await expect(confirm).toContainText("Culto del sábado");
  await confirm.getByRole("button", { name: "Quitar igualmente" }).click();

  await expect(panel(app, "Imágenes").getByRole("button", { name: "photo" })).toHaveCount(0);
  await expect(control.getByText("Programa vacío")).toBeVisible();
  const [saved] = await app.invoke<{ id: number; itemCount: number }[]>("programs:list");
  expect(saved?.itemCount).toBe(0);
});

test("a file moved away is shown missing and relocated without losing its row", async ({ app }) => {
  const original = copyFixture(app, "clip.mp4");
  await app.invoke<MediaAsset[]>("library:add", { kind: "video", paths: [original] });
  await app.previewFile("Videos", "clip");
  await panel(app, "Videos").getByRole("button", { name: "Agregar al programa" }).click();
  await app.quit("close");

  // Moved while the app was closed, the way a renamed folder does it.
  const moved = path.join(app.profile, "elsewhere", "clip.mp4");
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.renameSync(original, moved);

  const again = await relaunch(app);
  await again.openResources("Medios", "Videos");
  await expect(panel(again, "Videos").getByRole("button", { name: "clip" })).toContainText("No encontrado");
  // The recovered order of service still has it, and PREVIEW says what is wrong.
  await again.control.getByRole("main").getByRole("list").first().getByRole("listitem").filter({ hasText: "clip" }).click();
  await expect(again.previewColumn().getByText("Media no encontrada").first()).toBeVisible();

  await again.answerOpenDialog(moved);
  await again.previewColumn().getByRole("button", { name: "Relocalizar…" }).click();
  await expect(toast(again, "«clip» quedó apuntando al archivo nuevo")).toBeVisible();
  await expect(panel(again, "Videos").getByRole("button", { name: "clip" })).not.toContainText("No encontrado");

  await again.goLive();
  const projector = await again.projector();
  await expect.poll(async () => (await videoStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.3);
});

test("a file the projector cannot play is reported in the control window, never on the projector", async ({ app }) => {
  const file = copyFixture(app, "clip.mp4");
  await app.invoke<MediaAsset[]>("library:add", { kind: "video", paths: [file] });
  // Probed as playable, then broken on disk behind the app's back.
  await app.control.waitForTimeout(2500);
  fs.writeFileSync(file, Buffer.alloc(64 * 1024, 7));

  await app.previewFile("Videos", "clip");
  await app.goLive();
  const projector = await app.projector();
  await expect(toast(app, "No se pudo reproducir «clip» en el proyector")).toBeVisible();
  await expect(app.liveColumn().getByText("No se pudo reproducir", { exact: true })).toBeVisible();
  // The congregation sees no error text.
  await expect(projector.locator("body")).not.toContainText("No se pudo");
});

test("a linked folder shows what is on disk, plays what Chromium cannot, and unlinks without touching files", async ({ app }) => {
  const folder = path.dirname(copyFixture(app, "clip.mp4"));
  copyFixture(app, "clip-xvid.avi");
  copyFixture(app, "photo.png");

  await app.openResources("Medios", "Videos");
  await app.answerOpenDialog(folder);
  await panel(app, "Videos").getByRole("button", { name: "Vincular carpeta" }).click();
  // The source is a dropdown in the search row, there only once a folder is linked (2026-11-05).
  await expect(panel(app, "Videos").getByRole("combobox", { name: "Origen" })).toHaveText(path.basename(folder));
  // Only the videos of the folder, in this tab.
  await expect.poll(() => tileNames(app, "Videos")).toEqual(expect.arrayContaining(["clip", "clip-xvid"]));
  expect(await tileNames(app, "Videos")).toHaveLength(2);
  // An AVI seen in a linked folder is checked on its own, and the media engine plays it.
  await expect.poll(async () => (await app.invoke<number[]>("engine:assets")).length > 0, { timeout: 30_000 }).toBe(true);

  await panel(app, "Videos").getByRole("button", { name: "clip-xvid" }).dblclick();
  const projector = await app.projector();
  await expect.poll(async () => (await engineStates(projector))[0]?.width ?? 0).toBe(640);

  await panel(app, "Videos").getByRole("button", { name: "Desvincular carpeta" }).click();
  await app.control.getByRole("dialog", { name: "¿Desvincular la carpeta?" }).getByRole("button", { name: "Desvincular carpeta" }).click();
  // The last folder gone, the dropdown goes with it.
  await expect(panel(app, "Videos").getByRole("combobox", { name: "Origen" })).toHaveCount(0);
  expect(fs.readdirSync(folder).sort()).toEqual(["clip-xvid.avi", "clip.mp4", "photo.png"]);
});

test("«Agregar» with files of every kind sends each to its own tab, and counts the ones no tab takes (2026-11-06)", async ({ app }) => {
  const notes = path.join(app.profile, "notas.txt");
  fs.writeFileSync(notes, "hola");
  const bare = copyFixture(app, "clip.mp4", "sin-extension");
  await app.openResources("Medios", "Videos");
  await app.answerOpenDialog(fixture("clip.mp4"), fixture("photo.png"), fixture("song.mp3"), notes, bare);
  await panel(app, "Videos").getByRole("button", { name: "Agregar", exact: true }).click();
  await expect(panel(app, "Videos").getByRole("button", { name: "clip" })).toBeVisible();
  await expect(toast(app, "No se agregaron 2 archivos")).toBeVisible();
  const names = async (kind: "image" | "audio") => (await app.invoke<MediaAsset[]>("library:list", { kind })).map((asset) => asset.name);
  await expect.poll(() => names("image")).toEqual(["photo"]);
  await expect.poll(() => names("audio")).toEqual(["song"]);
});

test("names with accents, decomposed accents, emoji or great length are added once, found and projected", async ({ app }) => {
  const paths = [
    copyFixture(app, "photo.png", "Canción ñandú.png"),
    // As macOS hands some names over: «ó» as an «o» and a combining accent.
    copyFixture(app, "photo.png", "Bendición.png".normalize("NFD")),
    copyFixture(app, "photo.png", "Alabanza 🎵 日本.png"),
    copyFixture(app, "photo.png", `${"Himno muy largo ".repeat(14).trim()}.png`),
  ];
  await app.invoke<MediaAsset[]>("library:add", { kind: "image", paths });
  // The same file again, and through a path with a `.` segment: still four.
  await app.invoke<MediaAsset[]>("library:add", { kind: "image", paths: [paths[0]!, path.join(path.dirname(paths[0]!), ".", path.basename(paths[0]!))] });
  const listed = await app.invoke<MediaAsset[]>("library:list", { kind: "image" });
  expect(listed).toHaveLength(4);

  await app.openResources("Medios", "Imágenes");
  const search = panel(app, "Imágenes").getByRole("textbox", { name: "Buscar por nombre…" });
  for (const typed of ["bendicion", "canción", "🎵"]) {
    await search.fill(typed);
    await expect.poll(() => tileNames(app, "Imágenes"), typed).toHaveLength(1);
  }
  await search.fill("");

  for (const asset of listed) {
    await panel(app, "Imágenes").getByRole("list").getByRole("button").filter({ hasText: asset.name.slice(0, 12) }).first().dblclick();
    const projector = await app.projector();
    await expect
      .poll(() =>
        projector.evaluate(
          (id) => [...document.querySelectorAll("img")].some((img) => img.src === `worship://asset/${id}` && img.naturalWidth > 0),
          asset.id,
        ),
      )
      .toBe(true);
  }
});

test("Delete does nothing in a linked folder's view, and a folder's file in a program still saves", async ({ app }) => {
  const folder = path.dirname(copyFixture(app, "photo.png", "linked/carpeta-foto.png"));
  copyFixture(app, "photo.png", "linked/otra.png");
  await app.openResources("Medios", "Imágenes");
  await app.answerOpenDialog(folder);
  await panel(app, "Imágenes").getByRole("button", { name: "Vincular carpeta" }).click();
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(expect.arrayContaining(["carpeta-foto", "otra"]));
  // A folder's files are the computer's: no «Quitar» in its footer, and no Delete either — removing
  // one's library row left a dead tile that then failed a program's save.
  await expect(panel(app, "Imágenes").getByRole("button", { name: "Quitar", exact: true })).toHaveCount(0);
  const tile = panel(app, "Imágenes").getByRole("button", { name: "carpeta-foto" });
  await tile.click();
  await app.control.keyboard.press("Delete");
  await app.control.waitForTimeout(500);
  await expect(toast(app, "Se quitó")).toHaveCount(0);
  await expect(tile).toBeVisible();

  await tile.click();
  await panel(app, "Imágenes").getByRole("button", { name: "Agregar al programa" }).click();
  await app.control.getByRole("button", { name: "Guardar", exact: true }).click();
  const programs = app.control.getByRole("dialog", { name: "Programas" });
  await programs.getByRole("textbox", { name: "Nombre" }).fill("Con foto de carpeta");
  await programs.getByRole("button", { name: "Guardar", exact: true }).last().click();
  await expect(toast(app, '"Con foto de carpeta" guardado')).toBeVisible();
});

test("a file copied into a linked folder shows up when the operator comes back, and «Actualizar carpeta» drops one taken away (owner, 2026-11-06)", async ({
  app,
}) => {
  const folder = path.dirname(copyFixture(app, "photo.png", "linked/primera.png"));
  await app.openResources("Medios", "Imágenes");
  await app.answerOpenDialog(folder);
  await panel(app, "Imágenes").getByRole("button", { name: "Vincular carpeta" }).click();
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(["primera"]);

  copyFixture(app, "photo.png", "linked/segunda.png");
  // Away to Finder and back. The OS focus change cannot be staged under a fullscreen projector, so the
  // window gets the `focus` event Chromium fires when the operator comes back.
  await app.control.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => tileNames(app, "Imágenes"), { timeout: 8_000 }).toEqual(["primera", "segunda"]);

  fs.rmSync(path.join(folder, "primera.png"));
  await panel(app, "Imágenes").getByRole("button", { name: "Actualizar carpeta" }).click();
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(["segunda"]);
});

test("a linked folder gone from disk says so instead of looking empty", async ({ app }) => {
  const folder = path.dirname(copyFixture(app, "photo.png", "gone/a.png"));
  await app.openResources("Medios", "Imágenes");
  await app.answerOpenDialog(folder);
  await panel(app, "Imágenes").getByRole("button", { name: "Vincular carpeta" }).click();
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(["a"]);
  fs.rmSync(folder, { recursive: true, force: true });
  const source = panel(app, "Imágenes").getByRole("combobox", { name: "Origen" });
  await source.click();
  await app.control.getByRole("option", { name: "Biblioteca", exact: true }).click();
  await source.click();
  await app.control.getByRole("option", { name: "gone", exact: true }).click();
  await expect(panel(app, "Imágenes").getByText("La carpeta no está disponible", { exact: false })).toBeVisible();
});
