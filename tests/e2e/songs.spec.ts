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

async function createSong(app: WorshipApp, title: string, lyrics: string, order?: string): Promise<void> {
  await app.openResources("Canciones");
  await tab(app).getByRole("button", { name: "Nueva canción" }).first().click();
  await dialog(app).getByRole("textbox", { name: "Título" }).fill(title);
  await dialog(app).getByRole("textbox", { name: "Letra" }).fill(lyrics);
  if (order) await dialog(app).getByRole("textbox", { name: "Orden como texto" }).fill(order);
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

test("keys jump to a section: its next time, Shift the previous, and one off the order comes back", async ({ app }) => {
  const lyrics = "[Estrofa 1]\nprimera\n\n[Estrofa 2]\nsegunda\n\n[Coro]\nel coro\n\n[Puente]\npuente uno\n\npuente dos";
  await createSong(app, "Con puente", lyrics, "E1 C E2 C");
  await songRows(app).filter({ hasText: "Con puente" }).click();
  await app.goLive();
  const projector = await app.projector();
  const live = app.liveColumn();
  await expect(projector.getByText("primera")).toBeVisible();

  await app.control.keyboard.press("c");
  await expect(projector.getByText("el coro")).toBeVisible();
  await expect(live.getByText("2/4")).toBeVisible();
  await app.control.keyboard.press("2");
  await expect(projector.getByText("segunda")).toBeVisible();
  await app.control.keyboard.press("c");
  await expect(live.getByText("4/4")).toBeVisible();
  await app.control.keyboard.press("Shift+C");
  await expect(live.getByText("2/4")).toBeVisible();

  // The bridge is not in the order: sung as a detour, then → carries on after.
  await app.control.keyboard.press("p");
  await expect(projector.getByText("puente uno")).toBeVisible();
  await expect(live.getByText("fuera del orden · 1/2")).toBeVisible();
  await app.control.keyboard.press("ArrowRight");
  await expect(projector.getByText("puente dos")).toBeVisible();
  await app.control.keyboard.press("ArrowRight");
  await expect(projector.getByText("segunda")).toBeVisible();
  await expect(live.getByText("3/4")).toBeVisible();

  // T: only the background, and T again brings the words back.
  await app.control.keyboard.press("t");
  await expect(projector.getByText("segunda")).toBeHidden();
  await expect(live.getByText("Letra oculta")).toBeVisible();
  await app.control.keyboard.press("t");
  await expect(projector.getByText("segunda")).toBeVisible();

  // The same jumps by click.
  await live.getByRole("group", { name: "Secciones de la canción" }).getByRole("button", { name: "Estrofa 1" }).click({
    modifiers: ["Shift"],
  });
  await expect(projector.getByText("primera")).toBeVisible();
  await live.getByRole("button", { name: "Ocultar la letra (T)" }).click();
  await expect(projector.getByText("primera")).toBeHidden();
});

test("a theme edited in «Temas» dresses the live song, and the footer carries the church's licence", async ({ app }) => {
  const { control } = app;
  // The church's licence, in Ajustes ▸ Canciones.
  await control.getByRole("button", { name: "Configuración" }).click();
  const settings = control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Canciones" }).click();
  await settings.getByRole("textbox", { name: "Licencia CCLI de la iglesia" }).fill("998877");
  await settings.getByRole("textbox", { name: "Licencia CCLI de la iglesia" }).press("Enter");
  await settings.getByRole("button", { name: "Cerrar" }).first().click();

  await createSong(app, "Sublime gracia", GRACIA);
  await songRows(app).first().click();
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText("Sublime gracia del Señor")).toBeVisible();
  // The footer is on the last slide only (the default theme's choice).
  await expect(projector.locator("[data-song-footer]")).toHaveCount(0);
  await app.control.keyboard.press("c");
  await expect(projector.locator("[data-song-footer]")).toContainText("998877");

  // Capitals, saved in the theme, reach the slide on the projector in place.
  await tab(app).getByRole("button", { name: "Temas" }).click();
  const themes = control.getByRole("dialog", { name: "Temas" });
  await themes.getByRole("group", { name: "Mayúsculas", exact: true }).getByRole("switch").click();
  await themes.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(toast(app, "Se guardó «Predeterminado»")).toBeVisible();
  await themes.getByRole("button", { name: "Cerrar" }).first().click();
  await expect
    .poll(() => projector.locator("[data-song-block]").last().evaluate((el) => getComputedStyle(el).textTransform))
    .toBe("uppercase");
  await expect(projector.getByText("Aleluya, aleluya")).toBeVisible();
});
