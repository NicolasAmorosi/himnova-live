import { expect, relaunch, test, type WorshipApp } from "./support/app";

/**
 * Where the projector's window goes (2026-11-10 review, agents 4 and 5). The operator's own screen — the one
 * hosting the control window — chosen as the projector's gives a window they can move, never a fullscreen,
 * always-on-top one over the control window (owner, 2026-11-10); a projector that blinks with three screens
 * goes back to its own screen and is only said to be back when it is.
 */

const JUAN_3_16 = "Porque de tal manera amó Dios al mundo";

type WinState = {
  bounds: { x: number; y: number; width: number; height: number };
  content: { x: number; y: number; width: number; height: number };
  fullScreen: boolean;
  onTop: boolean;
  visible: boolean;
};

function projectorWindow(app: WorshipApp): Promise<WinState | null> {
  return app.electron.evaluate(({ BrowserWindow }) => {
    // The newest: a replaced one may still be leaving (macOS animates a fullscreen window's close).
    const w = BrowserWindow.getAllWindows()
      .filter((win) => !win.isDestroyed() && win.webContents.getURL().endsWith("/projection.html"))
      .sort((a, b) => b.id - a.id)[0];
    return w
      ? { bounds: w.getBounds(), content: w.getContentBounds(), fullScreen: w.isFullScreen(), onTop: w.isAlwaysOnTop(), visible: w.isVisible() }
      : null;
  });
}

/** The work area of the screen hosting the control window. */
function controlScreen(app: WorshipApp) {
  return app.electron.evaluate(({ BrowserWindow, screen }) => {
    const control = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().endsWith("/index.html"))!;
    return screen.getDisplayMatching(control.getBounds()).workArea;
  });
}

/** A window the operator can move, centred on their own screen: not fullscreen, not on top, with a frame. */
async function expectMovableOnControlScreen(app: WorshipApp) {
  // Polled: the window it replaces (fullscreen, on top) is still there for a moment.
  await expect
    .poll(async () => {
      const state = await projectorWindow(app);
      return state && { visible: state.visible, fullScreen: state.fullScreen, onTop: state.onTop };
    })
    .toEqual({ visible: true, fullScreen: false, onTop: false });
  const win = (await projectorWindow(app))!;
  const area = await controlScreen(app);
  // A title bar: the content is shorter than the window.
  expect(win.content.height).toBeLessThan(win.bounds.height);
  const centre = { x: win.bounds.x + win.bounds.width / 2, y: win.bounds.y + win.bounds.height / 2 };
  expect(Math.abs(centre.x - (area.x + area.width / 2))).toBeLessThan(40);
  expect(Math.abs(centre.y - (area.y + area.height / 2))).toBeLessThan(40);
}

async function verseLive(app: WorshipApp) {
  await app.openChapter("Juan 3");
  await app.control.getByRole("listitem").filter({ hasText: JUAN_3_16 }).click();
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toBeVisible();
  return projector;
}

test("one screen: the projector is a window the operator can move, centred on their screen", async ({ app }) => {
  // Main sees only the screen the control window is on (A14: a frameless 800×600 in its corner, behind it).
  await app.electron.evaluate(({ BrowserWindow, screen }) => {
    const control = BrowserWindow.getAllWindows()[0]!;
    const own = screen.getDisplayMatching(control.getBounds());
    screen.getAllDisplays = () => [own];
  });
  await app.control.locator("body").press("l");
  await app.projector();
  await expectMovableOnControlScreen(app);
});

test("Settings: the control screen chosen as the projector's gives a movable window, not one over the control window", async ({ app }) => {
  test.skip((await app.invoke<unknown[]>("displays:list")).length < 2, "needs two screens");
  await verseLive(app);
  await app.control.getByRole("button", { name: "Configuración" }).click();
  const settings = app.control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Proyección" }).click();
  await settings.getByRole("combobox", { name: "Pantalla de proyección" }).click();
  await app.control.getByRole("option").filter({ hasText: "(pantalla del control)" }).first().click();
  await expectMovableOnControlScreen(app);
});

test.describe("the welcome's map of screens", () => {
  test.use({ welcome: true, starterLook: true });

  test("the projector's screen tapped shows the church's LOGO on it", async ({ app }) => {
    test.skip((await app.invoke<unknown[]>("displays:list")).length < 2, "the map only shows with two screens");
    const welcome = app.control.getByRole("dialog", { name: "Bienvenida" });
    await welcome.getByRole("tab", { name: "Tu iglesia" }).click();
    await welcome.getByRole("button", { name: "Nombre sobre fondo" }).click();
    const name = welcome.getByRole("textbox", { name: "Nombre de la iglesia" });
    await name.fill("Iglesia de prueba");
    await name.press("Enter");
    await welcome.getByRole("tab", { name: "Pantallas" }).click();
    await welcome.getByRole("button", { name: /^Proyectar en / }).filter({ hasNotText: "Control" }).first().click();
    const projector = await app.projector();
    // A black wall reads as a projector that is off: the step is for telling the walls apart.
    await expect(projector.locator("body")).toContainText("Iglesia de prueba");
  });

  test("the control screen tapped gives a movable window, and the next launch keeps it so", async ({ app }) => {
    test.skip((await app.invoke<unknown[]>("displays:list")).length < 2, "the map only shows with two screens");
    const welcome = app.control.getByRole("dialog", { name: "Bienvenida" });
    await welcome.getByRole("tab", { name: "Pantallas" }).click();
    await welcome.getByRole("button", { name: /^Proyectar en / }).filter({ hasText: "Control" }).click();
    await app.projector();
    await expectMovableOnControlScreen(app);

    await app.kill();
    const again = await relaunch(app);
    const welcomeAgain = again.control.getByRole("dialog", { name: "Bienvenida" });
    if (await welcomeAgain.isVisible().catch(() => false)) {
      await welcomeAgain.getByRole("button", { name: "Saltar la bienvenida" }).click();
    }
    await expect(again.control.getByRole("button", { name: "EN VIVO", exact: true })).toBeVisible();
    await again.control.locator("body").press("l");
    await again.projector();
    await expectMovableOnControlScreen(again);
  });
});

test("three screens: the projector's screen blinks off and on, the window goes back to it, said only once it is back", async ({ app }) => {
  test.skip((await app.invoke<unknown[]>("displays:list")).length < 2, "needs two screens");
  // A laptop, the projector the operator chose and a third screen (a stage, a confidence monitor): main
  // sees three; the third is a stand-in made from the projector's own Display.
  await app.electron.evaluate(({ BrowserWindow, screen }) => {
    const g = globalThis as unknown as { qa: { list: Electron.Display[] } };
    const real = screen.getAllDisplays();
    const control = screen.getDisplayMatching(BrowserWindow.getAllWindows()[0]!.getBounds());
    const projector = real.find((d) => d.id !== control.id)!;
    const third = { ...projector, id: 999, label: "Escenario", bounds: { x: -1280, y: 0, width: 1280, height: 720 }, workArea: { x: -1280, y: 0, width: 1280, height: 720 } };
    g.qa = { list: [control, projector, third] };
    (screen as unknown as { getAllDisplays: () => Electron.Display[] }).getAllDisplays = () => g.qa.list;
    screen.emit("display-added", {}, third);
  });
  const projectorId = await app.electron.evaluate(({ BrowserWindow, screen }) => {
    const control = screen.getDisplayMatching(BrowserWindow.getAllWindows()[0]!.getBounds());
    return screen.getAllDisplays().find((d) => d.id !== control.id && d.id !== 999)!.id;
  });
  await app.invoke("settings:set", { "projection.displayId": projectorId });
  await app.control.reload();
  await verseLive(app);
  const onProjector = (await projectorWindow(app))!.bounds;

  await app.electron.evaluate(({ screen }, id) => {
    const g = globalThis as unknown as { qa: { list: Electron.Display[] }; qaGone: Electron.Display };
    g.qaGone = g.qa.list.find((d) => d.id === id)!;
    g.qa.list = g.qa.list.filter((d) => d.id !== id);
    screen.emit("display-removed", {}, g.qaGone);
  }, projectorId);
  await expect.poll(async () => (await projectorWindow(app))?.visible).toBe(false);
  await app.control.waitForTimeout(1000);
  expect((await app.control.getByRole("status").allInnerTexts()).join(" ")).not.toContain("Volvió la pantalla del proyector");

  await app.electron.evaluate(({ screen }) => {
    const g = globalThis as unknown as { qa: { list: Electron.Display[] }; qaGone: Electron.Display };
    g.qa.list = [...g.qa.list, g.qaGone];
    screen.emit("display-added", {}, g.qaGone);
  });
  await expect.poll(async () => (await projectorWindow(app))?.visible).toBe(true);
  await expect(app.control.getByRole("status").filter({ hasText: "Volvió la pantalla del proyector" })).toBeVisible();
  const back = (await projectorWindow(app))!.bounds;
  expect({ x: back.x, y: back.y }).toEqual({ x: onProjector.x, y: onProjector.y });
});
