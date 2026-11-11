import fs from "node:fs";
import path from "node:path";
import type { CDPSession } from "@playwright/test";
import { parseLyrics, withTranslation } from "../../src/shared/song-text";
import type { BibleVersionDTO } from "../../src/shared/types/bible";
import mainEn from "../../src/main/i18n/messages/en";
import mainEs from "../../src/main/i18n/messages/es";
import mainIt from "../../src/main/i18n/messages/it";
import mainPt from "../../src/main/i18n/messages/pt";
import { LOCALES, type Locale } from "../../src/shared/types/settings";
import { engineCanvas, expect, relaunch, test, type WorshipApp } from "./support/app";
import { FORTRESS_CHORDS, generateDemoMedia, layOut, lyrics, prepare, settle } from "./support/demo";
import { ROOT } from "./support/paths";
import { CONTENT, type Hymn } from "./screenshots.content";

/**
 * `npm run screenshots`: the README's and the landing's pictures, taken off
 * the real app, once per language (`docs/screenshots/<locale>/`) — the
 * interface AND what is on it: each language's own public-domain hymns and
 * Bible (`screenshots.content.ts`), the backgrounds, themes and overlays the
 * app itself starts with (the starter look), FFmpeg tones, never a church's
 * own decks. The control window is laid out at a fixed 1600×1000 at
 * 2×, whatever screen runs this, so a re-run on any machine writes the same
 * frames. Each feature also gets a `-detail` crop, for a page that shows it
 * next to a paragraph.
 */

const OUT = path.join(ROOT, "docs/screenshots");
/** The starter look's names, as each language's install writes them. */
const LOOK: Record<Locale, (typeof mainEs)["look"]> = { es: mainEs.look, en: mainEn.look, it: mainIt.look, pt: mainPt.look };
const THEMES = ["dark", "light"] as const;

test.beforeAll(generateDemoMedia);

for (const locale of LOCALES) {
  test.describe(locale, () => {
    test.use({ appLocale: locale, starterLook: true });

    test(`screenshots (${locale})`, async ({ app: first }) => {
      test.setTimeout(600_000);
      const content = CONTENT[locale];
      const { files, decks, holy, fortress } = content;
      const media = prepare(locale);
      // Each language's folder rewritten whole, so a renamed or dropped shot
      // never lingers. Only its own: a failed test restarts the worker, and
      // this hook with it.
      const out = path.join(OUT, locale);
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      const tr = (text: string, vars?: Record<string, string>) => first.tr(text, vars);
      const psalm = `${content.bible?.psalms ?? "Salmos"} 23`;

      // The library, the song themes, the verse's look and the time scenes
      // are the starter look's: what a church finds on its first launch.
      // Luther's hymn carries another language's version as its translation, live in both at once.
      const sectionsOf = (text: string) => parseLyrics(text, "es").sections;
      const song = (hymn: Hymn, text: string, themeId: number | null, translation?: string) =>
        first.invoke("song:create", {
          title: hymn.title,
          number: null,
          authors: hymn.credit,
          copyright: content.copyright,
          ccliNumber: null,
          notes: null,
          // The section headers are this file's, in Spanish: a section is
          // stored by its kind, and the window names it in its own language.
          sections: translation ? withTranslation(sectionsOf(text), sectionsOf(translation)) : sectionsOf(text),
          order: [],
          themeId,
        });
      // With chords, for the musicians' screen: the hymn's own key, a chord at each line.
      await song(fortress, lyrics(fortress, fortress.stanzas, FORTRESS_CHORDS), null, lyrics(CONTENT[locale === "en" ? "es" : "en"].fortress));
      await song(holy, lyrics(holy, [holy.stanzas[0]!.slice(0, 2)]), null);
      // This language's Bible, opened by default.
      if (content.bible) {
        await first.answerOpenDialog(media("bible.xml"));
        const version = await first.invoke<BibleVersionDTO | null>("bible:import");
        if (!version) throw new Error("bible import failed");
        await first.invoke("settings:set", { "bible.defaultVersionId": version.id });
      }
      await first.quit();
      const app = await relaunch(first);
      const { control } = app;
      const screen = await layOut(control, 1600, 1000, 2);
      const shoot = (name: string, detail?: Clip) => shootThemes(app, screen, out, name, detail);
      const bible = control.getByRole("tabpanel", { name: tr("Biblia") });
      const scenes = control.getByRole("list", { name: tr("Escenas de tiempo") }).getByRole("listitem");
      const schedule = control.locator("section").filter({ has: control.getByRole("heading", { name: tr("Programa"), exact: true }) });
      const rows = schedule.getByRole("list").first().getByRole("listitem");
      const verse = bible.getByRole("listitem").filter({ hasText: content.verse });

      // A Saturday-night preparation: the whole order of service, saved.
      await app.openResources("Funciones", "Utilidades");
      await scenes.filter({ hasText: tr("Cuenta 10 minutos") }).click();
      await control.getByRole("tabpanel", { name: tr("Utilidades") }).getByRole("button", { name: tr("Agregar al programa") }).click();
      await app.answerOpenDialog(media(`${files.welcome}.webp`), media(`${holy.title}.pptx`));
      await schedule.getByRole("button", { name: tr("Agregar medios") }).click();
      await app.openChapter(psalm);
      await verse.click();
      await bible.getByRole("button", { name: tr("Agregar al programa") }).click();
      await app.answerOpenDialog(media(`${files.announcements}.mp4`), media(`${files.offering}.mp3`));
      await schedule.getByRole("button", { name: tr("Agregar medios") }).click();
      await expect(rows).toHaveCount(6);
      await control.getByRole("button", { name: tr("Guardar"), exact: true }).click();
      const programs = control.getByRole("dialog", { name: tr("Programas") });
      await programs.getByRole("textbox", { name: tr("Nombre") }).fill(content.program);
      await programs.getByRole("button", { name: tr("Guardar"), exact: true }).last().click();
      await programs.getByRole("button", { name: tr("Cerrar") }).click();

      // The hymn: its second slide on air, the next one waiting in PREVIEW.
      await rows.filter({ hasText: holy.title }).click();
      const slides = app.previewColumn().getByRole("list", { name: tr("Presentación") });
      await expect(slides.getByRole("button", { name: "5", exact: true })).toBeVisible({ timeout: 120_000 });
      await slides.getByRole("button", { name: "2", exact: true }).click();
      await app.goLive();
      await slides.getByRole("button", { name: "3", exact: true }).click();
      await app.openResources("Medios", "Videos");
      await shoot("control");

      // Decks as they were made: a hymn that advances by itself, with its music.
      await app.invoke("library:add", {
        kind: "ppt",
        paths: [`${decks.sermon.name}.pdf`, `${decks.announcements.name}.pptx`, `${fortress.title}.pptx`].map(media),
      });
      await app.openResources("Medios", "Presentaciones");
      const deckTab = control.getByRole("tabpanel", { name: tr("Presentaciones") });
      // Opened once each, so their tiles draw the first slide: a PDF's as an image, a .pptx from its model.
      const firstSlide = app.previewColumn().getByRole("list", { name: tr("Presentación") }).getByRole("button", { name: "1", exact: true });
      for (const name of [decks.sermon.name, decks.announcements.name, fortress.title]) {
        await deckTab.getByRole("button", { name }).click();
        await expect(firstSlide).toBeVisible({ timeout: 120_000 });
      }
      const preview = app.previewColumn();
      await app.answerOpenDialog(media(`${files.track}.mp3`));
      await preview.getByRole("button", { name: tr("Asignar audio"), exact: true }).click();
      await expect(preview.getByRole("button", { name: tr("Opciones del audio"), exact: true })).toBeVisible();
      await expect(preview.getByText(tr("Auto-avance"), { exact: true })).toBeVisible();
      await slides.getByRole("button", { name: "2", exact: true }).click();
      await app.goLive();
      await expect(app.liveColumn().getByText(tr("{title} (música)", { title: fortress.title }))).toBeVisible();
      await slides.getByRole("button", { name: "3", exact: true }).click();
      await shoot("decks", { x: 533, y: 0, width: 1067, height: 688 });

      // The reading: the psalm in the Bible tab, its last verse on air.
      await app.openChapter(psalm);
      await verse.click();
      await app.goLive();
      const projector = await app.projector();
      await expect(projector.getByText(content.verse, { exact: false })).toBeVisible();
      await shoot("bible", { x: 0, y: 88, width: 1066, height: 680 });
      const stage = await layOut(projector, 1920, 1080, 1);
      await settle(projector);
      await capture(stage, out, "projector");

      // A song: its slides drawn in PREVIEW, each with its section's name and
      // colour; the second on air, with a button per section under LIVE.
      await app.openResources("Canciones");
      await control.getByRole("tabpanel", { name: tr("Canciones") }).getByRole("listitem").filter({ hasText: fortress.title }).click();
      await app.goLive();
      await expect(projector.getByText(fortress.stanzas[0]![0]!)).toBeVisible();
      await control.keyboard.press("ArrowRight");
      await expect(projector.getByText(fortress.stanzas[0]![4]!)).toBeVisible();
      const songSlides = app.previewColumn().getByRole("list", { name: tr("Diapositivas de «{title}»", { title: fortress.title }) });
      await songSlides.getByRole("listitem").nth(2).getByRole("button").click();
      await shoot("songs", { x: 533, y: 0, width: 1067, height: 688 });

      // The musicians' screen, picked in Ajustes ▸ Proyección: the song's slide on air and the next.
      const stageOpened = app.electron.waitForEvent("window", { predicate: (page) => page.url().endsWith("/stage.html") });
      await control.getByRole("button", { name: tr("Configuración") }).click();
      const settings = control.getByRole("dialog", { name: tr("Configuración") });
      await settings.getByRole("tab", { name: tr("Proyección") }).click();
      await settings.getByRole("combobox", { name: tr("Pantalla de escenario") }).click();
      await control.getByRole("option").nth(1).click();
      await control.keyboard.press("Escape");
      const stageWindow = await stageOpened;
      const stageScreen = await layOut(stageWindow, 1920, 1080, 1);
      await expect(stageWindow.getByText(fortress.stanzas[0]![4]!)).toBeVisible();
      await settle(stageWindow);
      await capture(stageScreen, out, "stage");

      // Before the service: the countdown on air, the clock next in PREVIEW.
      await app.openResources("Funciones", "Utilidades");
      await scenes.filter({ hasText: tr("Cuenta 10 minutos") }).click();
      await app.goLive();
      await scenes.filter({ hasText: tr("Reloj") }).click();
      await expect(app.liveColumn().getByText("09:5", { exact: false }).first()).toBeVisible();
      await shoot("functions", { x: 533, y: 0, width: 1067, height: 600 });

      // The library: a background on air, and an AVI in PREVIEW, played by the media engine.
      await app.openResources("Medios", "Videos");
      const videos = control.getByRole("tabpanel", { name: tr("Videos") });
      await videos.getByRole("button", { name: LOOK[locale].backgrounds.sunrise }).first().dblclick();
      await app.invoke("library:add", { kind: "video", paths: [media(`${files.testimony}.avi`)] });
      await videos.getByRole("button", { name: files.testimony }).click();
      await expect.poll(async () => (await engineCanvas(control, "preview:"))?.width ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
      await shoot("media", { x: 533, y: 0, width: 1067, height: 600 });
    });
  });
}

type Clip = { x: number; y: number; width: number; height: number };

/** The whole page, or `clip` of it (CSS px), at the page's pixel ratio. WebP,
 *  not PNG: the same 2× frame at a fraction of the weight, for a README and a
 *  landing that load them over the network. */
async function capture(cdp: CDPSession, out: string, name: string, clip?: Clip) {
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "webp",
    quality: 90,
    ...(clip && { clip: { ...clip, scale: 1 } }),
  });
  fs.writeFileSync(path.join(out, `${name}.webp`), Buffer.from(data, "base64"));
}

/** The control window in each theme, switched the way Ajustes switches it,
 *  and `detail` of it when the feature has one. */
async function shootThemes(app: WorshipApp, screen: CDPSession, out: string, name: string, detail?: Clip) {
  for (const theme of THEMES) {
    await app.control.evaluate((value) => (document.documentElement.dataset["theme"] = value), theme);
    await settle(app.control);
    await capture(screen, out, `${name}-${theme}`);
    if (detail) await capture(screen, out, `${name}-detail-${theme}`, detail);
  }
  await app.control.evaluate(() => (document.documentElement.dataset["theme"] = "dark"));
}
