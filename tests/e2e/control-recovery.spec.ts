import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { parseLyrics } from "../../src/shared/song-text";
import { DEFAULT_SONG_THEME } from "../../src/shared/types/song";
import { audioStates, engineCanvas, expect, moving, relaunch, test, videoStates, type WorshipApp } from "./support/app";
import { probe, source } from "./support/ndi";
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

test("the NDI output goes on through a control reload: every frame, and every beep with its flash", async ({ app }) => {
  test.setTimeout(180_000);
  const ndi = await source(app);
  test.skip(!ndi, "no NDI runtime on this computer");
  // The first attempt's review heard a cut on NDI at a reload: measured here, at the receiver.
  await app.addMedia("video", "ndi-bar.mp4");
  await app.previewFile("Videos", "ndi-bar");
  await app.goLive();
  await app.projector();
  await app.control.waitForTimeout(1500);
  const counting = probe<{ fresh: number; skipped: number; nobar: number }>("count", ndi!.name, ndi!.url, "8");
  await app.control.waitForTimeout(2500);
  await reloadControl(app);
  const counted = await counting;
  console.log(`[control-recovery] NDI frames through a reload: ${JSON.stringify(counted)}`);
  // `ndi-receiver.spec.ts`'s bar for a video with nothing happening: every number once, at most one lost at a joint.
  expect(counted.fresh).toBeGreaterThanOrEqual(0.97 * 30 * 8);
  expect(counted.skipped).toBeLessThanOrEqual(1);

  await app.addMedia("video", "ndi-av.mp4");
  await app.previewFile("Videos", "ndi-av");
  await app.goLive();
  await app.control.waitForTimeout(1500);
  const syncing = probe<{ pairs: number; median: number; flashes: number; beeps: number }>("avsync", ndi!.name, ndi!.url, "12");
  await app.control.waitForTimeout(3000);
  await reloadControl(app);
  const sync = await syncing;
  console.log(`[control-recovery] NDI sound through a reload: ${JSON.stringify(sync)}`);
  // A gap in the sound loses a beep its flash then pairs with nothing.
  expect(sync.beeps).toBeGreaterThanOrEqual(sync.flashes - 1);
  expect(sync.pairs).toBeGreaterThanOrEqual(10);
  expect(sync.median).toBeGreaterThanOrEqual(-45);
  expect(sync.median).toBeLessThanOrEqual(65);
});

/** The control window's page, read from main: after a crash Playwright's own handle on it is gone. A script sent
 *  while the page is dying never answers (Electron 44) or rejects with «Render frame was disposed» (45), so each try
 *  gives up after a second or on that rejection. */
const controlPage = (app: WorshipApp, script: string) =>
  app.electron.evaluate(({ BrowserWindow }, script) => {
    const control = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().endsWith("/index.html"));
    if (!control || control.webContents.isCrashed() || control.webContents.isLoading()) return null;
    return Promise.race([
      (control.webContents.executeJavaScript(script) as Promise<unknown>).catch(() => null),
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

/** Main's own message boxes from now on: each answered with the next of `answers` (then its cancel button), and kept. */
async function answerMessageBoxes(app: WorshipApp, ...answers: number[]): Promise<void> {
  await app.electron.evaluate(({ dialog }, queue) => {
    const kept: { message: string; buttons: string[] }[] = [];
    (globalThis as { boxes?: typeof kept }).boxes = kept;
    dialog.showMessageBox = (...args: unknown[]) => {
      const options = args.at(-1) as Electron.MessageBoxOptions;
      kept.push({ message: options.message, buttons: options.buttons ?? [] });
      return Promise.resolve({ response: queue.shift() ?? options.cancelId ?? 0, checkboxChecked: false });
    };
  }, answers);
}

const boxes = (app: WorshipApp) =>
  app.electron.evaluate(() => (globalThis as { boxes?: { message: string; buttons: string[] }[] }).boxes ?? []);

const crashControl = (app: WorshipApp) =>
  app.electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().endsWith("/index.html"))
      ?.webContents.forcefullyCrashRenderer(),
  );

const RETRY_BOX = {
  message: "La ventana de control se cerró por un error varias veces seguidas y no volvió sola.",
  buttons: ["Reintentar", "Dejarla así"],
};

/** Past the cap: three deaths within a minute come back alone (each waited for), the fourth asks. */
async function killPastTheCap(app: WorshipApp): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await crashControl(app);
    await expect
      .poll(() => controlPage(app, `document.body.innerText.includes(${JSON.stringify(RECOVERED)})`), { timeout: 15_000 })
      .toBe(true);
  }
  expect(await boxes(app)).toEqual([]);
  await crashControl(app);
  await expect.poll(() => boxes(app)).toEqual([RETRY_BOX]);
}

test("a control page that keeps dying asks, and «Reintentar» brings it back over what is live; left down, it is sent nothing", async ({
  app,
}, testInfo) => {
  app.crashLogExpected = true;
  const projector = await videoMusicAndPlate(app, (name) => testInfo.outputPath(name));
  await answerMessageBoxes(app, 0, 1);
  const before = await projectorSnapshot(projector);
  await recordPushes(projector, ["display-content", "audio-tracks"]);
  // Before, past the cap the window stayed a flat colour with nothing on it (owner's hand test, 2026-11-16).
  await killPastTheCap(app);
  await expect
    .poll(() => controlPage(app, `document.body.innerText.includes(${JSON.stringify(RECOVERED)})`), { timeout: 15_000 })
    .toBe(true);
  await roomUntouched(projector, before);
  expect(await controlPage(app, 'document.body.innerText.includes("long-clip")')).toBe(true);

  // «Dejarla así»: down for good, the room goes on, and main sends the dead page nothing (each send wrote a stack to
  // main.log, ~29 a second with the music's meters, measured on Windows).
  await crashControl(app);
  await expect.poll(async () => (await boxes(app)).length).toBe(2);
  // From here on only: while the page dies, this test's own `controlPage` may still reach it once.
  const log = path.join(app.profile, "main.log");
  const from = fs.statSync(log).size;
  await projector.waitForTimeout(3000);
  expect(await controlPage(app, "1")).toBeNull();
  await videoPlays(projector);
  await tonePlays(projector);
  expect(fs.readFileSync(log).subarray(from).toString()).not.toContain("Error sending from webContents");
});

test("with the control page down and the projector up, closing asks first: «Cancelar» keeps the room, then it closes", async ({
  app,
}) => {
  app.crashLogExpected = true;
  await app.addMedia("video", "clip.mp4");
  await app.previewFile("Videos", "clip");
  await app.goLive();
  await app.projector();
  await answerMessageBoxes(app, 1, 1);
  await killPastTheCap(app);
  // Before, the close waited out the 4 s grace and took the projector, the stage and the sound without a word.
  await app.electron.evaluate(({ app }) => app.quit());
  await expect.poll(async () => (await boxes(app))[1]).toEqual({
    message: "¿Cerrar Himnova Live?",
    buttons: ["Cerrar igualmente", "Cancelar"],
  });
  const gone = await Promise.race([app.exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 6000))]);
  expect(gone).toBe(false);
  expect(app.hasProjector()).toBe(true);

  await answerMessageBoxes(app, 0);
  await app.electron.evaluate(({ app }) => app.quit());
  await app.exited;
});

test("with the control page down and nothing up, closing asks nothing and does not wait", async ({ app }) => {
  app.crashLogExpected = true;
  await answerMessageBoxes(app, 1);
  // The page gives main its copy of what is live just after it is drawn: crashed before that (Windows, in this file's
  // run, right after the fixture saw EN VIVO), it comes back as a launch, which loses nothing and says nothing.
  await expect.poll(async () => (await app.invoke<{ copy: unknown }>("window:liveCopy")).copy !== null).toBe(true);
  await killPastTheCap(app);
  await app.electron.evaluate(({ app }) => app.quit());
  // Under the close guard's 4 s grace, which is how long a dead page made it wait before.
  const gone = await Promise.race([app.exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 2500))]);
  // A box here would have been answered «Cancelar» and kept the app alive.
  expect(gone).toBe(true);
});
