import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { parseLyrics } from "../../src/shared/song-text";
import { DEFAULT_SONG_THEME } from "../../src/shared/types/song";
import { audioStates, engineCanvas, expect, moving, relaunch, test, videoStates, type WorshipApp } from "./support/app";
import { ffmpegBinary } from "./support/paths";

/**
 * A control window whose page dies (a renderer crash) or reloads comes back knowing what is live, from the copy main
 * keeps for it, and sends the room nothing new (2026-11-15 audit, A30). Before, a dead page stayed dead, and a
 * reloaded one started blind: its first push blanked the projector, and its first actions reached the room (CLEAR left
 * the music playing, NEGRO taken off put LOGO over the video, a new sound cut the one playing).
 */

type Bridge = {
  worship: {
    on: (channel: string, callback: (payload: unknown) => void) => () => void;
    invoke: (channel: string, req: unknown) => Promise<{ ok: boolean; data?: unknown }>;
  };
};

/** Everything main sends `page` from now on, on `channels`. */
async function recordPushes(page: Page, channels: readonly string[]): Promise<void> {
  await page.evaluate((names) => {
    const w = window as unknown as Bridge & { pushes: { channel: string; payload: unknown }[] };
    w.pushes = [];
    for (const channel of names) w.worship.on(channel, (payload) => w.pushes.push({ channel, payload }));
  }, channels);
}

const pushes = (page: Page) =>
  page.evaluate(() => (window as unknown as { pushes: { channel: string; payload: unknown }[] }).pushes);

/** What main last sent the projector: the output and the sound it replays into a new projector window. */
async function projectorSnapshot(projector: Page): Promise<{ output: unknown; audioTracks: unknown }> {
  const answer = await projector.evaluate(() => (window as unknown as Bridge).worship.invoke("projection:getSnapshot", undefined));
  const { output, audioTracks } = answer.data as { output: unknown; audioTracks: unknown };
  return { output, audioTracks };
}

/** The control window reloaded the way a crash reloads it, and its startup over: the stores loaded, the effects on. */
async function reloadControl(app: WorshipApp): Promise<void> {
  await app.control.reload();
  await expect(app.control.getByRole("button", { name: "EN VIVO", exact: true })).toBeVisible();
  await app.control.waitForTimeout(2000);
}

const RECOVERED = "La ventana de control se cerró por un error y se recuperó";

/** The room got nothing new from the reload: every output and sound pushed since equals what it already had. */
async function roomUntouched(projector: Page, before: { output: unknown; audioTracks: unknown }): Promise<void> {
  for (const { channel, payload } of await pushes(projector)) {
    expect(payload, `a ${channel} push after the reload`).toEqual(channel === "display-content" ? before.output : before.audioTracks);
  }
  expect(await projectorSnapshot(projector)).toEqual(before);
}

/** A video and a tone that outlast the test (`clip.mp4` lasts 8 s), made here. */
function longMedia(app: WorshipApp, dir: (name: string) => string) {
  const ffmpeg = (...args: string[]) => execFileSync(ffmpegBinary(), ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  const video = dir("long-clip.mp4");
  ffmpeg("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=90", "-c:v", "libx264", "-pix_fmt", "yuv420p", video);
  const tone = dir("long-tone.wav");
  ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:duration=90", "-ac", "2", tone);
  const second = dir("second-tone.wav");
  ffmpeg("-f", "lavfi", "-i", "sine=frequency=660:duration=90", "-ac", "2", second);
  return Promise.all([
    app.invoke("library:add", { kind: "video", paths: [video] }),
    app.invoke("library:add", { kind: "audio", paths: [tone, second] }),
  ]);
}

/** The long video, the long tone and a plate over them, on air. */
async function videoMusicAndPlate(app: WorshipApp, dir: (name: string) => string): Promise<Page> {
  await longMedia(app, dir);
  await app.previewFile("Videos", "long-clip");
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await videoStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(1);
  await app.previewFile("Audios", "long-tone");
  await app.goLive();
  await expect.poll(async () => (await audioStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.3);

  const { control } = app;
  await app.openResources("Funciones", "Placas");
  await control.getByRole("tabpanel", { name: "Placas" }).getByRole("button", { name: "Editar placas", exact: true }).click();
  const editor = control.getByRole("dialog", { name: "Placas" });
  await editor.getByRole("group", { name: "Título", exact: true }).getByRole("textbox").fill("Pr. Juan Pérez");
  await editor.getByRole("button", { name: "Guardar", exact: true }).click();
  await editor.getByRole("button", { name: "Cerrar" }).click();
  await control.getByRole("tabpanel", { name: "Placas" }).getByRole("listitem").filter({ hasText: "Placa nueva" }).click();
  await app.goLive();
  await expect(projector.getByText("Pr. Juan Pérez")).toBeVisible();
  return projector;
}

/** The room's video keeps moving, uncovered. */
async function videoPlays(projector: Page): Promise<void> {
  const at = (await videoStates(projector))[0]?.currentTime ?? 0;
  await expect.poll(async () => (await videoStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(at + 0.5);
  expect((await videoStates(projector))[0]).toMatchObject({ paused: false, opacity: 1 });
}

/** The tone at `index` keeps sounding. */
async function tonePlays(projector: Page, index = 0): Promise<void> {
  const at = (await audioStates(projector))[index]?.currentTime ?? 0;
  await expect.poll(async () => (await audioStates(projector))[index]?.currentTime ?? 0).toBeGreaterThan(at + 0.5);
  expect((await audioStates(projector))[index]?.paused).toBe(false);
}

/** A row of the LIVE column's media panel, by the name it shows: the innermost box holding it, its buttons beside it. */
const liveRow = (app: WorshipApp, name: string) =>
  app.liveColumn().locator("div").filter({ has: app.control.getByText(name, { exact: true }) }).last();

test("a reloaded control window sends the room nothing new, and its LIVE column has the video, the music and the plate", async ({
  app,
}, testInfo) => {
  const projector = await videoMusicAndPlate(app, (name) => testInfo.outputPath(name));
  const before = await projectorSnapshot(projector);
  await recordPushes(projector, ["display-content", "audio-tracks"]);
  await reloadControl(app);
  // Before, its first output blanked the room (luminance 0) and its first sound push silenced it (A30).
  await roomUntouched(projector, before);
  await videoPlays(projector);
  await tonePlays(projector);
  await expect(projector.getByText("Pr. Juan Pérez")).toBeVisible();
  // It knows: the LIVE column lists them, and the header does not offer to open a projector that is open.
  for (const name of ["long-clip", "long-tone", "Placa nueva"]) await expect(liveRow(app, name)).toBeVisible();
  await expect(app.liveColumn().getByText("Sin pantalla")).toHaveCount(0);
  await expect(app.control.getByText(RECOVERED, { exact: false })).toBeVisible();
});

test("after a control reload, NEGRO comes off onto the video, a new sound joins the music, and CLEAR silences it", async ({
  app,
}, testInfo) => {
  const projector = await videoMusicAndPlate(app, (name) => testInfo.outputPath(name));
  await reloadControl(app);
  // NEGRO and back: the video, never the LOGO (the first attempt's window put out its own empty picture).
  await app.control.locator("body").press("b");
  await expect.poll(async () => (await videoStates(projector))[0]?.opacity ?? 1).toBe(0);
  await app.control.locator("body").press("b");
  await videoPlays(projector);
  await expect(projector.getByText("Pr. Juan Pérez")).toBeVisible();
  // A second sound joins the first instead of replacing main's whole list.
  await app.previewFile("Audios", "second-tone");
  await app.goLive();
  await expect.poll(async () => (await audioStates(projector)).length).toBe(2);
  await tonePlays(projector, 0);
  // Stopping the music silences it (an empty list cleared to an empty list released nothing).
  await liveRow(app, "long-tone").getByRole("button", { name: "Detener" }).click();
  await expect.poll(async () => (await audioStates(projector)).length).toBe(1);
  await liveRow(app, "long-clip").getByRole("button", { name: "Sacar del aire" }).click();
  await expect.poll(async () => (await videoStates(projector)).length).toBe(0);
});

test("after a control reload with the video on air, ⌘Q asks first", async ({ app }, testInfo) => {
  await videoMusicAndPlate(app, (name) => testInfo.outputPath(name));
  await reloadControl(app);
  // The reloaded window saw nothing live, and the quit took the room's video down without a word.
  await app.quit("cancel");
  await expect(app.control.getByRole("button", { name: "EN VIVO", exact: true })).toBeVisible();
});

const JUAN_3_16 = "Porque de tal manera amó Dios al mundo";
const JUAN_3_17 = "Porque no envió Dios á su Hijo al mundo";

test("LIVE muted and a verse under NEGRO stay so after a control reload, and → moves the verse on", async ({ app }, testInfo) => {
  await longMedia(app, (name) => testInfo.outputPath(name));
  await app.openChapter("Juan 3");
  await app.control.getByRole("listitem").filter({ hasText: JUAN_3_16 }).click();
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toBeVisible();
  await app.previewFile("Audios", "long-tone");
  await app.goLive();
  await expect.poll(async () => (await audioStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.3);
  await app.liveColumn().getByRole("button", { name: "Silenciar EN VIVO" }).click();
  await expect.poll(async () => (await audioStates(projector))[0]?.volume).toBe(0);
  await app.control.locator("body").press("b");
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toBeHidden();

  const before = await projectorSnapshot(projector);
  await recordPushes(projector, ["display-content", "audio-tracks"]);
  await reloadControl(app);
  // A window that forgot the mute put the music back at its level in the room.
  await roomUntouched(projector, before);
  expect((await audioStates(projector))[0]?.volume).toBe(0);
  await app.control.locator("body").press("b");
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toBeVisible();
  // The verse's cursor came back with it: → is the next verse, not nothing.
  await app.control.locator("body").press("ArrowRight");
  await expect(projector.getByText(JUAN_3_17, { exact: false })).toBeVisible();
});

test("an engine video and a running countdown go on through a control reload", async ({ app }) => {
  await app.addMedia("video", "long-xvid.avi");
  await app.previewFile("Videos", "long-xvid");
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await engineCanvas(projector, "video:"))?.width ?? 0).toBeGreaterThan(0);
  await expect.poll(() => moving(projector, "video:")).toBe(true);
  const before = await projectorSnapshot(projector);
  await recordPushes(projector, ["display-content", "audio-tracks"]);
  await reloadControl(app);
  await roomUntouched(projector, before);
  await expect.poll(() => moving(projector, "video:")).toBe(true);

  await app.openResources("Funciones", "Utilidades");
  await app.control.getByRole("list", { name: "Escenas de tiempo" }).getByRole("listitem").filter({ hasText: "Cuenta 10 minutos" }).click();
  await app.goLive();
  await expect.poll(() => projector.locator("body").innerText()).toMatch(/\d{1,2}:\d{2}/);
  const counting = await projectorSnapshot(projector);
  await recordPushes(projector, ["display-content", "audio-tracks"]);
  await reloadControl(app);
  await roomUntouched(projector, counting);
});

/** The slide the projector shows now: the topmost deck image. */
function projectedSlide(projector: Page): Promise<number | null> {
  return projector.evaluate(() => {
    const last = [...document.querySelectorAll<HTMLElement>('img[src^="worship://deck/"], [data-slide-model^="worship://deck/"]')].at(-1);
    const url = last instanceof HTMLImageElement ? last.src : (last?.dataset["slideModel"] ?? "");
    const match = /\/(\d+)(?:\/model)?$/.exec(url);
    return match ? Number(match[1]) : null;
  });
}

test("a deck's auto-advance goes on after a control reload, with or without its music", async ({ app }) => {
  // `hymn.pptx`: three slides of two seconds and no music (its own clock); `hymn-wma.pptx`: the same over a WMA the
  // engine plays (the slides follow the music's clock).
  for (const name of ["hymn", "hymn-wma"]) {
    await app.addMedia("ppt", `${name}.pptx`);
    await app.previewFile("Presentaciones", name);
    await expect(app.previewColumn().getByText("Estrofa 3").first()).toBeVisible({ timeout: 60_000 });
    await app.goLive();
    const projector = await app.projector();
    await expect.poll(() => projectedSlide(projector)).toBe(1);
    const onAir = ((await projectorSnapshot(projector)).audioTracks as { epoch: number }[]).map((track) => track.epoch);
    await recordPushes(projector, ["audio-tracks"]);
    await reloadControl(app);
    // Before, a reloaded window armed nothing: slide 1 stayed up.
    await expect.poll(() => projectedSlide(projector), { timeout: 8_000 }).toBe(3);
    // The music was never sent again: a new epoch is a restart from 0:00.
    const epochs = (await pushes(projector)).flatMap(({ payload }) => (payload as { epoch: number }[]).map((track) => track.epoch));
    expect(epochs.filter((epoch) => !onAir.includes(epoch))).toEqual([]);
  }
});

test("a song over a video background goes on through a control reload, its video never mounted again", async ({ app: first }) => {
  const [clip] = await first.addMedia("video", "clip.mp4");
  if (!clip) throw new Error("import failed");
  const theme = await first.invoke<{ id: number }>("songTheme:create", {
    name: "Con video",
    style: { ...DEFAULT_SONG_THEME, background: { kind: "video", assetId: clip.id, fit: "cover" } },
  });
  await first.invoke("song:create", {
    title: "Fondo en movimiento",
    number: null,
    authors: null,
    copyright: null,
    ccliNumber: null,
    notes: null,
    sections: parseLyrics("[Estrofa 1]\nPrimera línea\n\nSegunda línea", "es").sections,
    order: [],
    themeId: theme.id,
  });
  await first.quit();
  const app = await relaunch(first);
  await app.openResources("Canciones");
  await app.control.getByRole("tabpanel", { name: "Canciones" }).getByRole("listitem").first().click();
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText("Primera línea")).toBeVisible();
  const mark = () =>
    projector.evaluate(() => {
      const video = document.querySelector<HTMLVideoElement>("[data-song-video] video");
      if (video) video.dataset["seen"] ??= String(Math.random());
      return video?.dataset["seen"] ?? null;
    });
  const element = await mark();
  expect(element).not.toBeNull();
  const before = await projectorSnapshot(projector);
  await recordPushes(projector, ["display-content", "audio-tracks"]);
  await reloadControl(app);
  await roomUntouched(projector, before);
  expect(await mark()).toBe(element);
  await app.quit("close");
});

test("the stage's countdown and message stay through a control reload", async ({ app }) => {
  const opened = app.electron.waitForEvent("window", { predicate: (page) => page.url().endsWith("/stage.html") });
  await app.control.getByRole("button", { name: "Configuración" }).click();
  const settings = app.control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Pantallas" }).click();
  await settings.getByRole("group").filter({ hasText: "Esta pantalla tiene la ventana de control" }).getByRole("combobox").click();
  await app.control.getByRole("option", { name: "Escenario", exact: true }).click();
  await app.control.keyboard.press("Escape");
  const stage = await opened;
  await stage.waitForLoadState("domcontentloaded");
  const bar = app.control.getByRole("region", { name: "Escenario" });
  await bar.getByRole("heading", { name: "Escenario" }).click();
  const card = app.control.getByRole("dialog", { name: "Escenario" });
  await card.getByRole("textbox", { name: "Duración de la cuenta" }).fill("30");
  await card.getByRole("button", { name: "Iniciar la cuenta" }).click();
  const field = card.getByRole("textbox", { name: "Mensaje al escenario" });
  await field.fill("Último coro");
  await field.press("Enter");
  await expect(stage.getByRole("status")).toHaveText("Último coro");
  await expect(stage.getByRole("timer")).toHaveText(/^(30:00|29:5\d)$/);

  await recordPushes(stage, ["stage-content"]);
  await reloadControl(app);
  // Before, the reloaded window pushed its empty stage: the preacher lost both.
  await expect(stage.getByRole("status")).toHaveText("Último coro");
  await expect(stage.getByRole("timer")).toHaveText(/^29:[45]\d$/);
  for (const { payload } of await pushes(stage)) {
    expect(payload).toMatchObject({ message: { text: "Último coro" }, countdown: expect.anything() });
  }
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

test("a control window whose renderer dies comes back by itself, knowing the video on air", async ({ app }, testInfo) => {
  app.crashLogExpected = true;
  const projector = await videoMusicAndPlate(app, (name) => testInfo.outputPath(name));
  const before = await projectorSnapshot(projector);
  await recordPushes(projector, ["display-content", "audio-tracks"]);
  await app.electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().endsWith("/index.html"))
      ?.webContents.forcefullyCrashRenderer(),
  );
  // Before, the control stayed dead: the app could only be quit, and the projector with it (2026-11-15 audit, A30).
  await expect
    .poll(() => controlPage(app, `document.body.innerText.includes(${JSON.stringify(RECOVERED)})`), { timeout: 15_000 })
    .toBe(true);
  await projector.waitForTimeout(2000);
  await roomUntouched(projector, before);
  await videoPlays(projector);
  await tonePlays(projector);
  expect(await controlPage(app, 'document.body.innerText.includes("long-clip")')).toBe(true);
  expect(await controlPage(app, 'document.body.innerText.includes("Sin pantalla")')).toBe(false);
});
