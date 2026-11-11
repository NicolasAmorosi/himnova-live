import fs from "node:fs";
import path from "node:path";
import { expect, relaunch, test, videoStates, type WorshipApp } from "./support/app";

/** What goes wrong during a real service — a window closed by accident, the
 *  app killed, a key pressed in the wrong place — and must not cost the
 *  operator what was on the screen or in the schedule. */

const JUAN_3_16 = "Porque de tal manera amó Dios al mundo";

const scheduleRows = (app: WorshipApp) =>
  app.control
    .locator("section")
    .filter({ has: app.control.getByRole("heading", { name: "Programa", exact: true }) })
    .getByRole("list")
    .first()
    .getByRole("listitem");

async function verseLive(app: WorshipApp) {
  await app.openChapter("Juan 3");
  await app.control.getByRole("listitem").filter({ hasText: JUAN_3_16 }).click();
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toBeVisible();
  return projector;
}

test("a projector whose renderer dies leaves its reason in crash.log", async ({ app }) => {
  await verseLive(app);
  await app.electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().endsWith("/projection.html"))
      ?.webContents.forcefullyCrashRenderer(),
  );
  const crashLog = path.join(app.profile, "crash.log");
  await expect
    .poll(() => (fs.existsSync(crashLog) ? fs.readFileSync(crashLog, "utf8") : ""))
    .toMatch(/\[render-process-gone\] \S+\/projection\.html \{"reason":"(crashed|killed)"/);
});

test("a projector closed from outside is announced, and «Reabrir» brings back what was live where it was", async ({ app }) => {
  await app.addMedia("video", "clip.mp4");
  await app.previewFile("Videos", "clip");
  await app.goLive();
  const first = await app.projector();
  await expect.poll(async () => (await videoStates(first))[0]?.currentTime ?? 0).toBeGreaterThan(2);

  await first.close();
  const notice = app.control.getByRole("status").filter({ hasText: "Se cerró la ventana de proyección" });
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Reabrir" }).click();

  const second = await app.projector();
  // Not on NEGRO, not back at 0:00: the same video, from where it was —
  // read from where its playback began, which a frame from 0:00 would show.
  await expect.poll(async () => (await videoStates(second))[0]?.playedFrom ?? null).not.toBeNull();
  expect((await videoStates(second))[0]?.playedFrom).toBeGreaterThan(1.8);
  expect((await videoStates(second))[0]?.opacity).toBe(1);
  await expect(notice).toHaveCount(0);
});

test("an order of service survives the app being killed", async ({ app }) => {
  await app.addMedia("video", "clip.mp4");
  await app.addMedia("image", "photo.png");
  for (const [tab, name] of [["Videos", "clip"], ["Imágenes", "photo"]] as const) {
    await app.previewFile(tab, name);
    await app.control.getByRole("tabpanel", { name: tab }).getByRole("button", { name: "Agregar al programa" }).click();
  }
  await expect(scheduleRows(app)).toHaveText([/clip/, /photo/]);
  // Past the autosave's debounce, then gone with no chance to clean up.
  await app.control.waitForTimeout(1500);
  process.kill(app.mainPid, "SIGKILL");
  await app.exited;

  const again = await relaunch(app);
  await expect(again.control.getByText("Se recuperó el programa que estabas armando")).toBeVisible();
  await expect(scheduleRows(again)).toHaveText([/clip/, /photo/]);
});

test("typing in a search box never presses a shortcut", async ({ app }) => {
  const projector = await verseLive(app);
  const search = app.control.getByRole("textbox", { name: "Libro, capítulo y versículo…" });
  await search.fill("");
  await search.pressSequentially("lbl b");
  await app.control.waitForTimeout(500);
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toBeVisible();
  await expect(app.control.getByRole("button", { name: "NEGRO" })).not.toHaveAttribute("aria-pressed", "true");
});

test("with a dialog open, B and L do nothing to the projector", async ({ app }) => {
  const projector = await verseLive(app);
  await app.control.getByRole("button", { name: "Configuración" }).click();
  await expect(app.control.getByRole("dialog", { name: "Configuración" })).toBeVisible();
  await app.control.keyboard.press("b");
  await app.control.keyboard.press("l");
  await app.control.waitForTimeout(500);
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toBeVisible();
});

test("the pointer leaving the window from a button with a tooltip raises no error", async ({ app }) => {
  // Up from the top bar into the title bar, or across to the projector's
  // screen: React reports the window itself as where the pointer went.
  const settings = app.control.getByRole("button", { name: "Configuración" });
  await settings.hover();
  const box = await settings.boundingBox();
  await app.control.mouse.move((box?.x ?? 10) + 5, -20);
  await app.control.waitForTimeout(500);
  await expect(app.control.getByText("Ocurrió un error inesperado")).toHaveCount(0);
});

test("empty files of every kind are added, previewed and sent live without an error", async ({ app }) => {
  const zero = path.join(app.profile, "zero");
  fs.mkdirSync(zero);
  for (const [kind, name] of [["video", "vacio.mp4"], ["image", "vacio.png"], ["audio", "vacio.mp3"], ["ppt", "vacio.pptx"], ["ppt", "vacio.pdf"]]) {
    fs.writeFileSync(path.join(zero, name!), "");
    await app.invoke("library:add", { kind, paths: [path.join(zero, name!)] });
  }
  // Each sent live, given the time to fail where it would.
  await app.previewFile("Imágenes", "vacio");
  await app.goLive();
  await app.projector();
  await app.control.waitForTimeout(1000);
  await app.previewFile("Videos", "vacio");
  await app.goLive();
  await app.control.waitForTimeout(1500);
  await app.previewFile("Audios", "vacio");
  await app.goLive();
  await app.control.waitForTimeout(1500);
  // The two empty decks say they cannot be opened.
  const decks = app.control.getByRole("tabpanel", { name: "Presentaciones" }).getByRole("button", { name: "vacio" });
  await app.previewFile("Presentaciones", "vacio");
  await expect(app.previewColumn()).toContainText(/no se puede|No se pudo|no es una presentación|vac/i);
  await decks.nth(1).click();
  await expect(app.previewColumn()).toContainText(/no se puede|No se pudo|no es una presentación|vac/i);
  await expect(app.control.getByRole("status").filter({ hasText: "error inesperado" })).toHaveCount(0);
});

test("with a full-screen editor open, no key drives the projector — typed in its fields or pressed on its canvas", async ({ app }) => {
  const { control } = app;
  await app.openResources("Canciones");
  const songs = control.getByRole("tabpanel", { name: "Canciones" });
  await songs.getByRole("button", { name: "Nueva canción" }).first().click();
  const editor = control.getByRole("dialog").first();
  await editor.getByRole("textbox", { name: "Título" }).fill("Teclas");
  await editor.getByRole("textbox", { name: "Letra" }).fill("[Estrofa 1]\nprimera\n\n[Coro]\nel coro");
  await editor.getByRole("button", { name: "Guardar", exact: true }).click();
  await editor.getByRole("button", { name: "Cerrar" }).first().click();
  await songs.getByRole("list", { name: "Canciones" }).getByRole("listitem").first().click();
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText("primera")).toBeVisible();
  const untouched = async () => {
    await expect(projector.getByText("primera")).toBeVisible();
    await expect(app.liveColumn().getByText("1/2")).toHaveCount(1);
    await expect(control.getByRole("button", { name: "NEGRO", exact: true }).first()).not.toHaveAttribute("aria-pressed", "true");
  };

  // The song editor: a song's jump keys, digits, the arrows and a remote's PageDown, typed into a note.
  await songs.getByRole("button", { name: "Editar canción" }).click();
  const notes = editor.getByRole("textbox", { name: "Notas", exact: true });
  await notes.click();
  await control.keyboard.type("c t 2 b ");
  await control.keyboard.press("ArrowRight");
  await control.keyboard.press("PageDown");
  await expect(notes).toHaveValue("c t 2 b ");
  await untouched();
  await editor.getByRole("button", { name: "Cerrar" }).first().click();
  await control.getByRole("dialog", { name: "Hay cambios sin guardar" }).getByRole("button", { name: "Descartar cambios" }).click();

  // The themes editor, the focus on its canvas and not in a field.
  await songs.getByRole("button", { name: "Temas" }).click();
  const themes = control.getByRole("dialog", { name: "Temas" });
  await themes.getByText("Última", { exact: true }).last().click();
  for (const key of ["b", "l", "ArrowRight", "ArrowDown", "Enter", "PageDown", "."]) await control.keyboard.press(key);
  await control.waitForTimeout(500);
  await untouched();
  await expect(themes).toBeVisible();
});
