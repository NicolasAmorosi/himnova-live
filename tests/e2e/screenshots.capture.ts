import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CDPSession, Page } from "@playwright/test";
import { DEFAULT_BIBLE_STYLE } from "../../src/shared/types/bible-style";
import type { MediaAsset } from "../../src/shared/types/media";
import { engineCanvas, expect, relaunch, test, type WorshipApp } from "./support/app";
import { ROOT, ffmpegBinary } from "./support/paths";
import { buildPdf } from "./support/pdf";
import { CM, buildPptx, type PptxSlideSpec } from "./support/pptx";

/**
 * `npm run screenshots`: the README's and the landing's pictures, taken off
 * the real app. Everything on screen is generated here and publishable —
 * public-domain hymns (Heber and Luther, both trans. Juan B. Cabrera), FFmpeg
 * gradients and tones and the bundled RV1909 — never a church's own decks. The
 * control window is laid out at a fixed 1600×1000 at 2×, whatever screen runs
 * this, so a re-run on any machine writes the same frames. Each feature also
 * gets a `-detail` crop, for a page that shows it next to a paragraph.
 */

const MEDIA = path.join(os.tmpdir(), "lumina-screenshots-media");
const OUT = path.join(ROOT, "docs/screenshots");
const THEMES = ["dark", "light"] as const;
const VERSE = "Ciertamente el bien y la misericordia me seguirán";

const media = (name: string) => path.join(MEDIA, name);

test.beforeAll(() => {
  fs.rmSync(MEDIA, { recursive: true, force: true });
  fs.mkdirSync(MEDIA, { recursive: true });
  // Rewritten whole, so a renamed or dropped shot never lingers.
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const run = (...args: string[]) => execFileSync(ffmpegBinary(), ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  // A slow diagonal sweep through three colours: a worship background loop.
  // Seeded, or the dithering differs on every run.
  const gradient = (colors: [string, string, string], size: string, seconds: number) => {
    const [width, height] = size.split("x");
    const [c0, c1, c2] = colors;
    return ["-f", "lavfi", "-i", `gradients=s=${size}:c0=${c0}:c1=${c1}:c2=${c2}:n=3:x0=0:y0=${height}:x1=${width}:y1=0:seed=5:d=${seconds}`];
  };
  const loop = (name: string, colors: [string, string, string]) =>
    run(...gradient(colors, "1280x720", 12), "-c:v", "libx264", "-pix_fmt", "yuv420p", media(name));
  const still = (name: string, colors: [string, string, string]) =>
    run(...gradient(colors, "1920x1080", 1), "-frames:v", "1", media(name));

  loop("Fondo adoración.mp4", ["0x0b1a33", "0x1d6f86", "0x0b1a33"]);
  loop("Amanecer.mp4", ["0x2a1446", "0xe07a3f", "0xf4c06a"]);
  loop("Cielo.mp4", ["0x0e2340", "0x3a6ea5", "0x7fb6d9"]);
  loop("Anuncios.mp4", ["0x3b2a5c", "0x9b5d8c", "0xf2a97e"]);
  still("Bienvenida.png", ["0x3b2a5c", "0x9b5d8c", "0xf2a97e"]);
  still("Fondo azul.png", ["0x0b1a33", "0x1f5a8a", "0x0e2340"]);
  still("Fondo cálido.png", ["0x2a1446", "0xe07a3f", "0xf4c06a"]);
  run("-f", "lavfi", "-i", "sine=frequency=330:duration=20", "-c:a", "libmp3lame", media("Música de ofrenda.mp3"));
  // Plays only once converted: long enough at 1080p to be caught converting.
  run(...gradient(["0x0b1a33", "0x1d6f86", "0x7fb6d9"], "1920x1080", 90), "-c:v", "mpeg4", "-q:v", "4", media("Testimonio.avi"));

  // A soft major chord to sing over, faded in and out. Named after nothing:
  // a track named like its deck is linked to it on its own.
  run(
    ...["-f", "lavfi", "-i", "sine=frequency=196:duration=60", "-f", "lavfi", "-i", "sine=frequency=247:duration=60"],
    ...["-f", "lavfi", "-i", "sine=frequency=294:duration=60"],
    ...["-filter_complex", "amix=inputs=3,afade=t=in:d=3,afade=t=out:st=56:d=4", "-c:a", "libmp3lame"],
    media("Pista instrumental.mp3"),
  );

  const convert = (name: string, format: "pptx" | "pdf", deck: Uint8Array | Buffer) =>
    fs.writeFileSync(media(`${name}.${format}`), deck);
  const navy = { background: "#14213d", color: "#ffffff", accent: "#9fc9cc" };
  convert("Santo, santo, santo", "pptx", presentation(navy, [
    { title: "Santo, santo, santo", credit: "Reginald Heber · trad. Juan B. Cabrera" },
    { lines: ["¡Santo! ¡Santo! ¡Santo! Señor omnipotente,", "siempre el labio mío loores te dará;", "¡Santo! ¡Santo! ¡Santo! te adoro reverente,", "Dios en tres Personas, bendita Trinidad."] },
    { lines: ["¡Santo! ¡Santo! ¡Santo! en numeroso coro,", "santos escogidos te adoran sin cesar,", "de alegría llenos, y sus coronas de oro", "rinden ante el trono y el cristalino mar."] },
    { lines: ["¡Santo! ¡Santo! ¡Santo! la inmensa muchedumbre", "de ángeles que cumplen tu santa voluntad,", "ante ti se postra bañada de tu lumbre,", "ante ti que has sido, que eres y serás."] },
    { lines: ["¡Santo! ¡Santo! ¡Santo! por más que estés velado,", "e imposible sea tu gloria contemplar,", "santo tú eres solo, y nada hay a tu lado", "en poder perfecto, pureza y caridad."] },
  ]));
  // Advances by itself, the way the hymnal decks a church already has do.
  convert("Castillo fuerte", "pptx", presentation({ background: "#3a1f12", color: "#fff6e8", accent: "#f2b66d" }, [
    { title: "Castillo fuerte", credit: "Martín Lutero · trad. Juan B. Cabrera" },
    { lines: ["Castillo fuerte es nuestro Dios,", "defensa y buen escudo.", "Con su poder nos librará", "en este trance agudo."] },
    { lines: ["Con furia y con afán", "acósanos Satán:", "por armas deja ver", "astucia y gran poder;", "cual él no hay en la tierra."] },
    { lines: ["Nuestro valor es nada aquí,", "con él todo es perdido;", "mas con nosotros luchará", "de Dios el escogido."] },
    { lines: ["Es nuestro Rey Jesús,", "el que venció en la cruz,", "Señor y Salvador,", "y siendo él solo Dios,", "él triunfa en la batalla."] },
  ], 12));
  convert("Anuncios de la semana", "pptx", presentation({ background: "#0f3b3e", color: "#ffffff", accent: "#8fd3cf" }, [
    { title: "Anuncios", credit: "Esta semana en la iglesia" },
    { title: "Reunión de jóvenes", credit: "Sábado · 18:00 · Salón principal" },
    { title: "Cena de camaradería", credit: "Domingo · 20:30 · Traé algo para compartir" },
  ]));
  convert("Bosquejo del sermón", "pdf", presentationPdf({ background: "#f6f1e7", color: "#14213d", accent: "#8a5a2b" }, [
    { title: "El Señor es mi pastor", credit: "Salmo 23" },
    { title: "1. Él me guía", credit: "«Junto á aguas de reposo me pastoreará» (v. 2)" },
    { title: "2. Él me acompaña", credit: "«Porque tú estarás conmigo» (v. 4)" },
  ]));
});

test("screenshots", async ({ app: first }) => {
  test.setTimeout(600_000);
  // The library a church would have, and verses over one of its backgrounds.
  // The verse style is read at startup, hence the relaunch.
  await first.invoke("library:add", {
    kind: "video",
    paths: ["Fondo adoración.mp4", "Amanecer.mp4", "Cielo.mp4"].map(media),
  });
  const [background] = await first.invoke<MediaAsset[]>("library:add", {
    kind: "image",
    paths: ["Fondo azul.png", "Fondo cálido.png"].map(media),
  });
  if (!background) throw new Error("import failed");
  await first.invoke("settings:set", {
    "bible.style": { ...DEFAULT_BIBLE_STYLE, background: { kind: "image", assetId: background.id, fit: "cover" } },
  });
  await first.quit();
  const app = await relaunch(first);
  const { control } = app;
  const screen = await layOut(control, 1600, 1000, 2);

  // A Saturday-night preparation: the whole order of service, saved.
  await app.openResources("Funciones", "Utilidades");
  await scenes(app).filter({ hasText: "Cuenta 10 minutos" }).click();
  await control.getByRole("tabpanel", { name: "Utilidades" }).getByRole("button", { name: "Agregar al programa" }).click();
  await app.answerOpenDialog(media("Bienvenida.png"), media("Santo, santo, santo.pptx"));
  await schedule(app).getByRole("button", { name: "Agregar medios" }).click();
  await app.openChapter("Salmos 23");
  await bible(app).getByRole("listitem").filter({ hasText: VERSE }).click();
  await bible(app).getByRole("button", { name: "Agregar al programa" }).click();
  await app.answerOpenDialog(media("Anuncios.mp4"), media("Música de ofrenda.mp3"));
  await schedule(app).getByRole("button", { name: "Agregar medios" }).click();
  await expect(rows(app)).toHaveCount(6);
  await control.getByRole("button", { name: "Guardar", exact: true }).click();
  const programs = control.getByRole("dialog", { name: "Programas" });
  await programs.getByRole("textbox", { name: "Nombre" }).fill("Culto de adoración");
  await programs.getByRole("button", { name: "Guardar", exact: true }).last().click();
  await programs.getByRole("button", { name: "Cerrar" }).click();

  // The hymn: its second slide on air, the next one waiting in PREVIEW.
  await rows(app).filter({ hasText: "Santo, santo, santo" }).click();
  const slides = app.previewColumn().getByRole("list", { name: "Presentación" });
  await expect(slides.getByRole("button", { name: "5", exact: true })).toBeVisible({ timeout: 120_000 });
  await slides.getByRole("button", { name: "2", exact: true }).click();
  await app.goLive();
  await slides.getByRole("button", { name: "3", exact: true }).click();
  await app.openResources("Media", "Videos");
  await shoot(app, screen, "control");

  // Decks as they were made: a hymn that advances by itself, with its music.
  await app.invoke("library:add", {
    kind: "ppt",
    paths: ["Bosquejo del sermón.pdf", "Anuncios de la semana.pptx", "Castillo fuerte.pptx"].map(media),
  });
  await app.openResources("Media", "Presentaciones");
  const decks = control.getByRole("tabpanel", { name: "Presentaciones" });
  for (const name of ["Bosquejo del sermón", "Anuncios de la semana", "Castillo fuerte"]) {
    await decks.getByRole("button", { name }).click();
    await expect(decks.getByRole("img", { name })).toBeVisible({ timeout: 120_000 });
  }
  const preview = app.previewColumn();
  await app.answerOpenDialog(media("Pista instrumental.mp3"));
  await preview.getByRole("button", { name: "Asignar audio" }).click();
  await expect(preview.getByRole("button", { name: "Cambiar", exact: true })).toBeVisible();
  await expect(preview.getByText("Auto-avance", { exact: true })).toBeVisible();
  await slides.getByRole("button", { name: "2", exact: true }).click();
  await app.goLive();
  await expect(app.liveColumn().getByText("Castillo fuerte (música)")).toBeVisible();
  await slides.getByRole("button", { name: "3", exact: true }).click();
  await shoot(app, screen, "decks", { x: 533, y: 0, width: 1067, height: 688 });

  // The reading: the psalm in the Bible tab, its last verse on air.
  await app.openChapter("Salmos 23");
  await bible(app).getByRole("listitem").filter({ hasText: VERSE }).click();
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText(VERSE, { exact: false })).toBeVisible();
  await shoot(app, screen, "bible", { x: 0, y: 88, width: 1066, height: 680 });
  const stage = await layOut(projector, 1920, 1080, 1);
  await settle(projector);
  await capture(stage, "projector");

  // Before the service: the countdown on air, the clock next in PREVIEW.
  await app.openResources("Funciones", "Utilidades");
  await scenes(app).filter({ hasText: "Cuenta 10 minutos" }).click();
  await app.goLive();
  await scenes(app).filter({ hasText: "Reloj" }).click();
  await expect(app.liveColumn().getByText("09:5", { exact: false }).first()).toBeVisible();
  await shoot(app, screen, "functions", { x: 533, y: 0, width: 1067, height: 600 });

  // The library: a background on air, and an AVI in PREVIEW, played by the media engine.
  await app.openResources("Media", "Videos");
  const videos = control.getByRole("tabpanel", { name: "Videos" });
  await videos.getByRole("button", { name: "Amanecer" }).dblclick();
  await app.invoke("library:add", { kind: "video", paths: [media("Testimonio.avi")] });
  await videos.getByRole("button", { name: "Testimonio" }).click();
  await expect.poll(async () => (await engineCanvas(control, "preview:"))?.width ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
  await shoot(app, screen, "media", { x: 533, y: 0, width: 1067, height: 600 });
});

const scenes = (app: WorshipApp) => app.control.getByRole("list", { name: "Escenas de tiempo" }).getByRole("listitem");
const bible = (app: WorshipApp) => app.control.getByRole("tabpanel", { name: "Biblia" });
const schedule = (app: WorshipApp) =>
  app.control.locator("section").filter({ has: app.control.getByRole("heading", { name: "Programa", exact: true }) });
const rows = (app: WorshipApp) => schedule(app).getByRole("list").first().getByRole("listitem");

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
async function capture(cdp: CDPSession, name: string, clip?: Clip) {
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "webp",
    quality: 90,
    ...(clip && { clip: { ...clip, scale: 1 } }),
  });
  fs.writeFileSync(path.join(OUT, `${name}.webp`), Buffer.from(data, "base64"));
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
async function shoot(app: WorshipApp, screen: CDPSession, name: string, detail?: Clip) {
  for (const theme of THEMES) {
    await app.control.evaluate((value) => (document.documentElement.dataset["theme"] = value), theme);
    await settle(app.control);
    await capture(screen, `${name}-${theme}`);
    if (detail) await capture(screen, `${name}-detail-${theme}`, detail);
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
            ? [{ text: slide.lines.join("\n"), size: 34, color: look.color, font: "Georgia", lineSpacing: 135 }]
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
