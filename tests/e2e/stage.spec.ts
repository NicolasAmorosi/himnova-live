import type { Page } from "@playwright/test";
import { parseLyrics } from "../../src/shared/song-text";
import { DEFAULT_SONG_THEME } from "../../src/shared/types/song";
import { engineCanvas, expect, moving, relaunch, test, videoStates, type WorshipApp } from "./support/app";

const JUAN_3_16 = "Porque de tal manera amó Dios al mundo";
const JUAN_3_17 = "Porque no envió Dios á su Hijo al mundo";

const isStage = (page: Page) => page.url().endsWith("/stage.html");

/** Settings ▸ Screens: the operator's own screen as the stage (`on`, a movable window there) or back to «Solo
 *  control». The one screen every machine has, so the suite runs anywhere. */
async function chooseStageScreen(app: WorshipApp, on: boolean | "Copia del proyector"): Promise<void> {
  await app.control.getByRole("button", { name: "Configuración" }).click();
  const settings = app.control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Pantallas" }).click();
  await settings.getByRole("group").filter({ hasText: "Esta pantalla tiene la ventana de control" }).getByRole("combobox").click();
  const role = on === true ? "Escenario" : on === false ? "Solo control" : on;
  await app.control.getByRole("option", { name: role, exact: true }).click();
  await app.control.keyboard.press("Escape");
}

/** Settings ▸ Screens ▸ «Videos en el escenario». */
async function stageVideos(app: WorshipApp, on: boolean): Promise<void> {
  await app.control.getByRole("button", { name: "Configuración" }).click();
  const settings = app.control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Pantallas" }).click();
  await settings.getByRole("group", { name: "Videos en el escenario" }).getByRole("switch").setChecked(on);
  await app.control.keyboard.press("Escape");
}

/** The view the stage shows (`StageView`'s `data-layout`): the one staying, while a swap fades. */
const layout = (stage: Page) => stage.locator("[data-layout]").first();

test("the stage screen shows the live verse and the next; under NEGRO it shows black, without a word", async ({ app }) => {
  const opened = app.electron.waitForEvent("window", { predicate: isStage });
  await chooseStageScreen(app, true);
  const stage = await opened;
  await stage.waitForLoadState("domcontentloaded");
  // The time, before anything is live.
  // The one staying (the view fades in from the one it replaces, which leaves first in the DOM).
  await expect(stage.locator("time").last()).toHaveText(/\d{1,2}:\d{2}/);

  await app.openChapter("Juan 3");
  await app.control.getByRole("listitem").filter({ hasText: JUAN_3_16 }).click();
  await app.goLive();
  await expect(stage.getByText(JUAN_3_16, { exact: false })).toBeVisible();
  await expect(stage.getByText(JUAN_3_17, { exact: false })).toBeVisible();

  // What the projector shows, as it shows it (owner, 2026-11-13): the next verse stays.
  await app.control.getByRole("button", { name: "NEGRO", exact: true }).click();
  await expect(stage.getByText(JUAN_3_16, { exact: false })).toBeHidden();
  await expect(stage.getByText(JUAN_3_17, { exact: false })).toBeVisible();
  await expect(stage.getByText("NEGRO", { exact: true })).toHaveCount(0);

  // «Solo control» closes it.
  const closed = stage.waitForEvent("close");
  await chooseStageScreen(app, false);
  await closed;
  expect(app.electron.windows().some(isStage)).toBe(false);
});

test("a song's chords show on the stage screen, over its words, and never on the projector", async ({ app }) => {
  const opened = app.electron.waitForEvent("window", { predicate: isStage });
  await chooseStageScreen(app, true);
  const stage = await opened;
  await stage.waitForLoadState("domcontentloaded");

  // Written in the editor with its chords inline, as ChordPro writes them.
  await app.openResources("Canciones");
  const tab = app.control.getByRole("tabpanel", { name: "Canciones" });
  await tab.getByRole("button", { name: "Nueva canción" }).first().click();
  const editor = app.control.getByRole("dialog").last();
  await editor.getByRole("textbox", { name: "Título" }).fill("Cuán grande es Él");
  await editor.getByRole("textbox", { name: "Letra" }).fill("[Estrofa 1]\n[G]Señor mi [C]Dios\n\n[Coro]\n[D]Mi corazón");
  await editor.getByRole("button", { name: "Guardar", exact: true }).click();
  await editor.getByRole("button", { name: "Cerrar" }).first().click();
  await tab.getByRole("list", { name: "Canciones" }).getByRole("listitem").filter({ hasText: "Cuán grande" }).click();
  await app.goLive();

  const projector = await app.projector();
  await expect(projector.getByText("Señor mi Dios")).toBeVisible();
  await expect(projector.locator("[data-song-chord]")).toHaveCount(0);
  // The live slide's chords, and the next slide's.
  await expect(stage.locator("[data-song-chord]")).toHaveText(["G ", "C ", "D "]);
  await stage.screenshot({ path: process.env["STAGE_SHOT"] ?? test.info().outputPath("stage.png") });
});

test("a song's video background moves on the stage screen; with Settings' videos off it is its still", async ({
  app: first,
}) => {
  const [clip] = await first.addMedia("video", "clip.mp4");
  if (!clip) throw new Error("import failed");
  // A song on a theme over the video, written through IPC: the window loads songs and themes when it starts.
  const theme = await first.invoke<{ id: number }>("songTheme:create", {
    name: "Con video",
    style: { ...DEFAULT_SONG_THEME, background: { kind: "video", assetId: clip.id, fit: "cover" } },
  });
  await first.invoke("song:create", {
    title: "Fondo",
    number: null,
    authors: null,
    copyright: null,
    ccliNumber: null,
    notes: null,
    sections: parseLyrics("[Estrofa 1]\nuno\n\n[Coro]\ncoro", "es").sections,
    order: [],
    themeId: theme.id,
  });
  await first.quit();
  const app = await relaunch(first);

  const opened = app.electron.waitForEvent("window", { predicate: isStage });
  await chooseStageScreen(app, true);
  const stage = await opened;
  await stage.waitForLoadState("domcontentloaded");
  await app.openResources("Canciones");
  await app.control.getByRole("tabpanel", { name: "Canciones" }).getByRole("listitem").first().click();
  await app.goLive();
  await expect(stage.getByText("uno", { exact: true })).toBeVisible();
  await expect(stage.getByText("coro", { exact: true })).toBeVisible();
  // It plays under the live slide (owner, 2026-11-14); the next one is a still.
  await expect.poll(async () => (await videoStates(stage)).some((v) => !v.paused && v.currentTime > 0.5)).toBe(true);
  // Off, the stage decodes nothing.
  await stageVideos(app, false);
  await expect.poll(async () => (await videoStates(stage)).length).toBe(0);
  await expect(stage.getByText("uno", { exact: true })).toBeVisible();
});

test("the stage panel: only with a stage screen; its countdown and message reach the stage, and it switches views", async ({
  app,
}) => {
  const bar = app.control.getByRole("region", { name: "Escenario" });
  const card = app.control.getByRole("dialog", { name: "Escenario" });
  await expect(bar).toHaveCount(0);
  const opened = app.electron.waitForEvent("window", { predicate: isStage });
  await chooseStageScreen(app, true);
  const stage = await opened;
  await stage.waitForLoadState("domcontentloaded");
  await expect(bar).toBeVisible();

  // «Auto» is the pastor's with nothing that has a next. A press anywhere on the bar opens the card.
  await bar.getByRole("heading", { name: "Escenario" }).click();
  await expect(card).toBeVisible();
  await expect(layout(stage)).toHaveAttribute("data-layout", "preacher");

  // The countdown is one field and ▶, which starts it at once: minutes, or a time of day; nonsense starts nothing.
  const length = card.getByRole("textbox", { name: "Duración de la cuenta" });
  await expect(length).toHaveValue("30");
  await length.fill("abc");
  await expect(card.getByRole("button", { name: "Iniciar la cuenta" })).toBeDisabled();
  await length.fill("30");
  await card.getByRole("button", { name: "Iniciar la cuenta" }).click();
  await expect(stage.getByRole("timer")).toHaveText(/^(30:00|29:5\d)$/);
  await expect(length).toHaveCount(0);
  await expect(card.getByRole("img", { name: "Lo que se ve en el escenario" }).getByRole("timer")).toHaveText(/^29:5\d$/);
  await card.getByRole("button", { name: "Un minuto más" }).click();
  await expect(stage.getByRole("timer")).toHaveText(/^30:5\d$/);
  await card.getByRole("button", { name: "Pausar la cuenta" }).click();
  await expect(card.getByText("En pausa")).toBeVisible();
  await card.getByRole("button", { name: "Seguir la cuenta" }).click();

  // A message: Enter shows it at the foot of the stage; Esc with nothing typed takes it off, and so does the
  // section's «Quitar».
  const field = card.getByRole("textbox", { name: "Mensaje al escenario" });
  await field.fill("Último coro");
  await field.press("Enter");
  await expect(stage.getByRole("status")).toHaveText("Último coro");
  // The one on the stage is marked among the phrases: what was written by hand becomes one.
  await expect(card.getByRole("button", { name: "Último coro", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(field).toHaveValue("");
  const height = (await card.boundingBox())!.height;
  await field.press("Escape");
  await expect(stage.getByRole("status")).toHaveCount(0);
  await expect(card).toBeVisible();
  // Nothing in the card grows or shrinks with a message.
  expect((await card.boundingBox())!.height).toBe(height);

  // A ready phrase is one click, and another takes it off.
  const slower = card.getByRole("button", { name: "Más despacio", exact: true });
  await slower.click();
  await expect(stage.getByRole("status")).toHaveText("Más despacio");
  await slower.click();
  await expect(stage.getByRole("status")).toHaveCount(0);
  // The head's token takes it off too, the same folded or opened.
  await slower.click();
  await card.getByRole("button", { name: "Quitar el mensaje del escenario" }).click();
  await expect(stage.getByRole("status")).toHaveCount(0);
  // Blinking without end is asked of the message showing, the only time its button is there.
  await expect(card.getByRole("button", { name: "Parpadear" })).toHaveCount(0);
  await slower.click();
  await card.getByRole("button", { name: "Parpadear" }).click();
  await expect(card.getByRole("button", { name: "Parpadear" })).toHaveAttribute("aria-pressed", "true");
  await expect(stage.getByRole("status")).toHaveClass(/wa-stage-blink-forever/);

  // «Músicos» by hand: what is live, what follows, the countdown small; the message stays.
  await card.getByRole("button", { name: "Músicos", exact: true }).click();
  await expect(layout(stage)).toHaveAttribute("data-layout", "musicians");
  await expect(stage.getByRole("status")).toHaveText("Más despacio");
  // «Proyector»: a copy of the projector, without the count or the message.
  await card.getByRole("button", { name: "Proyector", exact: true }).click();
  await expect(stage.getByRole("status")).toHaveCount(0);
  await expect(stage.getByRole("timer")).toHaveCount(0);
  await card.getByRole("button", { name: "Auto", exact: true }).click();

  // A press anywhere else folds it, with its animation; the bar keeps the count and the message, each with its ✕.
  await app.control.getByRole("heading", { name: "Programa" }).click();
  await expect(card).toHaveCount(0);
  await expect(bar.getByText("Más despacio")).toBeVisible();
  await expect(bar.getByText(/^\d{2}:\d{2}$/)).toBeVisible();
  await bar.getByRole("button", { name: "Quitar la cuenta" }).click();
  await expect(stage.getByRole("timer")).toHaveCount(0);
  await expect(card).toHaveCount(0);

  // M opens it and puts the keyboard in the message: what follows is typed, not a shortcut (B is BLACK).
  await app.control.locator("body").press("m");
  await expect(field).toBeFocused();
  await app.control.keyboard.type("Hablar más alto");
  await expect(field).toHaveValue("Hablar más alto");
  await expect(app.control.getByRole("button", { name: "NEGRO", exact: true })).not.toHaveAttribute("aria-pressed", "true");
  await card.getByRole("button", { name: "Cerrar el panel del escenario" }).click();
  await expect(card).toHaveCount(0);

  await chooseStageScreen(app, false);
  await expect(bar).toHaveCount(0);
});

test("«Auto» shows the musicians' view while a chapter's verse is live, and the pastor's once it is off", async ({ app }) => {
  const opened = app.electron.waitForEvent("window", { predicate: isStage });
  await chooseStageScreen(app, true);
  const stage = await opened;
  await stage.waitForLoadState("domcontentloaded");
  await app.openChapter("Juan 3");
  await app.control.getByRole("listitem").filter({ hasText: JUAN_3_16 }).click();
  await app.goLive();
  await expect(layout(stage)).toHaveAttribute("data-layout", "musicians");
  await app.liveColumn().getByRole("button", { name: "Sacar del aire" }).first().click();
  await expect(layout(stage)).toHaveAttribute("data-layout", "preacher");
});

test("a Functions countdown on the air shows on the stage in the stage's style; the panel's own countdown wins", async ({
  app,
}) => {
  const opened = app.electron.waitForEvent("window", { predicate: isStage });
  await chooseStageScreen(app, true);
  const stage = await opened;
  await stage.waitForLoadState("domcontentloaded");
  await app.openResources("Funciones", "Utilidades");
  await app.control.getByRole("list", { name: "Escenas de tiempo" }).getByRole("listitem").filter({ hasText: "Cuenta 10 minutos" }).click();
  await app.goLive();
  // The pastor's view, its count large and coloured like the stage's own, held until the LIVE row starts it.
  await expect(layout(stage)).toHaveAttribute("data-layout", "preacher");
  await expect(stage.getByRole("timer")).toHaveText(/^(10:00|09:5\d)$/);
  await expect(stage.getByRole("timer")).toHaveAttribute("data-tone", "normal");
  // The panel's countdown is the one meant for the stage: it takes the place while it is set.
  const bar = app.control.getByRole("region", { name: "Escenario" });
  const card = app.control.getByRole("dialog", { name: "Escenario" });
  await bar.getByRole("heading", { name: "Escenario" }).click();
  await card.getByRole("textbox", { name: "Duración de la cuenta" }).fill("25");
  await card.getByRole("button", { name: "Iniciar la cuenta" }).click();
  await expect(stage.getByRole("timer")).toHaveText(/^(25:00|24:5\d)$/);
  await card.getByRole("button", { name: "Quitar la cuenta" }).click();
  await expect(stage.getByRole("timer")).toHaveText(/^(10:00|09:5\d)$/);
  // Off the air, the stage's time again.
  await card.getByRole("button", { name: "Cerrar el panel del escenario" }).click();
  await app.liveColumn().getByRole("button", { name: "Sacar del aire" }).first().click();
  await expect(stage.getByRole("timer")).toHaveCount(0);
});

test("the bar and the card share one head, the count in the time's place for the musicians, and a pinned card", async ({
  app,
}) => {
  const bar = app.control.getByRole("region", { name: "Escenario" });
  const card = app.control.getByRole("dialog", { name: "Escenario" });
  const opened = app.electron.waitForEvent("window", { predicate: isStage });
  await chooseStageScreen(app, true);
  const stage = await opened;
  await stage.waitForLoadState("domcontentloaded");
  // Nothing on the stage: the head holds only its name, the pin and the arrow.
  await expect(bar.getByRole("button")).toHaveCount(2);

  // The pin on the folded bar opens the card, pinned.
  await bar.getByRole("button", { name: "Fijar el panel: no se cierra al tocar afuera" }).click();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Iniciar la cuenta" }).click();

  // The musicians' view with a count: the count where the time was, the time small over what comes next.
  await card.getByRole("button", { name: "Músicos", exact: true }).click();
  await expect(layout(stage)).toHaveAttribute("data-layout", "musicians");
  await expect(stage.getByRole("timer")).toHaveText(/^(30:00|29:5\d)$/);
  await expect(stage.locator("time")).toHaveCount(1);

  // Pinned, a press elsewhere leaves it open; let go, the next one folds it.
  const main = (await app.control.locator("main").boundingBox())!;
  const elsewhere = () => app.control.mouse.click(main.x + main.width / 2, main.y + 20);
  await elsewhere();
  await app.control.waitForTimeout(500);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Soltar el panel: se cierra al tocar afuera" }).click();
  await elsewhere();
  await expect(card).toHaveCount(0);
  // Folded, the same head: the count with its ✕, the pin and the arrow.
  await expect(bar.getByRole("timer")).toHaveText(/^29:\d\d$/);
  await expect(bar.getByRole("button")).toHaveCount(3);
});

test("Settings' «Copia del proyector»: the stage screen copies the projector and the work screen has no stage panel", async ({
  app,
}) => {
  const opened = app.electron.waitForEvent("window", { predicate: isStage });
  await chooseStageScreen(app, "Copia del proyector");
  const stage = await opened;
  await stage.waitForLoadState("domcontentloaded");
  await expect(app.control.getByRole("region", { name: "Escenario" })).toHaveCount(0);
  await app.openChapter("Juan 3");
  await app.control.getByRole("listitem").filter({ hasText: JUAN_3_16 }).click();
  await app.goLive();
  // The projector's verse, and nothing of the stage's own: no next, no time.
  await expect(stage.getByText(JUAN_3_16, { exact: false })).toBeVisible();
  await expect(stage.getByText(JUAN_3_17, { exact: false })).toHaveCount(0);
  await expect(stage.locator("time")).toHaveCount(0);
  await app.control.getByRole("button", { name: "NEGRO", exact: true }).click();
  await expect(stage.getByText(JUAN_3_16, { exact: false })).toBeHidden();
});

test("«Proyector» plays what the projector plays: an engine video's frames move there, a Chromium video keeps step, silent", async ({
  app,
}) => {
  const [mp4, avi] = await app.addMedia("video", "clip.mp4", "long-xvid.avi");
  if (!mp4 || !avi) throw new Error("import failed");
  await expect.poll(async () => (await app.invoke<number[]>("engine:assets")).includes(avi.id), { timeout: 30_000 }).toBe(true);
  const opened = app.electron.waitForEvent("window", { predicate: isStage });
  await chooseStageScreen(app, true);
  const stage = await opened;
  await stage.waitForLoadState("domcontentloaded");
  const bar = app.control.getByRole("region", { name: "Escenario" });
  const card = app.control.getByRole("dialog", { name: "Escenario" });
  await bar.getByRole("heading", { name: "Escenario" }).click();
  await card.getByRole("button", { name: "Proyector", exact: true }).click();
  await card.getByRole("button", { name: "Cerrar el panel del escenario" }).click();
  await expect(card).toHaveCount(0);

  // The engine's: its frames reach the stage as they reach the projector, and they move.
  await app.previewFile("Videos", "long-xvid");
  await app.goLive();
  await expect.poll(async () => (await engineCanvas(stage, "video:"))?.width ?? 0).toBe(1920);
  await expect.poll(() => moving(stage, "video:")).toBe(true);

  // Chromium's: a copy that follows the projector's own reports, never a sound.
  await app.previewFile("Videos", "clip");
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await videoStates(stage)).some((v) => !v.paused && v.currentTime > 1)).toBe(true);
  const [mine] = (await videoStates(stage)).filter((v) => !v.paused);
  const [theirs] = (await videoStates(projector)).filter((v) => !v.paused);
  expect(Math.abs(mine!.currentTime - theirs!.currentTime)).toBeLessThan(0.5);
  expect(await app.electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/stage.html"))?.webContents.isAudioMuted(),
  )).toBe(true);

  // The musicians' view plays it too, in step (owner, 2026-11-14)…
  await bar.getByRole("heading", { name: "Escenario" }).click();
  await card.getByRole("button", { name: "Músicos", exact: true }).click();
  await expect.poll(async () => (await videoStates(stage)).some((v) => !v.paused && v.currentTime > 1)).toBe(true);
  await card.getByRole("button", { name: "Cerrar el panel del escenario" }).click();
  await app.previewFile("Videos", "long-xvid");
  await app.goLive();
  await expect.poll(() => moving(stage, "video:")).toBe(true);
  // …and with Settings' videos off the stage decodes nothing.
  await stageVideos(app, false);
  await expect.poll(async () => (await videoStates(stage)).length).toBe(0);
});
