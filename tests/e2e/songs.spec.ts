import type { Page } from "@playwright/test";
import { expect, relaunch, test, type WorshipApp } from "./support/app";

/**
 * Songs, F1: written or pasted in the editor, searched without accents,
 * previewed and projected slide by slide at ONE size, edited while live, and
 * held by reference in the order of service.
 */

const tab = (app: WorshipApp) => app.control.getByRole("tabpanel", { name: "Canciones" });
const songRows = (app: WorshipApp) => tab(app).getByRole("list", { name: "Canciones" }).getByRole("listitem");
const dialog = (app: WorshipApp) => app.control.getByRole("dialog").first();
const toast = (app: WorshipApp, text: string) => app.control.getByRole("status").filter({ hasText: text });
const scheduleRows = (app: WorshipApp) =>
  app.control
    .locator("section")
    .filter({ has: app.control.getByRole("heading", { name: "Programa", exact: true }) })
    .getByRole("list")
    .first()
    .getByRole("listitem");

const GRACIA = [
  "[Estrofa 1]",
  "Sublime gracia del Señor",
  "que a un pecador salvó",
  "",
  "Fui ciego mas hoy veo yo",
  "",
  "[Coro]",
  "Aleluya, aleluya",
].join("\n");

async function createSong(app: WorshipApp, title: string, lyrics: string): Promise<void> {
  await app.openResources("Canciones");
  await tab(app).getByRole("button", { name: "Nueva canción" }).first().click();
  await dialog(app).getByRole("textbox", { name: "Título" }).fill(title);
  await dialog(app).getByRole("textbox", { name: "Letra" }).fill(lyrics);
  await dialog(app).getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(toast(app, `Se guardó «${title}»`)).toBeVisible();
  await dialog(app).getByRole("button", { name: "Cerrar" }).first().click();
  await expect(app.control.getByRole("dialog")).toHaveCount(0);
}

/** The font size the projector draws the song's letters at, in px. */
function projectedSize(projector: Page): Promise<string> {
  return projector.locator("[data-song-block]").last().evaluate((el) => getComputedStyle(el).fontSize);
}

test("a song written in the editor is found by its lyrics without accents and goes live", async ({ app }) => {
  await createSong(app, "Sublime gracia", GRACIA);

  await tab(app).getByRole("textbox", { name: "Buscar por título, número, autor o letra" }).fill("senor");
  await expect(songRows(app)).toHaveCount(1);
  await expect(songRows(app).first()).toContainText("Señor");
  await songRows(app).first().click();

  // PREVIEW: the order expanded, each slide with its section.
  const grid = app.previewColumn().getByRole("list", { name: "Diapositivas de «Sublime gracia»" });
  await expect(grid.getByRole("listitem")).toHaveText([/Estrofa 1/, /Estrofa 1/, /Coro/]);

  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText("Sublime gracia del Señor")).toBeVisible();

  await app.control.keyboard.press("ArrowRight");
  await expect(projector.getByText("Fui ciego mas hoy veo yo")).toBeVisible();
  await app.control.keyboard.press("PageDown");
  await expect(projector.getByText("Aleluya, aleluya")).toBeVisible();
  await app.control.keyboard.press("ArrowLeft");
  await expect(projector.getByText("Fui ciego mas hoy veo yo")).toBeVisible();
  await expect(app.liveColumn().getByText("2/3")).toBeVisible();

  // A click on the LIVE grid moves the projector.
  await app.liveColumn().getByRole("listitem").nth(2).click();
  await expect(projector.getByText("Aleluya, aleluya")).toBeVisible();
});

test("every slide of a song is drawn at the same size", async ({ app }) => {
  const long = Array.from({ length: 6 }, (_, i) => `una línea bastante larga de la estrofa número ${i + 1}`);
  await createSong(app, "Tamaño único", ["[Estrofa 1]", "corta", "", ...long].join("\n"));
  await songRows(app).filter({ hasText: "Tamaño único" }).click();
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText("corta")).toBeVisible();
  const short = await projectedSize(projector);
  await app.control.keyboard.press("ArrowRight");
  await expect(projector.getByText(long[0]!)).toBeVisible();
  expect(await projectedSize(projector)).toBe(short);
});

test("pasted lyrics without headers: the block that comes back is the chorus, sung each time", async ({ app }) => {
  await createSong(app, "Pegada", ["Primera", "", "Vuelve", "", "Segunda", "", "Vuelve"].join("\n"));
  await songRows(app).filter({ hasText: "Pegada" }).click();
  const grid = app.previewColumn().getByRole("list", { name: "Diapositivas de «Pegada»" });
  await expect(grid.getByRole("listitem")).toHaveText([/Estrofa 1/, /Coro/, /Estrofa 2/, /Coro/]);
});

test("saving the song that is live changes the projector in place, on the same slide", async ({ app }) => {
  await createSong(app, "Sublime gracia", GRACIA);
  await songRows(app).first().click();
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText("Sublime gracia del Señor")).toBeVisible();
  await app.control.keyboard.press("ArrowRight");
  await app.control.keyboard.press("ArrowRight");
  await expect(projector.getByText("Aleluya, aleluya")).toBeVisible();

  await tab(app).getByRole("button", { name: "Editar canción" }).click();
  const lyrics = dialog(app).getByRole("textbox", { name: "Letra" });
  await lyrics.fill((await lyrics.inputValue()).replace("Aleluya, aleluya", "Gloria a Dios"));
  await dialog(app).getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(projector.getByText("Gloria a Dios")).toBeVisible();
  await expect(app.liveColumn().getByText("3/3")).toBeVisible();
});

test("a song in the order of service comes back after a restart, and deleting it asks", async ({ app }) => {
  await createSong(app, "Sublime gracia", GRACIA);
  await songRows(app).first().click();
  await tab(app).getByRole("button", { name: "Agregar al programa" }).click();
  await expect(scheduleRows(app)).toHaveText([/Sublime gracia/]);

  await app.quit("close");
  const again = await relaunch(app);
  await expect(scheduleRows(again)).toHaveText([/Sublime gracia/]);

  // A saved program sings it: deleting names the program first.
  const [song] = await again.invoke<{ id: number }[]>("song:list");
  await again.invoke("programs:save", { name: "Domingo", items: [{ kind: "song", songId: song!.id, title: null }] });
  await again.openResources("Canciones");
  await songRows(again).first().click();
  await tab(again).getByRole("button", { name: "Editar canción" }).click();
  await dialog(again).getByRole("button", { name: "Eliminar", exact: true }).click();
  const confirm = again.control.getByRole("dialog", { name: "¿Eliminar esta canción?" });
  await expect(confirm.getByText("Domingo")).toBeVisible();
  await confirm.getByRole("button", { name: "Eliminar igualmente" }).click();
  await expect(tab(again).getByText("Todavía no hay canciones")).toBeVisible();
  await expect(scheduleRows(again)).toHaveCount(0);
});
