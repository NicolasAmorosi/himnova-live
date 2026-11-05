import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CDPSession, Page } from "@playwright/test";
import { parseLyrics, withTranslation } from "../../src/shared/song-text";
import type { BibleVersionDTO } from "../../src/shared/types/bible";
import mainEn from "../../src/main/i18n/messages/en";
import mainEs from "../../src/main/i18n/messages/es";
import mainIt from "../../src/main/i18n/messages/it";
import mainPt from "../../src/main/i18n/messages/pt";
import { LOCALES, type Locale } from "../../src/shared/types/settings";
import { engineCanvas, expect, relaunch, test, type WorshipApp } from "./support/app";
import { ROOT, ffmpegBinary } from "./support/paths";
import { buildPdf } from "./support/pdf";
import { CM, buildPptx, type PptxSlideSpec } from "./support/pptx";
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

const MEDIA = path.join(os.tmpdir(), "lumina-screenshots-media");
const OUT = path.join(ROOT, "docs/screenshots");
/** The starter look's names, as each language's install writes them. */
const LOOK: Record<Locale, (typeof mainEs)["look"]> = { es: mainEs.look, en: mainEn.look, it: mainIt.look, pt: mainPt.look };
const THEMES = ["dark", "light"] as const;

/** The generated media, under names that mean nothing: each language copies
 *  them under its own. */
const raw = (name: string) => path.join(MEDIA, "raw", name);

test.beforeAll(() => {
  fs.rmSync(MEDIA, { recursive: true, force: true });
  fs.mkdirSync(path.join(MEDIA, "raw"), { recursive: true });

  const run = (...args: string[]) => execFileSync(ffmpegBinary(), ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  // A slow diagonal sweep through three colours: a worship background loop.
  // Seeded, or the dithering differs on every run.
  const gradient = (colors: [string, string, string], size: string, seconds: number) => {
    const [width, height] = size.split("x");
    const [c0, c1, c2] = colors;
    return ["-f", "lavfi", "-i", `gradients=s=${size}:c0=${c0}:c1=${c1}:c2=${c2}:n=3:x0=0:y0=${height}:x1=${width}:y1=0:seed=5:d=${seconds}`];
  };

  // The welcome and the announcements over the app's own «dusk» background,
  // the one a church finds in its library from the first launch.
  fs.copyFileSync(path.join(ROOT, "resources", "backgrounds", "dusk.webp"), raw("welcome.webp"));
  fs.copyFileSync(path.join(ROOT, "resources", "backgrounds", "dusk.mp4"), raw("announcements.mp4"));
  run("-f", "lavfi", "-i", "sine=frequency=330:duration=20", "-c:a", "libmp3lame", raw("offering.mp3"));
  // MPEG-4 part 2 in an AVI: Chromium cannot play it, the media engine does.
  run(...gradient(["0x0b1a33", "0x1d6f86", "0x7fb6d9"], "1920x1080", 90), "-c:v", "mpeg4", "-q:v", "4", raw("testimony.avi"));
  // A soft major chord to sing over, faded in and out. Named after nothing:
  // a track named like its deck is linked to it on its own.
  run(
    ...["-f", "lavfi", "-i", "sine=frequency=196:duration=60", "-f", "lavfi", "-i", "sine=frequency=247:duration=60"],
    ...["-f", "lavfi", "-i", "sine=frequency=294:duration=60"],
    ...["-filter_complex", "amix=inputs=3,afade=t=in:d=3,afade=t=out:st=56:d=4", "-c:a", "libmp3lame"],
    raw("track.mp3"),
  );
});

/** Copies the generated media under `locale`'s names and writes its decks and
 *  its Bible; answers the path of a file by that name. */
function prepare(locale: Locale): (name: string) => string {
  const dir = path.join(MEDIA, locale);
  fs.mkdirSync(dir, { recursive: true });
  const media = (name: string) => path.join(dir, name);
  const { decks, files, bible } = CONTENT[locale];
  for (const [key, name] of Object.entries(files)) {
    const source = fs.readdirSync(path.join(MEDIA, "raw")).find((file) => file.startsWith(`${key}.`));
    if (!source) throw new Error(`no generated media for «${key}»`);
    fs.copyFileSync(raw(source), media(`${name}${path.extname(source)}`));
  }

  const holy = CONTENT[locale].holy;
  const fortress = CONTENT[locale].fortress;
  fs.writeFileSync(media(`${holy.title}.pptx`), presentation({ background: "#14213d", color: "#ffffff", accent: "#9fc9cc" }, [
    { title: holy.title, credit: holy.credit },
    ...holy.stanzas.map((lines) => ({ lines })),
  ]));
  // Advances by itself, the way the hymnal decks a church already has do.
  fs.writeFileSync(media(`${fortress.title}.pptx`), presentation({ background: "#3a1f12", color: "#fff6e8", accent: "#f2b66d" }, [
    { title: fortress.title, credit: fortress.credit },
    ...fortress.stanzas.flatMap((stanza) => [{ lines: stanza.slice(0, 4) }, { lines: stanza.slice(4) }]),
  ], 12));
  fs.writeFileSync(
    media(`${decks.announcements.name}.pptx`),
    presentation({ background: "#0f3b3e", color: "#ffffff", accent: "#8fd3cf" }, decks.announcements.slides),
  );
  fs.writeFileSync(
    media(`${decks.sermon.name}.pdf`),
    presentationPdf({ background: "#f6f1e7", color: "#14213d", accent: "#8a5a2b" }, decks.sermon.slides),
  );

  if (bible) {
    const verses = bible.psalm23.map((text, index) => `<VERS vnumber="${index + 1}">${text}</VERS>`).join("");
    fs.writeFileSync(
      media("bible.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<XMLBIBLE biblename="${bible.name}"><BIBLEBOOK bnumber="19" bname="${bible.psalms}"><CHAPTER cnumber="23">${verses}</CHAPTER></BIBLEBOOK></XMLBIBLE>`,
    );
  }
  return media;
}

/** «Ein feste Burg» in C, one chord at the start of each line. */
const FORTRESS_CHORDS = ["C", "G", "F", "C", "Am", "G", "F", "G", "C"];

/** A hymn's stanzas as a song: each stanza one section, a slide per four
 *  lines; with `chords`, one at the start of each line, written inline. */
function lyrics(hymn: Hymn, stanzas = hymn.stanzas, chords?: readonly string[]): string {
  return stanzas
    .map((written, index) => {
      const lines = chords ? written.map((line, at) => `[${chords[at % chords.length]}]${line}`) : written;
      return [`[Estrofa ${index + 1}]`, ...lines.slice(0, 4), ...(lines.length > 4 ? ["", ...lines.slice(4)] : [])].join("\n");
    })
    .join("\n\n");
}

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

/** Lays the page out at a fixed size and pixel ratio, whatever the window and
 *  the screen under it measure. Playwright's own screenshot would use the
 *  screen's ratio, so the frames are taken through the same session. */
async function layOut(page: Page, width: number, height: number, deviceScaleFactor: number): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile: false });
  return cdp;
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

/** Waits until nothing on the page is still loading or announcing, with the
 *  pointer off every control. */
async function settle(page: Page) {
  await page.mouse.move(800, 995);
  await expect(page.getByRole("status")).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(() => page.evaluate(() => [...document.images].every((img) => img.complete && img.naturalWidth > 0)))
    .toBe(true);
  await page.waitForTimeout(800);
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

type Slide = { title: string; credit: string } | { lines: string[] };
type Look = { background: string; color: string; accent: string };

/** One centred text box a slide, `color` on `background`. With `advance`,
 *  every slide moves on after that many seconds, with a fade. */
function presentation(look: Look, slides: Slide[], advance?: number): Uint8Array {
  const specs = slides.map(
    (slide): PptxSlideSpec => ({
      background: look.background,
      text: {
        box: [1.5 * CM, 1.5 * CM, 25 * CM, 12.75 * CM],
        paragraphs:
          "lines" in slide
            ? // A stanza of eight short lines (the Italian «Santo») in a smaller size, so it fits.
              [{ text: slide.lines.join("\n"), size: slide.lines.length > 5 ? 26 : 34, color: look.color, font: "Georgia", lineSpacing: 135 }]
            : [
                { text: slide.title, size: 60, color: look.color, font: "Georgia" },
                { text: slide.credit, size: 22, color: look.accent, font: "Georgia", italic: true, spaceBefore: 17 },
              ],
      },
      ...(advance ? { advanceMs: advance * 1000 } : {}),
    }),
  );
  return buildPptx(specs);
}

/** The same title-and-credit slides as a PDF's pages. */
function presentationPdf(look: Look, slides: { title: string; credit: string }[]): Buffer {
  return buildPdf(
    slides.map(() => look.background),
    slides.map((slide) => [
      { text: slide.title, size: 64, y: 290, color: look.color },
      { text: slide.credit, size: 26, y: 220, color: look.accent, italic: true },
    ]),
  );
}
