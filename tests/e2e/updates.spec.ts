import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Locator } from "@playwright/test";
import type { UpdateStatus } from "../../src/shared/types/updates";
import { expect, test, type WorshipApp } from "./support/app";
import { ROOT } from "./support/paths";

const VERSION = (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;

async function openAbout(app: WorshipApp): Promise<Locator> {
  await app.control.getByRole("button", { name: "Configuración" }).click();
  const dialog = app.control.getByRole("dialog", { name: "Configuración" });
  await dialog.getByRole("tab", { name: "Acerca de" }).click();
  return dialog;
}

const updatesRow = (about: Locator) => about.getByRole("group", { name: /^Actualizaciones/ });

/** The release's installer: downloaded, checked against its sha512 and handed
 *  to `open` — the suite's own, below, which never mounts anything. */
const DMG_NAME = "Lumina-Live-mac-arm64.dmg";
const DMG = Buffer.from("not a disk image, only bytes with a known sha512");
const DMG_SHA512 = createHash("sha512").update(DMG).digest("base64");
/** Where `mac-dmg.ts` keeps a download: the user's cache, not the profile. */
const DMG_PATH = path.join(os.homedir(), "Library", "Caches", "worship-app-updater", DMG_NAME);

/** What a release's `latest*.yml` says. */
const releaseYml = (version: string) =>
  [
    `version: ${version}`,
    "files:",
    `  - url: ${DMG_NAME}`,
    `    sha512: ${DMG_SHA512}`,
    `    size: ${DMG.length}`,
    `path: ${DMG_NAME}`,
    `sha512: ${DMG_SHA512}`,
    "releaseDate: '2026-10-25T00:00:00.000Z'",
  ].join("\n");

const status = (app: WorshipApp) => app.invoke<UpdateStatus>("updates:getStatus");

/** The toasts, and only them: the LIVE monitor's «No hay logo cargado» band is
 *  a `status` too. */
const toasts = (app: WorshipApp) => app.control.locator('body > [aria-live="polite"] > [role="status"]');

function mainLog(app: WorshipApp): string {
  const file = path.join(app.profile, "main.log");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

/** Main's own line when it hands the `.dmg` to `open`, once per install. */
const installerLines = (app: WorshipApp) =>
  mainLog(app)
    .split("\n")
    .filter((line) => line.includes("[updates] opening the installer"));

/** Something on the projector, so that quitting has to ask. */
async function putPhotoLive(app: WorshipApp) {
  await app.addMedia("image", "photo.png");
  await app.previewFile("Imágenes", "photo");
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.locator('img[src^="worship://asset/"]')).toBeVisible();
  return projector;
}

test("a build that cannot update itself says so and offers no check", async ({ app }) => {
  // The packaged app CAN update itself, and would reach GitHub.
  test.skip(!!process.env["WORSHIP_E2E_EXECUTABLE"], "only `out/` is a build without updates");
  const about = await openAbout(app);
  const row = updatesRow(about);
  await expect(row).toContainText("Esta instalación no se actualiza desde la app");
  await expect(row.getByRole("button", { name: "Buscar actualizaciones" })).toBeDisabled();
  // Nor does it offer to look on its own.
  await expect(about.getByRole("group", { name: "Buscar al abrir la app" })).toHaveCount(0);
});

test.describe("against a release server", () => {
  /** The `latest*.yml` the server answers with; `null` answers 404, like a
   *  release published before the app could update itself. */
  let yml: string | null = null;
  const server = http.createServer((req, res) => {
    // The updater appends `?noCache=…`.
    const file = new URL(req.url ?? "/", "http://localhost").pathname;
    if (yml !== null && file.endsWith(".yml")) {
      res.writeHead(200, { "content-type": "text/yaml" });
      res.end(yml);
    } else if (file === `/${DMG_NAME}`) {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": DMG.length });
      res.end(DMG);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  /** macOS's `open`, replaced first on the app's PATH by a script that only
   *  writes down what it was asked to open: the real one would mount the
   *  fake `.dmg` — or fail to, in a Finder dialog. */
  let bin = "";
  const pathBefore = process.env["PATH"];
  const openedFiles = () => {
    const file = path.join(bin, "opened.txt");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  };

  test.beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env["WORSHIP_UPDATE_FEED_URL"] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    bin = fs.mkdtempSync(path.join(os.tmpdir(), "worship-e2e-bin-"));
    fs.writeFileSync(path.join(bin, "open"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${path.join(bin, "opened.txt")}"\n`, {
      mode: 0o755,
    });
    process.env["PATH"] = `${bin}${path.delimiter}${pathBefore}`;
  });
  test.beforeEach(() => fs.rmSync(path.join(bin, "opened.txt"), { force: true }));
  test.afterAll(async () => {
    // One worker runs every spec: nothing after this file may see the feed,
    // or the fake `open`.
    delete process.env["WORSHIP_UPDATE_FEED_URL"];
    process.env["PATH"] = pathBefore;
    fs.rmSync(bin, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(DMG_PATH, { force: true });
  });

  /** «Buscar actualizaciones» and «Descargar» in About, on the feed's 99.0.0. */
  async function download(app: WorshipApp): Promise<Locator> {
    yml = releaseYml("99.0.0");
    const row = updatesRow(await openAbout(app));
    await row.getByRole("button", { name: "Buscar actualizaciones" }).click();
    await row.getByRole("button", { name: "Descargar" }).click();
    return row;
  }

  test("«Buscar actualizaciones» shows a newer version right there, with its release notes", async ({ app }) => {
    yml = releaseYml("99.0.0");
    const row = updatesRow(await openAbout(app));
    await expect(row.getByRole("button", { name: "Novedades" })).toHaveCount(0);

    await row.getByRole("button", { name: "Buscar actualizaciones" }).click();
    await expect(row).toContainText("Lumina Live 99.0.0 está disponible.");
    await expect(row.getByText("Nueva versión", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Novedades" })).toBeVisible();
  });

  test("the same version as this one is «the latest»", async ({ app }) => {
    yml = releaseYml(VERSION);
    const row = updatesRow(await openAbout(app));
    await row.getByRole("button", { name: "Buscar actualizaciones" }).click();
    await expect(row).toContainText(/Tenés la última versión \(buscada a las \d{2}:\d{2}\)\./);
    await expect(row.getByRole("button", { name: "Novedades" })).toHaveCount(0);
  });

  test("a release without update files says where the new version is", async ({ app }) => {
    yml = null;
    const row = updatesRow(await openAbout(app));
    await row.getByRole("button", { name: "Buscar actualizaciones" }).click();
    await expect(row).toContainText("La versión publicada todavía no se puede bajar desde la app");
    // It can be asked again.
    await expect(row.getByRole("button", { name: "Buscar actualizaciones" })).toBeEnabled();
  });

  test("a version found away from About is announced once, and «Ver» opens About on it", async ({ app }) => {
    yml = releaseYml("99.0.0");
    const { control } = app;
    const toastText = toasts(app).filter({ hasText: "Lumina Live 99.0.0 está disponible." });
    // In place of the launch check, which the suite turns off.
    await app.invoke("updates:check");
    await expect(toastText).toBeVisible();

    await toastText.getByRole("button", { name: "Ver", exact: true }).click();
    const dialog = control.getByRole("dialog", { name: "Configuración" });
    await expect(dialog.getByRole("tab", { name: "Acerca de" })).toHaveAttribute("aria-selected", "true");
    await expect(updatesRow(dialog)).toContainText("Lumina Live 99.0.0 está disponible.");
    await expect(toastText).toHaveCount(0);
    await control.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // The same version again: no second toast. A check sets `checking` before
    // `updates:check` answers, and events and replies share one ordered pipe,
    // so once the status reads `available` again the renderer has already
    // handled it.
    await app.invoke("updates:check");
    await expect.poll(async () => (await status(app)).kind).toBe("available");
    await expect(toastText).toHaveCount(0);
  });

  test("installing with something live: «Cancelar» opens nothing, OK opens it once and asks no more", async ({ app }) => {
    test.skip(process.platform !== "darwin", "the feed serves a macOS release");
    const { control } = app;
    const projector = await putPhotoLive(app);

    const row = await download(app);
    await expect(row).toContainText("Lumina Live 99.0.0 está lista. Al abrir el instalador, la app se cierra");

    // The close's own question, before main starts anything: once the
    // installer runs there is no «Cancelar» left.
    await row.getByRole("button", { name: "Abrir instalador" }).click();
    const confirm = control.getByRole("dialog", { name: "¿Cerrar la app para actualizar?" });
    await expect(confirm).toContainText("Hay contenido en el proyector.");
    await confirm.getByRole("button", { name: "Cancelar" }).click();
    await expect(confirm).toBeHidden();

    await control.waitForTimeout(500);
    expect(app.hasProjector()).toBe(true);
    await expect(projector.locator('img[src^="worship://asset/"]')).toBeVisible();
    expect((await status(app)).kind).toBe("downloaded");
    expect(installerLines(app)).toEqual([]);
    expect(openedFiles()).toEqual([]);

    // Armed for the way out too, then installed now: the `.dmg` still opens
    // once, and the quit it starts goes through without the close guard
    // asking again — it would wait for an answer, and the app never exit.
    await row.getByRole("button", { name: "Al cerrar la app" }).click();
    await row.getByRole("button", { name: "Abrir instalador" }).click();
    await confirm.getByRole("button", { name: "Abrir instalador" }).click();
    await app.exited;
    expect(installerLines(app)).toHaveLength(1);
    await expect.poll(openedFiles).toEqual([DMG_PATH]);
  });

  test("«Al cerrar la app» opens the installer on the way out — not on a quit the operator cancels", async ({ app }) => {
    test.skip(process.platform !== "darwin", "the feed serves a macOS release");
    await putPhotoLive(app);
    const row = await download(app);
    await row.getByRole("button", { name: "Al cerrar la app" }).click();
    await expect(row).toContainText("El instalador de Lumina Live 99.0.0 se abre al cerrar la app");
    await expect(row.getByRole("button", { name: "Al cerrar la app" })).toHaveCount(0);

    await app.quit("cancel");
    await app.control.waitForTimeout(500);
    expect(app.hasProjector()).toBe(true);
    expect(installerLines(app)).toEqual([]);

    await app.quit("close");
    expect(installerLines(app)).toHaveLength(1);
    await expect.poll(openedFiles).toEqual([DMG_PATH]);
  });
});

test.describe("the launch check, with nothing answering", () => {
  test.use({ launchCheck: true });

  test.beforeAll(async () => {
    // A port that was free a moment ago: the connection is refused.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise((resolve) => probe.close(resolve));
    process.env["WORSHIP_UPDATE_FEED_URL"] = `http://127.0.0.1:${port}/`;
  });
  test.afterAll(() => {
    delete process.env["WORSHIP_UPDATE_FEED_URL"];
  });

  test("fails in silence: nothing on screen, the error in main.log", async ({ app }) => {
    // Ten seconds after the window (`LAUNCH_CHECK_DELAY_MS`).
    await expect.poll(() => mainLog(app), { timeout: 30_000 }).toMatch(/\[error\] Error: .*ERR_CONNECTION_REFUSED/);
    expect((await status(app)).kind).toBe("idle");
    // A church without internet opens the app every week.
    await expect(toasts(app)).toHaveCount(0);
    const row = updatesRow(await openAbout(app));
    await expect(row).toContainText("Compara esta versión con la última publicada en GitHub.");
  });
});
