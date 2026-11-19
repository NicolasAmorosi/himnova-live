import type { Locator } from "@playwright/test";
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
  menu: boolean;
};

function projectorWindow(app: WorshipApp): Promise<WinState | null> {
  return app.electron.evaluate(({ BrowserWindow }) => {
    // The newest: a replaced one may still be leaving (macOS animates a fullscreen window's close).
    const w = BrowserWindow.getAllWindows()
      .filter((win) => !win.isDestroyed() && win.webContents.getURL().endsWith("/projection.html"))
      .sort((a, b) => b.id - a.id)[0];
    return w
      ? {
          bounds: w.getBounds(),
          content: w.getContentBounds(),
          fullScreen: w.isFullScreen(),
          onTop: w.isAlwaysOnTop(),
          visible: w.isVisible(),
          menu: w.isMenuBarVisible(),
        }
      : null;
  });
}

/** The work area of the screen hosting the control window. */
function controlScreen(app: WorshipApp) {
  return app.electron.evaluate(({ BrowserWindow, screen }) => {
    const control = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && win.webContents.getURL().endsWith("/index.html"))!;
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
  // Linux gave it the app's menu, 29 px over the picture (2026-11-18); macOS's menu is the screen's, Windows has none.
  if (process.platform === "linux") expect((await projectorWindow(app))!.menu).toBe(false);
  const area = await controlScreen(app);
  // Settled bounds: on GNOME (X11) they read the requested place, then 0,0, then the final one within ~30 ms of
  // showing (CachyOS, 2026-11-18), so two reads 100 ms apart must agree.
  await expect(async () => {
    const first = (await projectorWindow(app))!;
    await app.control.waitForTimeout(100);
    const win = (await projectorWindow(app))!;
    expect(win.bounds).toEqual(first.bounds);
    // A title bar: the content is shorter than the window. Not on GNOME, which draws it outside the bounds: the 29 px
    // read there were the app's menu, gone since 2026-11-19.
    if (process.platform !== "linux") expect(win.content.height).toBeLessThan(win.bounds.height);
    const centre = { x: win.bounds.x + win.bounds.width / 2, y: win.bounds.y + win.bounds.height / 2 };
    expect(Math.abs(centre.x - (area.x + area.width / 2))).toBeLessThan(40);
    // GNOME puts its own title bar (32 px) where the window was asked to go and the bounds start below it: 46.5 px
    // low at scale 2.0. The corner this guards against (A14) is 164 px off in y, 320 in x.
    expect(Math.abs(centre.y - (area.y + area.height / 2))).toBeLessThan(64);
  }).toPass();
}

/** Settings ▸ Screens: the row of the screen that hosts the control window. */
const ownScreenRow = (settings: Locator) => settings.getByRole("group").filter({ hasText: "Esta pantalla tiene la ventana de control" });
/** The row of the screen the projector took, by its number, read once: the rows follow the OS's order, and Windows
 *  changed it on a restart (2026-11-19: the operator's screen listed third, the projector's first). */
async function projectorScreenRow(settings: Locator): Promise<{ row: Locator; number: string }> {
  const rows = settings.getByRole("group").filter({ hasText: /^\d+ · / });
  const projector = rows.filter({ has: settings.page().getByRole("combobox").filter({ hasText: /^Proyector$/ }) });
  await expect(projector).toHaveCount(1);
  const number = /^(\d+) · /.exec(await projector.innerText())?.[1] ?? "?";
  return { row: rows.filter({ hasText: new RegExp(`^${number} · `) }), number };
}

async function screensSettings(app: WorshipApp): Promise<Locator> {
  await app.control.getByRole("button", { name: "Configuración" }).click();
  const settings = app.control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Pantallas" }).click();
  return settings;
}

async function pickRole(app: WorshipApp, row: Locator, role: "Proyector" | "Escenario" | "Copia del proyector" | "Sin uso"): Promise<void> {
  await row.getByRole("combobox").click();
  await app.control.getByRole("option", { name: role, exact: true }).click();
}

const stageOpen = (app: WorshipApp) =>
  app.electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.webContents.getURL().endsWith("/stage.html")),
  );

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
  await settings.getByRole("tab", { name: "Pantallas" }).click();
  await ownScreenRow(settings).getByRole("combobox").click();
  await app.control.getByRole("option", { name: "Proyector", exact: true }).click();
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

    // A movable window no longer stands between the operator and the app: quit it as they would.
    await app.quit();
    const again = await relaunch(app);
    // Never closed, the welcome opens again (`welcome.pending`) once the settings load, after EN VIVO shows:
    // looked for with `isVisible()`, a slow launch found nothing, and the welcome then swallowed the «l» below.
    await again.control.getByRole("dialog", { name: "Bienvenida" }).getByRole("button", { name: "Saltar la bienvenida" }).click();
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

test("the roles exclude each other: the stage given the projector's screen moves the projector, and back, each said", async ({
  app,
}) => {
  test.skip((await app.invoke<unknown[]>("displays:list")).length < 2, "needs two screens");
  const settings = await screensSettings(app);
  const { row: other, number } = await projectorScreenRow(settings);
  await expect(other).not.toContainText("Esta pantalla tiene la ventana de control");

  await pickRole(app, other, "Escenario");
  await expect(app.control.getByRole("status").filter({ hasText: /^El proyector pasó a / })).toBeVisible();
  await expect(other.getByRole("combobox")).toHaveText(/Escenario/);
  // Onto another screen: a third if there is one, else the operator's own (as a window). One projector, always.
  await expect(settings.getByRole("combobox").filter({ hasText: /^Proyector$/ })).toHaveCount(1);
  await expect.poll(() => stageOpen(app)).toBe(true);
  await expect(settings.getByRole("list", { name: "Ahora" })).toContainText(`Escenario visible en ${number}`);

  await pickRole(app, other, "Proyector");
  await expect(app.control.getByRole("status").filter({ hasText: "pasó a ser el proyector: el escenario quedó sin pantalla" })).toBeVisible();
  await expect.poll(() => stageOpen(app)).toBe(false);
  expect((await app.invoke<Record<string, unknown>>("settings:get"))["stage.displayId"]).toBeNull();
});

test("a stage role chosen again, «Escenario» or «Copia del proyector», opens the stage window the operator closed", async ({ app }) => {
  const settings = await screensSettings(app);
  const own = ownScreenRow(settings);
  await pickRole(app, own, "Escenario");
  await expect.poll(() => stageOpen(app)).toBe(true);
  const closeStage = () =>
    app.electron.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().endsWith("/stage.html"))?.close(),
    );

  // The same role for the same screen.
  await closeStage();
  await expect.poll(() => stageOpen(app)).toBe(false);
  await pickRole(app, own, "Escenario");
  await expect.poll(() => stageOpen(app)).toBe(true);

  // The other stage role for it.
  await closeStage();
  await expect.poll(() => stageOpen(app)).toBe(false);
  await pickRole(app, own, "Copia del proyector");
  await expect.poll(() => stageOpen(app)).toBe(true);
});

test("a projector never chosen opens beside the stage, never on its screen", async ({ app }) => {
  test.skip((await app.invoke<unknown[]>("displays:list")).length < 2, "needs two screens");
  // The second screen is the stage's and the projector was never chosen: before, GO LIVE opened the projector on
  // «the first screen that is not the operator's» — the stage's — and the stage went off.
  const otherId = await app.electron.evaluate(({ BrowserWindow, screen }) => {
    const control = screen.getDisplayMatching(BrowserWindow.getAllWindows()[0]!.getBounds());
    return screen.getAllDisplays().find((d) => d.id !== control.id)!.id;
  });
  await app.invoke("settings:set", { "projection.displayId": null, "stage.displayId": otherId });
  await app.control.reload();
  await expect.poll(() => stageOpen(app)).toBe(true);
  await verseLive(app);
  const screens = (await app.invoke<unknown[]>("displays:list")).length;
  if (screens === 2) {
    // Nowhere else: a movable window on the operator's own screen.
    await expectMovableOnControlScreen(app);
  } else {
    // A third screen: fullscreen there, and not the stage's.
    const on = await app.electron.evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && win.webContents.getURL().endsWith("/projection.html"))!;
      return screen.getDisplayMatching(w.getBounds()).id;
    });
    expect(on).not.toBe(otherId);
  }
  expect(await stageOpen(app)).toBe(true);
});

test("the control window dragged onto the stage's screen makes the stage a movable window there, and back", async ({ app }) => {
  test.skip((await app.invoke<unknown[]>("displays:list")).length < 2, "needs two screens");
  const ids = await app.electron.evaluate(({ BrowserWindow, screen }) => {
    const control = screen.getDisplayMatching(BrowserWindow.getAllWindows()[0]!.getBounds());
    return { control: control.id, other: screen.getAllDisplays().find((d) => d.id !== control.id)!.id };
  });
  await app.invoke("settings:set", { "projection.displayId": null, "stage.displayId": ids.other });
  await app.control.reload();
  const stage = () =>
    app.electron.evaluate(({ BrowserWindow }) => {
      // A stage being replaced can still be listed with its page already gone: «Object has been destroyed» on Windows.
      const w = BrowserWindow.getAllWindows().find(
        (win) => !win.isDestroyed() && !win.webContents.isDestroyed() && win.webContents.getURL().endsWith("/stage.html"),
      );
      return w ? { full: w.isFullScreen(), onTop: w.isAlwaysOnTop() } : null;
    });
  const moveControlTo = (displayId: number) =>
    app.electron.evaluate(({ BrowserWindow, screen }, id) => {
      const area = screen.getAllDisplays().find((d) => d.id === id)!.workArea;
      // A stage window being replaced (fullscreen → framed) is destroyed mid-search: «Object has been destroyed» on
      // Windows (2026-11-16 run) and in the Mac's long runs.
      const control = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().endsWith("/index.html"))!;
      control.setBounds({ x: area.x + 40, y: area.y + 40, width: 1000, height: 700 });
      // What the OS sends when a drag ends: a programmatic move sends nothing on macOS.
      control.emit("moved");
    }, displayId);
  await expect.poll(stage).toMatchObject({ onTop: true });
  // Over the operator's own window it would cover it: a framed window there instead (2026-11-14 review).
  await moveControlTo(ids.other);
  await expect.poll(stage, { timeout: 10_000 }).toEqual({ full: false, onTop: false });
  await moveControlTo(ids.control);
  await expect.poll(stage, { timeout: 10_000 }).toMatchObject({ onTop: true });
});

// Windows can give every screen a new id on a restart (the owner's PC, 2026-11-18): with three screens the stage stayed
// off and the projector took the first free screen. A role saved under an id that is gone finds its screen again.
test("a role's screen back under a new id is found again by its name and place", async ({ app }) => {
  const own = await app.electron.evaluate(({ BrowserWindow, screen }) => {
    const control = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().endsWith("/index.html"))!;
    const d = screen.getDisplayMatching(control.getBounds());
    return { id: d.id, print: { label: d.label.trim(), x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height } };
  });
  test.skip(own.print.label === "", "a screen with no name is never recognized");
  // The stage's screen as an earlier launch saved it: this screen's name and place, under an id this launch never saw.
  await app.invoke("settings:set", { "stage.displayId": 4242, "stage.displayPrint": own.print });
  expect((await app.invoke<Record<string, unknown>>("settings:get"))["stage.displayId"]).toBe(own.id);
  await expect
    .poll(() =>
      app.electron.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible() && w.webContents.getURL().endsWith("/stage.html")),
      ),
    )
    .toBe(true);
});

test("«Identificar» puts each screen's number on it for a few seconds, the map's numbers", async ({ app }) => {
  const count = (await app.invoke<unknown[]>("displays:list")).length;
  const settings = await screensSettings(app);
  await settings.getByRole("button", { name: "Identificar" }).click();
  const shown = () =>
    app.electron.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((w) => !w.isDestroyed() && w.webContents.getURL().startsWith("data:text/html"))
        .map((w) => decodeURIComponent(w.webContents.getURL()).match(/line-height:1">(\d+)</)?.[1]),
    );
  await expect.poll(shown).toHaveLength(count);
  expect((await shown()).sort()).toEqual(Array.from({ length: count }, (_, i) => String(i + 1)));
  await expect.poll(shown, { timeout: 6_000 }).toHaveLength(0);
});

test("minimizing the control window leaves the projector on its screen (owner, 2026-11-13)", async ({ app }) => {
  test.skip((await app.invoke<unknown[]>("displays:list")).length < 2, "needs two screens: on one, the projector is the operator's window");
  await verseLive(app);
  await app.electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().endsWith("/index.html"))!.minimize(),
  );
  await expect
    .poll(() => app.electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().endsWith("/index.html"))!.isMinimized()))
    .toBe(true);
  await app.control.waitForTimeout(500);
  const projector = await app.electron.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && win.webContents.getURL().endsWith("/projection.html"))!;
    return { minimized: w.isMinimized(), visible: w.isVisible() };
  });
  expect(projector).toEqual({ minimized: false, visible: true });
  await app.electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().endsWith("/index.html"))!.restore(),
  );
});

test.describe("the projector opens by itself (owner, 2026-11-13)", () => {
  // With the starter look, as a church starts: the LOGO scene has its background (a bare profile's is black).
  test.use({ chromiumArgs: ["--auto-projector"], starterLook: true });

  test("at launch, on its screen and on the LOGO, and again on the next launch", async ({ app }) => {
    test.skip((await app.invoke<unknown[]>("displays:list")).length < 2, "with one screen it waits for the projector");
    const projector = await app.projector();
    await expect.poll(async () => (await projectorWindow(app))?.fullScreen).toBe(true);
    // Nothing is live: the projector shows what nothing live shows, the LOGO scene, never a black that looks off.
    await expect(app.control.getByRole("button", { name: "VIVO", exact: true })).toBeDisabled();
    await expect
      .poll(() =>
        projector.evaluate(
          () =>
            document.querySelectorAll("img").length +
            [...document.querySelectorAll("*")].filter((e) => getComputedStyle(e).backgroundImage !== "none").length,
        ),
      )
      .toBeGreaterThan(0);
    await app.quit();
    const again = await relaunch(app);
    await again.projector();
    await expect.poll(async () => (await projectorWindow(again))?.visible).toBe(true);
  });

  test("closed by the operator, a screen coming or going does not open it again", async ({ app }) => {
    test.skip((await app.invoke<unknown[]>("displays:list")).length < 2, "needs two screens");
    await app.projector();
    const settings = await screensSettings(app);
    await settings.getByRole("button", { name: "Cerrar pantalla" }).click();
    await expect.poll(() => app.hasProjector()).toBe(false);
    // A screen change: the control window lists the screens again (`displays-changed`).
    await app.electron.evaluate(({ BrowserWindow }) => {
      const control = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().endsWith("/index.html"))!;
      control.webContents.send("displays-changed");
    });
    await app.control.waitForTimeout(1500);
    expect(app.hasProjector()).toBe(false);
  });
});

// Settings left with Esc unmounts the phrases' field with no blur: they were lost, and two equal lines were two buttons
// that went on air together (2026-11-15 audit, D7).
test("the stage's ready phrases are kept when Settings is left with Esc, without repeats", async ({ app }) => {
  await app.control.getByRole("button", { name: "Configuración" }).click();
  const settings = app.control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Pantallas" }).click();
  await settings.getByRole("textbox", { name: "Frases listas" }).fill("Uno\nDos\nUno");
  await app.control.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect
    .poll(async () => (await app.invoke<Record<string, unknown>>("settings:get"))["stage.phrases"])
    .toEqual(["Uno", "Dos"]);
});
