import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CDPSession, Page } from "@playwright/test";
import type { Locale } from "../../../src/shared/types/settings";
import { CONTENT, type Hymn } from "../screenshots.content";
import { expect } from "./app";
import { ROOT, ffmpegBinary } from "./paths";
import { buildPdf } from "./pdf";
import { CM, buildPptx, type PptxSlideSpec } from "./pptx";

/**
 * The demo a church would recognise, shared by `npm run screenshots` and
 * `npm run tutorials`: each language's own public-domain hymns, decks and
 * Bible (`screenshots.content.ts`) over media generated with FFmpeg, never a
 * church's own files.
 */

const MEDIA = path.join(os.tmpdir(), "himnova-screenshots-media");

/** The generated media, under names that mean nothing: each language copies
 *  them under its own. */
const raw = (name: string) => path.join(MEDIA, "raw", name);

/** Generates the media every language copies under its own names. */
export function generateDemoMedia(): void {
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
}


/** Copies the generated media under `locale`'s names and writes its decks and
 *  its Bible; answers the path of a file by that name. */
export function prepare(locale: Locale): (name: string) => string {
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
export const FORTRESS_CHORDS = ["C", "G", "F", "C", "Am", "G", "F", "G", "C"];

/** A hymn's stanzas as a song: each stanza one section, a slide per four
 *  lines; with `chords`, one at the start of each line, written inline. */
export function lyrics(hymn: Hymn, stanzas = hymn.stanzas, chords?: readonly string[]): string {
  return stanzas
    .map((written, index) => {
      const lines = chords ? written.map((line, at) => `[${chords[at % chords.length]}]${line}`) : written;
      return [`[Estrofa ${index + 1}]`, ...lines.slice(0, 4), ...(lines.length > 4 ? ["", ...lines.slice(4)] : [])].join("\n");
    })
    .join("\n\n");
}

/** Lays the page out at a fixed size and pixel ratio, whatever the window and
 *  the screen under it measure. Playwright's own screenshot would use the
 *  screen's ratio, so the frames are taken through the same session. */
export async function layOut(page: Page, width: number, height: number, deviceScaleFactor: number): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile: false });
  return cdp;
}

/** Waits until nothing on the page is still loading or announcing, with the
 *  pointer off every control. */
export async function settle(page: Page) {
  await page.mouse.move(800, 995);
  await expect(page.getByRole("status")).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(() => page.evaluate(() => [...document.images].every((img) => img.complete && img.naturalWidth > 0)))
    .toBe(true);
  await page.waitForTimeout(800);
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
