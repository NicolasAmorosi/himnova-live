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
  const search = app.control.getByRole("textbox", { name: "Buscar libro y capítulo…" });
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
