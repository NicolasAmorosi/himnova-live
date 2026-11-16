import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { audioStates, expect, relaunch, test, videoStates, type WorshipApp } from "./support/app";
import { ffmpegBinary } from "./support/paths";

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

test("a projector whose renderer dies comes back by itself onto what was live, its reason in crash.log", async ({ app }) => {
  app.crashLogExpected = true;
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
  // Before, the dead window stayed up, black or frozen, and nobody was told (2026-11-15 audit, A1).
  await expect(app.control.getByText("La ventana de proyección se cayó y se volvió a abrir sola")).toBeVisible();
  await expect.poll(() => app.electron.windows().filter((page) => page.url().endsWith("/projection.html")).length).toBe(1);
  const projector = await app.projector();
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toBeVisible();
});

test("an uncaught error in main is said in a box that leaves main serving the control window", async ({ app }) => {
  test.skip(process.platform !== "darwin", "measured on macOS: a sheet on the control window keeps main running");
  app.crashLogExpected = true;
  await app.electron.evaluate(() => {
    setTimeout(() => {
      throw new Error("zz-a23 uncaught in main");
    }, 0);
  });
  const crashLog = path.join(app.profile, "crash.log");
  await expect.poll(() => (fs.existsSync(crashLog) ? fs.readFileSync(crashLog, "utf8") : "")).toContain("zz-a23");
  // With the box open, GO LIVE, NEGRO and the engine's frames are IPC and main's own work: `showErrorBox` held main
  // until somebody clicked (2026-11-15 audit, A23).
  const within = <T>(promise: Promise<T>) =>
    Promise.race([promise.then(() => "answered"), new Promise((resolve) => setTimeout(() => resolve("main is held"), 3000))]);
  for (let i = 0; i < 3; i++) {
    expect(await within(app.invoke("engine:assets"))).toBe("answered");
    expect(await within(app.electron.evaluate(() => Date.now()))).toBe("answered");
  }
});

test("with the control window minimized, an uncaught error in main brings it back and still leaves main serving", async ({ app }) => {
  test.skip(process.platform !== "darwin", "measured on macOS: a minimized parent gets the blocking box");
  app.crashLogExpected = true;
  const control = () =>
    app.electron.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().endsWith("/index.html"))!;
      return { minimized: w.isMinimized(), visible: w.isVisible() };
    });
  // The operator may minimize it mid-service with the projector up (owner, 2026-11-13).
  await app.electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/index.html"))!.minimize(),
  );
  await expect.poll(async () => (await control()).minimized).toBe(true);
  await app.electron.evaluate(() => {
    setTimeout(() => {
      throw new Error("zz-a23 uncaught with the window minimized");
    }, 0);
  });
  const crashLog = path.join(app.profile, "crash.log");
  await expect.poll(() => (fs.existsSync(crashLog) ? fs.readFileSync(crashLog, "utf8") : "")).toContain("zz-a23");
  // A minimized window is not visible: the box fell back to `showErrorBox` and held main (review of A23).
  const within = <T>(promise: Promise<T>) =>
    Promise.race([promise.then(() => "answered"), new Promise((resolve) => setTimeout(() => resolve("main is held"), 3000))]);
  for (let i = 0; i < 3; i++) {
    expect(await within(app.invoke("engine:assets"))).toBe("answered");
    expect(await within(app.electron.evaluate(() => Date.now()))).toBe("answered");
  }
  // Back on screen, with the sheet on it (the restore is animated, and the sheet waits for it): main still serves.
  await expect.poll(control).toEqual({ minimized: false, visible: true });
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (let i = 0; i < 3; i++) {
    expect(await within(app.invoke("engine:assets"))).toBe("answered");
    expect(await within(app.electron.evaluate(() => Date.now()))).toBe("answered");
  }
});

test("no key of the Mac's app menu hides the app: ⌘H took the projector away with it", async ({ app }) => {
  test.skip(process.platform !== "darwin", "the app menu is the Mac's; Windows has none");
  const hide = await app.electron.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()
      ?.items[0]
      ?.submenu?.items.find((entry) => entry.label === "Ocultar Himnova Live");
    return item ? { role: item.role ?? null, accelerator: item.accelerator ?? null } : null;
  });
  // The item is still there, without `role: "hide"` and its ⌘H (2026-11-15 audit, A21).
  expect(hide).toEqual({ role: null, accelerator: null });
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
  // The two empty decks say they cannot be opened, in the words main gives. Not «vac»: PREVIEW's header shows the
  // deck's name, «vacio», which matched with nothing said at all (2026-11-15 audit, P5).
  const cannotOpen = "No se pudo abrir el archivo como presentación";
  const decks = app.control.getByRole("tabpanel", { name: "Presentaciones" }).getByRole("button", { name: "vacio" });
  await app.previewFile("Presentaciones", "vacio");
  await expect(app.previewColumn()).toContainText(cannotOpen);
  await decks.nth(1).click();
  await expect(app.previewColumn()).toContainText(cannotOpen);
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

  // The song editor: a song's jump keys, digits, the arrows and a remote's PageDown, typed into a note. The song left
  // PREVIEW when it went out (owner, 2026-11-15): picked again to edit it.
  await songs.getByRole("list", { name: "Canciones" }).getByRole("listitem").first().click();
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

/** The control window's page, read from main: after a crash Playwright's own handle on it is gone. A script sent
 *  while the page is dying never answers, so each try gives up after a second. */
const controlPage = (app: WorshipApp, script: string) =>
  app.electron.evaluate(({ BrowserWindow }, script) => {
    const control = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().endsWith("/index.html"));
    if (!control || control.webContents.isCrashed() || control.webContents.isLoading()) return null;
    return Promise.race([
      control.webContents.executeJavaScript(script) as Promise<unknown>,
      new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);
  }, script);

async function videoLive(app: WorshipApp) {
  await app.addMedia("video", "clip.mp4");
  await app.previewFile("Videos", "clip");
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await videoStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(1);
  return projector;
}

/** The room's video keeps moving, uncovered. */
async function stillPlaying(projector: Awaited<ReturnType<WorshipApp["projector"]>>) {
  const at = (await videoStates(projector))[0]?.currentTime ?? 0;
  await expect.poll(async () => (await videoStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(at + 0.5);
  expect((await videoStates(projector))[0]).toMatchObject({ paused: false, opacity: 1 });
}

test("a control window reloaded mid video leaves the projector playing it, and open, until the operator acts", async ({
  app,
}) => {
  const projector = await videoLive(app);
  await app.control.reload();
  await expect(app.control.getByRole("button", { name: "EN VIVO", exact: true })).toBeVisible();
  await app.control.waitForTimeout(1500); // the reloaded page's startup: settings mirrored, stores loaded
  // Its first, empty output blanked the room, and the header offered to open a projector that was open (A30).
  await stillPlaying(projector);
  await expect(app.liveColumn().getByText("Sin pantalla")).toHaveCount(0);
  // The operator's first action reaches the room.
  await app.control.locator("body").press("b");
  await expect.poll(async () => (await videoStates(projector))[0]?.opacity ?? 0).toBe(0);
});

/** A tone long enough to outlast the test, live: Chromium plays it in the projector's `<audio>`. */
async function toneLive(app: WorshipApp, file: string) {
  execFileSync(ffmpegBinary(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=90", "-ac", "2", file]);
  await app.invoke("library:add", { kind: "audio", paths: [file] });
  await app.previewFile("Audios", "long-tone");
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await audioStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.3);
}

async function reloadControl(app: WorshipApp) {
  await app.control.reload();
  await expect(app.control.getByRole("button", { name: "EN VIVO", exact: true })).toBeVisible();
  await app.control.waitForTimeout(1500); // the reloaded page's startup: settings mirrored, stores loaded
}

test("after a control reload, playing a sound leaves the room's video playing", async ({ app }, testInfo) => {
  await toneLive(app, testInfo.outputPath("long-tone.wav"));
  // A video that outlasts the test (`clip.mp4` lasts 8 s).
  const video = testInfo.outputPath("long-clip.mp4");
  execFileSync(ffmpegBinary(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=60", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
  await app.invoke("library:add", { kind: "video", paths: [video] });
  await app.previewFile("Videos", "long-clip");
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await videoStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(1);
  await reloadControl(app);
  // The sound ended both holds: the window's empty picture cut the video to LOGO (A30 review).
  await app.previewFile("Audios", "long-tone");
  await app.goLive();
  await stillPlaying(projector);
});

test("after a control reload, a verse put up leaves the room's music playing", async ({ app }, testInfo) => {
  await toneLive(app, testInfo.outputPath("long-tone.wav"));
  await reloadControl(app);
  // The verse ended both holds: the window's empty track list replaced main's and the music stopped (A30 review).
  const projector = await verseLive(app);
  const at = (await audioStates(projector))[0]?.currentTime ?? 0;
  await expect.poll(async () => (await audioStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(at + 0.5);
  expect((await audioStates(projector))[0]?.paused).toBe(false);
  // The sound is still held: the LIVE mute reaches nothing in the room, and says so instead of doing it in silence.
  await app.liveColumn().getByRole("button", { name: "Silenciar EN VIVO" }).click();
  await expect(app.control.getByText("El volumen de EN VIVO no llega a lo que ya sonaba", { exact: false })).toBeVisible();
});

test("after a control reload with a video on air, ⌘Q asks first", async ({ app }) => {
  await videoLive(app);
  await reloadControl(app);
  // The reloaded window saw nothing live, and the quit took the room's video down without a word (A30 review).
  await app.quit("cancel");
  await expect(app.control.getByRole("button", { name: "EN VIVO", exact: true })).toBeVisible();
});

test("a control window whose renderer dies is reloaded by itself, and the projector goes on", async ({ app }) => {
  app.crashLogExpected = true;
  const projector = await videoLive(app);
  await app.electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().endsWith("/index.html"))
      ?.webContents.forcefullyCrashRenderer(),
  );
  // Before, the control stayed dead: the app could only be quit, and the projector with it (2026-11-15 audit, A30).
  await expect.poll(() => controlPage(app, 'document.body.innerText.includes("EN VIVO")'), { timeout: 15_000 }).toBe(true);
  await stillPlaying(projector);
  expect(await controlPage(app, 'document.body.innerText.includes("Sin pantalla")')).toBe(false);
});
