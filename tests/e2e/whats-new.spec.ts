// «Novedades» (owner, 2026-11-15, D4 and D5): shown once after an update, only to a profile that already existed; a
// new profile gets the welcome, with its «Sonido» step, and never both.
import { expect, relaunch, test, type WorshipApp } from "./support/app";

const LIGHTER_FADER =
  "El fader de EN VIVO y los controles del estilo del versículo van más livianos: ya no redibujan toda la ventana en cada paso.";
const SCREEN_ROLES =
  "Si Windows cambia el número de las pantallas al reiniciar, el proyector y el escenario siguen cada uno en la suya.";
const NEXT_IN_PREVIEW =
  "Al mandar EN VIVO una fila del programa, PREVIEW ya muestra la de abajo. Si preferís PREVIEW vacía, se apaga en Configuración ▸ Proyección.";
const STREAM_TAB = "El NDI® tiene su propia pestaña, Configuración ▸ Transmisión.";

// The suite skips it on every launch (`--no-whats-new`); here it runs as it does for a church.
test.use({ chromiumArgs: ["--whats-new"] });

const LIVE_STRIP = "Sonido de EN VIVO";
const PREVIEW_STRIP = "Sonido de PREVIEW";

const news = (app: WorshipApp) => app.control.getByRole("dialog", { name: "Novedades" });

/** What a screen that opens at launch would have done by now: it opens once the screens are listed, well under this. */
async function settled(app: WorshipApp): Promise<void> {
  await app.control.waitForTimeout(1500);
}

test("a profile from an older build sees «Novedades» once, and turning the strips off there hides them", async ({ app }) => {
  // A new profile is stamped with the latest at its first launch: nothing to tell it.
  await settled(app);
  await expect(news(app)).toHaveCount(0);
  await expect(app.control.getByRole("group", { name: LIVE_STRIP })).toBeVisible();

  // The same profile, as 2.9 left it.
  await app.invoke("settings:set", { "ui.whatsNewSeen": "2.9" });
  await app.quit();
  const updated = await relaunch(app);
  const shown = news(updated);
  await expect(shown).toBeVisible();
  // 2.9 straight to the latest: told what 2.10 brought too, before what came after it.
  await expect(shown.getByText("Lo nuevo desde la 2.10")).toBeVisible();
  await expect(shown.getByRole("heading", { name: "Una pantalla para el escenario" })).toBeVisible();

  // The stage's own view, playing by itself: the count, then a message from the ready phrases.
  const stage = shown.getByRole("img", { name: "Lo que se ve en el escenario" });
  // The demo is a picture for assistive tech: its count and band are hidden from the tree, not from the eye.
  await expect(stage.getByRole("timer")).toHaveCount(0);
  await expect(stage.getByRole("timer", { includeHidden: true })).toBeVisible();
  await expect(stage.locator('[data-layout="preacher"]')).toBeVisible();
  await expect(stage.getByRole("status", { includeHidden: true })).toHaveText("Ir cerrando", { timeout: 10_000 });
  await shown.getByRole("button", { name: "Músicos" }).click();
  await expect(stage.locator('[data-layout="musicians"]')).toBeVisible();

  // Settings ▸ Screens opens over it, and closing it gives «Novedades» back.
  await shown.getByRole("button", { name: "Elegir la pantalla del escenario" }).click();
  const settings = updated.control.getByRole("dialog", { name: "Configuración" });
  await expect(settings.getByRole("tab", { name: "Pantallas" })).toHaveAttribute("aria-selected", "true");
  await settings.getByRole("button", { name: "Volver" }).click();
  await expect(settings).toBeHidden();
  await expect(shown).toBeVisible();

  // «Sonido»: the strips come on (D5), the sample strip's meter moves, and the switch is the setting itself.
  await shown.getByRole("button", { name: "Siguiente: Sonido" }).click();
  const strips = shown.getByRole("switch", { name: "Mostrar las tiras" });
  await expect(strips).toBeChecked();
  const sample = shown.getByRole("group", { name: "Tira de muestra: EN VIVO" });
  await expect.poll(() => sample.locator("canvas").getAttribute("data-level-db-l")).not.toBe("-inf");
  await strips.click();
  await expect(sample).toHaveCount(0);
  await expect(shown.getByRole("slider", { name: "Volumen de muestra: EN VIVO" })).toBeVisible();

  await shown.getByRole("button", { name: "Siguiente: PREVIEW" }).click();
  await expect(shown.getByRole("heading", { name: "Lo que sale al aire se va de PREVIEW" })).toBeVisible();
  await shown.getByRole("button", { name: "Siguiente: Resumen" }).click();
  await expect(shown.getByText("Sin tiras · Salidas: predeterminada del sistema")).toBeVisible();
  // Each version's smaller changes, in one list.
  await expect(shown.getByText("El volumen inicial se mudó a Configuración ▸ Sonido.")).toBeVisible();
  await expect(shown.getByText("Un Enter de más sobre el himno al aire ya no lo vuelve a empezar.")).toBeVisible();
  await shown.getByRole("button", { name: "Listo", exact: true }).click();
  await expect(shown).toBeHidden();
  // The work screen took it: no strip, and each row's own volume is back.
  await expect(updated.control.getByRole("group", { name: LIVE_STRIP })).toHaveCount(0);
  await expect(updated.control.getByRole("group", { name: PREVIEW_STRIP })).toHaveCount(0);

  // Once: the next launch goes straight to work, with the strips still off.
  await updated.quit();
  const again = await relaunch(updated);
  await settled(again);
  await expect(news(again)).toHaveCount(0);
  await expect(again.control.getByRole("group", { name: LIVE_STRIP })).toHaveCount(0);
});

test("a profile that saw 2.10 is told only what came after: what goes live leaves PREVIEW", async ({ app }) => {
  await app.invoke("settings:set", { "ui.whatsNewSeen": "2.10" });
  await app.quit();
  const updated = await relaunch(app);
  const shown = news(updated);
  await expect(shown).toBeVisible();
  await expect(shown.getByText("Lo nuevo desde la 2.11")).toBeVisible();
  await expect(shown.getByRole("heading", { name: "Lo que sale al aire se va de PREVIEW" })).toBeVisible();
  await expect(shown.getByRole("heading", { name: "Una pantalla para el escenario" })).toHaveCount(0);

  // The work screen's two monitors play it by themselves: a verse picked, then sent, and PREVIEW is left empty.
  const demo = shown.getByRole("img", { name: "PREVIEW y EN VIVO mientras se mandan dos versículos" });
  await expect(demo.getByText("Lo mandás: pasa a EN VIVO y PREVIEW queda vacía.")).toBeVisible({ timeout: 8_000 });
  await expect(demo.getByText("Nada en PREVIEW")).toBeVisible();

  // Its summary: no 2.10 settings to go back to, only what else changed.
  await shown.getByRole("button", { name: "Siguiente: Resumen" }).click();
  await expect(shown.getByText("Un Enter de más sobre el himno al aire ya no lo vuelve a empezar.")).toBeVisible();
  await expect(shown.getByText("El volumen inicial se mudó a Configuración ▸ Sonido.")).toHaveCount(0);
  await expect(shown.getByRole("button", { name: "Configurar: Escenario" })).toHaveCount(0);
  await expect(shown.getByText("Si dejás EN VIVO en silencio, la app vuelve a abrir en silencio.")).toBeVisible();
  // After 2.11's step, the summary still closes the tour.
  await expect(shown.getByRole("heading", { name: "Eso es todo" })).toBeVisible();
  await shown.getByRole("button", { name: "Listo", exact: true }).click();
  await expect(shown).toBeHidden();
});

test("a profile that saw 2.11 is told 2.12's to 2.15's smaller changes, in one summary alone", async ({ app }) => {
  await app.invoke("settings:set", { "ui.whatsNewSeen": "2.11" });
  await app.quit();
  const updated = await relaunch(app);
  const shown = news(updated);
  await expect(shown).toBeVisible();
  await expect(shown.getByText("Lo nuevo desde la 2.12")).toBeVisible();
  // Its one page opens the list rather than closing a tour.
  await expect(shown.getByRole("heading", { name: "Lo que cambió" })).toBeVisible();
  // Several versions' changes are not «En esta versión», which this list said until 2.13.
  await expect(shown.getByText("En estas versiones", { exact: true })).toBeVisible();
  await expect(shown.getByRole("heading", { name: "Eso es todo" })).toHaveCount(0);
  await expect(shown.getByRole("heading", { name: "Lo que sale al aire se va de PREVIEW" })).toHaveCount(0);
  await expect(shown.getByText("Si dejás EN VIVO en silencio, la app vuelve a abrir en silencio.")).toBeVisible();
  await expect(shown.getByText("Elegir una versión «En paralelo» con un versículo al aire la muestra ahí mismo.")).toBeVisible();
  await expect(shown.getByText(LIGHTER_FADER)).toBeVisible();
  await expect(shown.getByText(NEXT_IN_PREVIEW)).toBeVisible();
  await expect(shown.getByText(STREAM_TAB)).toBeVisible();
  await expect(shown.getByText("Un Enter de más sobre el himno al aire ya no lo vuelve a empezar.")).toHaveCount(0);
  await shown.getByRole("button", { name: "Listo", exact: true }).click();
  await expect(shown).toBeHidden();
});

test("a profile that saw 2.12 is told 2.12.1's to 2.15's smaller changes", async ({ app }) => {
  await app.invoke("settings:set", { "ui.whatsNewSeen": "2.12" });
  await app.quit();
  const updated = await relaunch(app);
  const shown = news(updated);
  await expect(shown).toBeVisible();
  await expect(shown.getByText("Lo nuevo desde la 2.12.1")).toBeVisible();
  await expect(shown.getByRole("heading", { name: "Lo que cambió" })).toBeVisible();
  await expect(shown.getByText("En estas versiones", { exact: true })).toBeVisible();
  await expect(shown.getByText(SCREEN_ROLES)).toBeVisible();
  await expect(shown.getByText(LIGHTER_FADER)).toBeVisible();
  await expect(shown.getByText("Si dejás EN VIVO en silencio, la app vuelve a abrir en silencio.")).toHaveCount(0);
  await shown.getByRole("button", { name: "Listo", exact: true }).click();
  await expect(shown).toBeHidden();
});

test("a profile that saw 2.14 is told only 2.15's smaller changes, «En esta versión»", async ({ app }) => {
  await app.invoke("settings:set", { "ui.whatsNewSeen": "2.14" });
  await app.quit();
  const updated = await relaunch(app);
  const shown = news(updated);
  await expect(shown).toBeVisible();
  await expect(shown.getByText("Lo nuevo de la 2.15")).toBeVisible();
  await expect(shown.getByText("En esta versión", { exact: true })).toBeVisible();
  await expect(shown.getByText(STREAM_TAB)).toBeVisible();
  await expect(shown.getByText(NEXT_IN_PREVIEW)).toHaveCount(0);
  await shown.getByRole("button", { name: "Listo", exact: true }).click();
  await expect(shown).toBeHidden();
});

test.describe("a new profile", () => {
  test.use({ welcome: true });

  test("gets the welcome with its «Sonido» step and never «Novedades», which Settings ▸ About still opens", async ({ app }) => {
    const welcome = app.control.getByRole("dialog", { name: "Bienvenida" });
    await expect(welcome).toBeVisible();
    await expect(news(app)).toHaveCount(0);

    // Right after «Al terminar», with the strips checked (D5).
    await welcome.getByRole("tab", { name: "Al terminar" }).click();
    await welcome.getByRole("button", { name: "Siguiente: Sonido" }).click();
    await expect(welcome.getByRole("heading", { name: "Sonido", exact: true })).toBeVisible();
    await expect(welcome.getByRole("switch", { name: "Mostrar las tiras" })).toBeChecked();
    await expect(welcome.getByRole("combobox", { name: "Salida de EN VIVO" })).toHaveText(/^(Predeterminada del|Del) sistema/);
    await expect(welcome.getByRole("group", { name: "Tira de muestra: EN VIVO" })).toBeVisible();

    await welcome.getByRole("tab", { name: "Listo" }).click();
    await expect(welcome.getByText("Con tiras · Salidas: predeterminada del sistema")).toBeVisible();
    await welcome.getByRole("button", { name: "Empezar", exact: true }).click();
    await expect(welcome).toBeHidden();
    await expect(app.control.getByRole("group", { name: LIVE_STRIP })).toBeVisible();

    await app.quit();
    const again = await relaunch(app);
    await settled(again);
    await expect(again.control.getByRole("dialog", { name: "Bienvenida" })).toHaveCount(0);
    await expect(news(again)).toHaveCount(0);

    // By hand, any time.
    await again.control.getByRole("button", { name: "Configuración" }).click();
    const settings = again.control.getByRole("dialog", { name: "Configuración" });
    await settings.getByRole("tab", { name: "Acerca de" }).click();
    await settings.getByRole("button", { name: "Ver novedades" }).click();
    await expect(news(again)).toBeVisible();
    await expect(settings).toBeHidden();
    // The latest (2.15) is a summary alone: its one step is the last, closed by finishing it.
    await news(again).getByRole("button", { name: "Listo", exact: true }).click();
    await expect(news(again)).toHaveCount(0);
  });
});
