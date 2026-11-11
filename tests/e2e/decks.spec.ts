import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import Database from "better-sqlite3";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { MediaAsset } from "../../src/shared/types/media";
import { SLIDES_CONVERTER_VERSION } from "../../src/shared/constants";
import { fixture } from "./support/paths";
import { buildPdf } from "./support/pdf";
import { CM, buildPptx } from "./support/pptx";
import { compoundFile } from "../fixtures/legacy-ppt";
import { audioStates, engineCanvas, expect, moving, msUntilChange, relaunch, test, videoStates, type WorshipApp } from "./support/app";

/** A slide in the centre grid, once the deck is read. */
const slideTile = (app: WorshipApp, n: number) =>
  app.previewColumn().getByRole("list", { name: "Presentación" }).getByRole("button", { name: String(n), exact: true });

/** The same slide in the LIVE column's grid, which only exists while the deck
 *  is on the projector. */
const liveSlideTile = (app: WorshipApp, n: number) =>
  app.liveColumn().getByRole("list", { name: "Presentación" }).getByRole("button", { name: String(n), exact: true });

/** What paints a deck's slide on the projector: its image, or its model once
 *  drawn (`data-slide-model`, a `.pptx`). Both urls end in the slide number,
 *  a model's then `/model`. */
const SLIDE_SELECTOR = 'img[src^="worship://deck/"], [data-slide-model^="worship://deck/"]';
const SLIDE_NUMBER = /\/(\d+)(?:\/model)?$/;

/** The slide the projector shows now: the topmost deck image. */
function projectedSlide(projector: Page): Promise<number | null> {
  return projector.evaluate(
    ([selector, number]) => {
      const last = [...document.querySelectorAll<HTMLElement>(selector)].at(-1);
      const url = last instanceof HTMLImageElement ? last.src : (last?.dataset["slideModel"] ?? "");
      const match = new RegExp(number).exec(url);
      return match ? Number(match[1]) : null;
    },
    [SLIDE_SELECTOR, SLIDE_NUMBER.source] as const,
  );
}

test("a PDF is a deck: drawn page by page, projected, stepped", async ({ app }) => {
  await app.addMedia("ppt", "deck.pdf");
  await app.previewFile("Presentaciones", "deck");
  // Its three pages in the centre grid.
  await expect(slideTile(app, 3)).toBeVisible({ timeout: 60_000 });

  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projectedSlide(projector)).toBe(1);
  await app.control.keyboard.press("ArrowRight");
  await expect.poll(() => projectedSlide(projector)).toBe(2);
  await app.control.keyboard.press("ArrowLeft");
  await expect.poll(() => projectedSlide(projector)).toBe(1);
});

test("a deck cached by an older converter is reconverted before it goes live, never under it", async ({ app }) => {
  await app.addMedia("ppt", "deck.pdf");
  await app.previewFile("Presentaciones", "deck");
  await expect(slideTile(app, 3)).toBeVisible({ timeout: 60_000 });
  await app.quit();

  // What every deck converted before a `SLIDES_CONVERTER_VERSION` bump looks like.
  const dbPath = path.join(app.profile, "worship.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE slide_decks SET converter_version = ?").run(SLIDES_CONVERTER_VERSION - 1);
  db.close();

  const again = await relaunch(app);
  await again.previewFile("Presentaciones", "deck");
  await expect(slideTile(again, 3)).toBeVisible({ timeout: 60_000 });
  await again.goLive();
  const projector = await again.projector();
  await expect.poll(() => projectedSlide(projector)).toBe(1);

  // The upgrade has landed: the old row is gone, replaced by the new one.
  const outdated = () => {
    const ro = new Database(dbPath, { readonly: true });
    try {
      const row = ro.prepare("SELECT count(*) AS n FROM slide_decks WHERE converter_version < ?").get(SLIDES_CONVERTER_VERSION);
      return (row as { n: number }).n;
    } finally {
      ro.close();
    }
  };
  await expect.poll(outdated, { timeout: 60_000 }).toBe(0);

  // The last slide still loads. It used to be `worship://deck/<replaced id>/3`,
  // a 404 under the projector — the user's "the last slides never load".
  await again.control.keyboard.press("ArrowRight");
  await again.control.keyboard.press("ArrowRight");
  await expect.poll(() => projectedSlide(projector)).toBe(3);
  await expect
    .poll(() =>
      projector.evaluate(() => {
        const image = [...document.querySelectorAll<HTMLImageElement>('img[src^="worship://deck/"]')].at(-1);
        return image?.complete ? image.naturalWidth : 0;
      }),
    )
    .toBeGreaterThan(0);
});

test("NEGRO over a deck, and the slide is still there underneath", async ({ app }) => {
  await app.addMedia("ppt", "deck.pdf");
  await app.previewFile("Presentaciones", "deck");
  await expect(slideTile(app, 3)).toBeVisible({ timeout: 60_000 });
  await app.goLive();
  const projector = await app.projector();
  // On screen first, as the operator sees it: EN VIVO commits once the
  // projector it opens has mounted, and a key pressed before that has no live
  // deck to step yet (on a slow machine, a lost press).
  await expect.poll(() => projectedSlide(projector)).toBe(1);
  await app.control.keyboard.press("ArrowRight");
  await expect.poll(() => projectedSlide(projector)).toBe(2);

  await app.control.keyboard.press("b");
  await expect.poll(() => projectedSlide(projector)).toBeNull();
  await app.control.keyboard.press("b");
  await expect.poll(() => projectedSlide(projector)).toBe(2);
});

test("a .pptx with timings advances by itself", async ({ app }) => {
  await app.addMedia("ppt", "hymn.pptx");
  await app.previewFile("Presentaciones", "hymn");
  await expect(slideTile(app, 3)).toBeVisible({ timeout: 90_000 });

  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projectedSlide(projector)).toBe(1);
  // Two seconds a slide, from the deck's own timings: slide 2's whole time, measured (slide 1's began before we looked).
  expect((await msUntilChange(() => projectedSlide(projector), 1, 8_000)).value).toBe(2);
  const second = await msUntilChange(() => projectedSlide(projector), 2, 8_000);
  expect(second.value).toBe(3);
  expect(second.ms).toBeGreaterThan(1_700);
  expect(second.ms).toBeLessThan(2_400);
});

test("the EN VIVO that opens the projector still gives slide 1 its whole time", async ({ app }) => {
  await app.addMedia("ppt", "hymn.pptx");
  await app.previewFile("Presentaciones", "hymn");
  await expect(slideTile(app, 3)).toBeVisible({ timeout: 90_000 });
  // A slow machine, made deterministic: the projector's page takes 3 s to
  // load, longer than the 2 s slide 1 is timed for. Its clock used to start
  // at the press, so slide 1 was gone before the projector could show it.
  await app.electron.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      if (details.url.includes("projection.html")) setTimeout(() => callback({}), 3000);
      else callback({});
    });
  });
  await app.goLive();
  const projector = await app.projector();
  // When each slide was first painted, in the projector's own clock. A model
  // is only in the DOM once drawn (fonts and pictures ready); an image once decoded.
  const shown = await projector.evaluate(
    async ([selector, number]) => {
      const at: Record<number, number> = {};
      const start = performance.now();
      while (at[2] === undefined && performance.now() - start < 8000) {
        const last = [...document.querySelectorAll<HTMLElement>(selector)]
          .filter((el) => !(el instanceof HTMLImageElement) || (el.complete && el.naturalWidth > 0))
          .at(-1);
        const url = last instanceof HTMLImageElement ? last.src : (last?.dataset["slideModel"] ?? "");
        const slide = Number(new RegExp(number).exec(url)?.[1]);
        if (slide && at[slide] === undefined) at[slide] = performance.now();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return at;
    },
    [SLIDE_SELECTOR, SLIDE_NUMBER.source] as const,
  );
  expect(shown[1], "slide 1 was never shown").toBeDefined();
  expect(shown[2]! - shown[1]!).toBeGreaterThan(1700);
});

test("a WMV embedded in a .pptx slide plays through the media engine on its slide", async ({ app }) => {
  await app.addMedia("ppt", "clipdeck.pptx");
  await app.previewFile("Presentaciones", "clipdeck");
  await expect(slideTile(app, 1)).toBeVisible({ timeout: 90_000 });

  // Main hands the clip to the engine and announces it (`deck-updated`), so
  // the renderer re-reads a deck that now has a video. Nothing is converted.
  await expect.poll(() => app.log.some((line) => line.includes("[engine] slide clip")), { timeout: 60_000 }).toBe(true);
  await app.control.waitForTimeout(1000);

  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await engineCanvas(projector, "slideVideo:"))?.width ?? 0).toBe(640);
  await expect.poll(() => moving(projector, "slideVideo:")).toBe(true);
  // The LIVE monitor draws the projector's own frames, and no <video> is left.
  await expect.poll(() => moving(app.control, "slideVideo:")).toBe(true);
  expect(await videoStates(projector)).toEqual([]);

  // NEGRO holds it where it is: covered for longer than the whole 4 s clip,
  // it still has the rest to play once uncovered.
  await app.control.locator("body").press("b");
  await expect.poll(() => moving(projector, "slideVideo:")).toBe(false);
  await app.control.waitForTimeout(4500);
  await app.control.locator("body").press("b");
  await expect.poll(() => moving(projector, "slideVideo:")).toBe(true);

  // Once it ends it stays on its last frame, and uncovering does not play it again.
  await expect.poll(() => moving(projector, "slideVideo:"), { timeout: 10_000 }).toBe(false);
  await app.control.locator("body").press("b");
  await app.control.waitForTimeout(500);
  await app.control.locator("body").press("b");
  await app.control.waitForTimeout(500);
  expect(await moving(projector, "slideVideo:")).toBe(false);
});

test("after a restart, a deck prepared before still plays its WMV through the engine", async ({ app }) => {
  await app.addMedia("ppt", "clipdeck.pptx");
  await app.previewFile("Presentaciones", "clipdeck");
  await expect.poll(() => app.log.some((line) => line.includes("[engine] slide clip")), { timeout: 60_000 }).toBe(true);
  await app.quit();

  // Which clips the engine plays is known only in memory: the cached deck,
  // opened with a bare peek, has to be looked at again in this launch.
  const again = await relaunch(app);
  await again.previewFile("Presentaciones", "clipdeck");
  await expect.poll(() => again.log.some((line) => line.includes("[engine] slide clip")), { timeout: 30_000 }).toBe(true);
  await again.control.waitForTimeout(1000);
  await again.goLive();
  const projector = await again.projector();
  await expect.poll(() => moving(projector, "slideVideo:")).toBe(true);
});

test("a clip an older build converted goes back to its original, and every old copy is deleted", async ({ app }) => {
  await app.addMedia("ppt", "clipdeck.pptx");
  await app.previewFile("Presentaciones", "clipdeck");
  await expect.poll(() => app.log.some((line) => line.includes("[engine] slide clip")), { timeout: 60_000 }).toBe(true);
  await app.quit();

  // What a build before step 1.4 of the engine plan left: the clip's row on a playable copy made
  // next to its original, and a library file's copy in `converted-media/`.
  const dbPath = path.join(app.profile, "worship.db");
  const db = new Database(dbPath);
  const clip = db
    .prepare("SELECT v.id, v.video_file AS file, d.cache_dir AS dir FROM deck_videos v JOIN slide_decks d ON d.id = v.deck_id")
    .get() as { id: number; file: string; dir: string };
  const copy = path.join(clip.dir, "video", `${path.parse(clip.file).name}.playable.mp4`);
  fs.copyFileSync(fixture("clip.mp4"), copy);
  db.prepare("UPDATE deck_videos SET video_file = ?, ext = 'mp4', playable = 1 WHERE id = ?").run(path.basename(copy), clip.id);
  db.close();
  const converted = path.join(app.profile, "converted-media");
  fs.mkdirSync(converted);
  fs.copyFileSync(fixture("clip.mp4"), path.join(converted, "1-1000-2000.mp4"));

  const again = await relaunch(app);
  await expect.poll(() => fs.existsSync(converted)).toBe(false);
  expect(fs.existsSync(copy)).toBe(false);
  const ro = new Database(dbPath, { readonly: true });
  expect(ro.prepare("SELECT video_file AS file, playable FROM deck_videos WHERE id = ?").get(clip.id)).toEqual({
    file: clip.file,
    playable: 0,
  });
  ro.close();

  // And the original plays through the engine, as on any other deck.
  await again.previewFile("Presentaciones", "clipdeck");
  await expect.poll(() => again.log.some((line) => line.includes("[engine] slide clip")), { timeout: 30_000 }).toBe(true);
  await again.control.waitForTimeout(1000);
  await again.goLive();
  const projector = await again.projector();
  await expect.poll(() => moving(projector, "slideVideo:")).toBe(true);
});

test("a deck whose music is a WMA follows the media engine's clock, and NEGRO freezes both", async ({ app }) => {
  await app.addMedia("ppt", "hymn-wma.pptx");
  await app.previewFile("Presentaciones", "hymn-wma");
  await expect(slideTile(app, 3)).toBeVisible({ timeout: 90_000 });
  await expect.poll(() => app.log.some((line) => line.includes("[engine] slide clip")), { timeout: 60_000 }).toBe(true);
  await app.control.waitForTimeout(1000);

  await app.goLive();
  const projector = await app.projector();
  const live = app.liveColumn();
  // The music sounds from the engine, with no <audio>, and its row reads the engine's clock.
  const music = live.getByRole("slider", { name: "Posición de hymn-wma (música)" });
  await expect.poll(async () => Number(await music.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
  expect(await audioStates(projector)).toEqual([]);
  // Two seconds a slide, from the music's clock.
  await expect.poll(() => projectedSlide(projector), { timeout: 5_000 }).toBe(2);

  await app.control.locator("body").press("b");
  // The engine's last report from before the pause can land after it: the position the row settles on.
  const settled = async () => {
    const before = await music.getAttribute("aria-valuenow");
    await app.control.waitForTimeout(700);
    return before === (await music.getAttribute("aria-valuenow")) ? before : null;
  };
  await expect.poll(settled, { timeout: 5_000 }).not.toBeNull();
  const coveredAt = await music.getAttribute("aria-valuenow");
  // Covered for longer than a slide: neither the music nor the deck moves.
  await app.control.waitForTimeout(3000);
  await expect(live.getByText("2/3", { exact: true })).toBeVisible();
  expect(await music.getAttribute("aria-valuenow")).toBe(coveredAt);

  await app.control.locator("body").press("b");
  await expect.poll(() => projectedSlide(projector), { timeout: 5_000 }).toBe(3);
});

test("a slide clicked in the LIVE grid goes up at once; one clicked in PREVIEW does not", async ({ app }) => {
  await app.addMedia("ppt", "deck.pdf");
  await app.previewFile("Presentaciones", "deck");
  await expect(slideTile(app, 3)).toBeVisible({ timeout: 60_000 });
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projectedSlide(projector)).toBe(1);

  await slideTile(app, 3).click();
  await app.control.waitForTimeout(500);
  expect(await projectedSlide(projector)).toBe(1);

  await liveSlideTile(app, 3).click();
  await expect.poll(() => projectedSlide(projector)).toBe(3);
  const live = app.liveColumn();
  await expect(live.getByText("3/3", { exact: true })).toBeVisible();
  // On the last slide it still works: one more ends the deck (`projection.deckEnd`).
  await expect(live.getByRole("button", { name: "Siguiente" })).toBeEnabled();
  await live.getByRole("button", { name: "Anterior" }).click();
  await expect.poll(() => projectedSlide(projector)).toBe(2);

  // A double click in PREVIEW on a deck that is already live jumps there too.
  await slideTile(app, 1).dblclick();
  await expect.poll(() => projectedSlide(projector)).toBe(1);
});

test("one more step on the last slide takes the deck off to the logo", async ({ app }) => {
  await app.addMedia("ppt", "deck.pdf");
  await app.previewFile("Presentaciones", "deck");
  await expect(slideTile(app, 3)).toBeVisible({ timeout: 60_000 });
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projectedSlide(projector)).toBe(1);
  await liveSlideTile(app, 3).click();
  await expect.poll(() => projectedSlide(projector)).toBe(3);
  await app.control.keyboard.press("ArrowRight");
  await expect.poll(() => projectedSlide(projector)).toBeNull();
  await expect(app.liveColumn().getByRole("button", { name: "Siguiente" })).toHaveCount(0);
});

test("Space freezes a deck that advances by itself, and resumes it", async ({ app }) => {
  await app.addMedia("ppt", "hymn.pptx");
  await app.previewFile("Presentaciones", "hymn");
  await expect(slideTile(app, 3)).toBeVisible({ timeout: 90_000 });
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projectedSlide(projector)).toBe(1);

  await app.control.locator("body").press("Space");
  await expect(app.liveColumn().getByRole("button", { name: "Reproducir", exact: true })).toBeVisible();
  // Two seconds a slide: four seconds frozen would have been two slides.
  await app.control.waitForTimeout(4000);
  expect(await projectedSlide(projector)).toBe(1);

  await app.liveColumn().getByRole("button", { name: "Reproducir", exact: true }).click();
  await expect.poll(() => projectedSlide(projector), { timeout: 6_000 }).toBe(2);
});

test("a deck that advances by itself leaves the projector after its last slide", async ({ app }) => {
  await app.addMedia("ppt", "hymn.pptx");
  await app.previewFile("Presentaciones", "hymn");
  await expect(slideTile(app, 3)).toBeVisible({ timeout: 90_000 });
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projectedSlide(projector), { timeout: 10_000 }).toBe(3);
  // After the last slide's own two seconds, not «some time»; the ~100 ms of a poll's lag on the first read.
  const off = await msUntilChange(() => projectedSlide(projector), 3, 10_000);
  expect(off.value).toBeNull();
  expect(off.ms).toBeGreaterThan(1_200);
  expect(off.ms).toBeLessThan(2_400);
  await expect(app.liveColumn().getByRole("button", { name: "Siguiente" })).toHaveCount(0);
});

test("a song assigned to a deck plays under it, and NEGRO pauses the song and the slides together", async ({ app }) => {
  await app.addMedia("ppt", "hymn.pptx");
  await app.previewFile("Presentaciones", "hymn");
  await expect(slideTile(app, 3)).toBeVisible({ timeout: 90_000 });

  const preview = app.previewColumn();
  // No «Sin audio» line any more: a deck without music only offers to assign one (2026-11-05).
  await expect(preview.getByRole("button", { name: "Asignar audio" })).toBeVisible();
  await app.answerOpenDialog(fixture("song.mp3"));
  await preview.getByRole("button", { name: "Asignar audio" }).click();
  await expect(preview.getByText("song", { exact: false }).first()).toBeVisible();
  // Changing or removing a linked file lives in the bar's «⋯» (2026-11-05).
  await expect(preview.getByRole("button", { name: "Opciones del audio" })).toBeVisible();

  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await audioStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.3);
  await expect(app.liveColumn().getByText("hymn (música)")).toBeVisible();

  await app.control.locator("body").press("b");
  await expect.poll(async () => (await audioStates(projector))[0]?.paused).toBe(true);
  const coveredAt = (await audioStates(projector))[0]?.currentTime ?? 0;
  await app.control.waitForTimeout(3000);
  expect((await audioStates(projector))[0]?.currentTime).toBeCloseTo(coveredAt, 1);

  await app.control.locator("body").press("b");
  await expect.poll(async () => (await audioStates(projector))[0]?.paused).toBe(false);
  // The slide under the cover is still the one its music was on.
  const expected = Math.min(3, Math.floor(coveredAt / 2) + 1);
  expect(await projectedSlide(projector)).toBe(expected);
  await expect.poll(() => projectedSlide(projector), { timeout: 6_000 }).toBe(expected + 1);

  // And it stays assigned: «Quitar» on the strip takes it back off.
  await preview.getByRole("button", { name: "Opciones del audio" }).click();
  await app.control.getByRole("menuitem", { name: "Quitar" }).click();
  await expect(preview.getByRole("button", { name: "Asignar audio" })).toBeVisible();
});

test("a deck that cannot be converted says so and can be retried", async ({ app }) => {
  const broken = path.join(app.profile, "roto.pdf");
  fs.writeFileSync(broken, "%PDF-1.4\nthis is not a pdf\n");
  await app.invoke<MediaAsset[]>("library:add", { kind: "ppt", paths: [broken] });
  await app.previewFile("Presentaciones", "roto");
  await expect(app.previewColumn().getByText("No se pudo abrir la presentación").first()).toBeVisible({ timeout: 60_000 });

  // Fixed on disk, then retried from the same panel — unless the library sweep
  // saw the edit first and reconverted it on its own, which is just as right.
  fs.writeFileSync(broken, buildPdf(["#1f4e9c", "#c0392b"]));
  const retry = app.previewColumn().getByRole("button", { name: "Reintentar" }).first();
  await expect(async () => {
    if (await retry.isVisible()) await retry.click({ timeout: 2_000 });
    await expect(slideTile(app, 2)).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await app.goLive();
  await expect.poll(async () => projectedSlide(await app.projector())).toBe(1);
});

/** A one-slide `.pptx` whose only text names a face no machine has. */
function missingFaceDeck(file: string): void {
  const ns =
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const pkg = "http://schemas.openxmlformats.org/package/2006/relationships";
  fs.writeFileSync(
    file,
    zipSync({
      "[Content_Types].xml": strToU8(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
      ),
      "_rels/.rels": strToU8(`<Relationships xmlns="${pkg}"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`),
      "ppt/presentation.xml": strToU8(
        `<p:presentation ${ns}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
      ),
      "ppt/_rels/presentation.xml.rels": strToU8(`<Relationships xmlns="${pkg}"><Relationship Id="rId1" Type="${rel}/slide" Target="slides/slide1.xml"/></Relationships>`),
      "ppt/slides/slide1.xml": strToU8(
        `<p:sld ${ns}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
          `<p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8229600" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
          `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="4000"><a:latin typeface="Lumina Missing Face"/></a:rPr><a:t>Sublime gracia</a:t></a:r></a:p></p:txBody></p:sp>` +
          `</p:spTree></p:cSld></p:sld>`,
      ),
    }),
  );
}

test("the fallback face chosen in Ajustes reaches a live model slide at once", async ({ app }) => {
  const deck = path.join(app.profile, "fallback.pptx");
  missingFaceDeck(deck);
  await app.invoke("library:add", { kind: "ppt", paths: [deck] });
  await app.previewFile("Presentaciones", "fallback");
  await expect(slideTile(app, 1)).toBeVisible({ timeout: 30_000 });
  await app.goLive();
  const projector = await app.projector();
  const projectedFamily = () => projector.getByText("Sublime gracia").evaluate((el) => getComputedStyle(el).fontFamily);
  await expect.poll(projectedFamily).toContain("Lumina Missing Face");
  expect(await projectedFamily()).not.toContain("Montserrat");

  await app.control.getByRole("button", { name: "Configuración" }).click();
  const settings = app.control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Diapositivas" }).click();
  await settings.getByRole("group", { name: "Fuente de reemplazo" }).getByRole("combobox").click();
  await app.control.getByRole("option", { name: "Montserrat", exact: true }).click();

  // After the file's own face, never instead of it, and with no relaunch.
  // (Chromium writes a one-word family back unquoted.)
  await expect.poll(projectedFamily).toMatch(/"Lumina Missing Face".*\bMontserrat"?, sans-serif$/);
});

test("a deck that won't open says why — in its panel, on PREVIEW, at EN VIVO — and never asks to install anything", async ({ app }) => {
  const toast = (text: string) => app.control.getByRole("status").filter({ hasText: text });
  // Not a presentation: a zip with nothing of one inside.
  const broken = path.join(app.profile, "himno.pptx");
  fs.writeFileSync(broken, "PK not a presentation");
  // An encrypted `.pptx`: an OLE file holding the encryption streams.
  const locked = path.join(app.profile, "secreto.pptx");
  fs.writeFileSync(
    locked,
    compoundFile([
      { name: "EncryptionInfo", data: Buffer.alloc(64, 1) },
      { name: "EncryptedPackage", data: Buffer.alloc(4096, 2) },
    ]),
  );
  await app.invoke<MediaAsset[]>("library:add", { kind: "ppt", paths: [broken, locked] });
  await app.addMedia("ppt", "deck.pdf");

  await app.previewFile("Presentaciones", "himno");
  const preview = app.previewColumn();
  // The centre panel and the PREVIEW stage both say it, with main's reason.
  await expect(preview.getByText("No se pudo abrir la presentación")).toHaveCount(2, { timeout: 30_000 });
  await expect(preview.getByText("No se pudo abrir el archivo como presentación").first()).toBeVisible();
  await expect(app.control.getByText(/LibreOffice|soffice/i)).toHaveCount(0);

  await app.goLive();
  await expect(toast("«himno» no se puede proyectar. No se pudo abrir el archivo como presentación")).toBeVisible({ timeout: 30_000 });
  expect(await projectedSlide(await app.projector())).toBeNull();

  await app.previewFile("Presentaciones", "secreto");
  await expect(preview.getByText("La presentación tiene contraseña para abrirla").first()).toBeVisible({ timeout: 30_000 });
  await expect(preview.getByRole("button", { name: "Reintentar" }).first()).toBeVisible();

  // Everything that opens is untouched.
  await app.previewFile("Presentaciones", "deck");
  await expect(slideTile(app, 3)).toBeVisible({ timeout: 60_000 });
  await app.goLive();
  await expect.poll(async () => projectedSlide(await app.projector())).toBe(1);
  await expect(app.control.getByText(/LibreOffice|soffice/i)).toHaveCount(0);
});

test("a slide whose part won't parse is drawn without it, and only the control window says so", async ({ app }) => {
  const verses = [1, 2, 3].map((n) => ({
    text: { paragraphs: [{ text: `Estrofa ${n}`, size: 44 }], box: [2 * CM, 5 * CM, 24 * CM, 6 * CM] as [number, number, number, number] },
  }));
  const parts = unzipSync(buildPptx(verses));
  // Slide 2 cut mid-tag, as a damaged download leaves it.
  const slide2 = strFromU8(parts["ppt/slides/slide2.xml"]!);
  parts["ppt/slides/slide2.xml"] = strToU8(slide2.slice(0, slide2.indexOf(' sz="') + 2));
  const file = path.join(app.profile, "dañado.pptx");
  fs.writeFileSync(file, zipSync(parts));
  await app.invoke<MediaAsset[]>("library:add", { kind: "ppt", paths: [file] });

  await app.previewFile("Presentaciones", "dañado");
  await expect(slideTile(app, 3)).toBeVisible({ timeout: 30_000 });
  // The mark names the damage, so it is part of that tile's name and of no other's.
  const grid = app.previewColumn().getByRole("list", { name: "Presentación" });
  const damagedTile = grid.getByRole("button", { name: /dañada/ });
  await expect(damagedTile).toHaveCount(1);
  await expect(damagedTile).toHaveAccessibleName(/^2/);

  // The column header says it too, while its monitor shows that slide: one
  // more «Diapositiva dañada» beside the tile's own.
  const damagedLabels = (column: Locator) => column.getByText("Diapositiva dañada", { exact: true });
  const preview = app.previewColumn();
  await expect(damagedLabels(preview)).toHaveCount(1);
  await damagedTile.click();
  await expect(damagedLabels(preview)).toHaveCount(2);

  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projectedSlide(projector)).toBe(2);
  await expect(damagedLabels(app.liveColumn())).toHaveCount(2);
  // The projector draws what could be read, and says nothing.
  await expect(projector.getByText(/dañada/)).toHaveCount(0);
  await expect(projector.getByText("Estrofa 2")).toHaveCount(0);
  await app.control.keyboard.press("ArrowRight");
  await expect.poll(() => projectedSlide(projector)).toBe(3);
  await expect(damagedLabels(app.liveColumn())).toHaveCount(1);
});

test("a legacy .ppt with text is drawn from its model and advances by itself", async ({ app }) => {
  await app.addMedia("ppt", "legacy-text.ppt");
  await app.previewFile("Presentaciones", "legacy-text");
  await expect(slideTile(app, 3)).toBeVisible({ timeout: 30_000 });
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projectedSlide(projector)).toBe(1);
  await expect(projector.getByText("Estrofa 1")).toBeVisible();
  // Two seconds a slide, from the deck's own records.
  await expect.poll(() => projectedSlide(projector), { timeout: 8_000 }).toBe(2);
  await expect.poll(() => projectedSlide(projector), { timeout: 8_000 }).toBe(3);
});

test("an .odp is drawn from its model and advances by itself", async ({ app }) => {
  await app.addMedia("ppt", "hymn.odp");
  await app.previewFile("Presentaciones", "hymn");
  await expect(slideTile(app, 3)).toBeVisible({ timeout: 30_000 });
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projectedSlide(projector)).toBe(1);
  await expect(projector.getByText("Estrofa 1")).toBeVisible();
  await expect.poll(() => projectedSlide(projector), { timeout: 8_000 }).toBe(2);
  await expect.poll(() => projectedSlide(projector), { timeout: 8_000 }).toBe(3);
});

test("a deck edited on disk is converted again the next time it is opened", async ({ app }) => {
  const file = path.join(app.profile, "anuncios.pdf");
  fs.writeFileSync(file, buildPdf(["#1f4e9c", "#c0392b", "#27ae60"]));
  await app.invoke<MediaAsset[]>("library:add", { kind: "ppt", paths: [file] });
  await app.addMedia("ppt", "deck.pdf");
  await app.previewFile("Presentaciones", "anuncios");
  await expect(slideTile(app, 3)).toBeVisible({ timeout: 60_000 });

  // Someone takes a slide out during the week.
  fs.writeFileSync(file, buildPdf(["#1f4e9c", "#27ae60"]));
  await app.previewFile("Presentaciones", "deck");
  await expect(slideTile(app, 3)).toBeVisible({ timeout: 60_000 });
  await app.previewFile("Presentaciones", "anuncios");
  await expect(slideTile(app, 2)).toBeVisible({ timeout: 60_000 });
  await expect(slideTile(app, 3)).toHaveCount(0);
  // And the projector gets the edited deck, not last week's.
  await app.goLive();
  await expect(liveSlideTile(app, 2)).toBeVisible();
  await expect(liveSlideTile(app, 3)).toHaveCount(0);
});

test("a deck edited while the app was closed is not projected from the old cache", async ({ app }) => {
  const file = path.join(app.profile, "anuncios.pdf");
  fs.writeFileSync(file, buildPdf(["#1f4e9c", "#c0392b", "#27ae60"]));
  await app.invoke<MediaAsset[]>("library:add", { kind: "ppt", paths: [file] });
  await app.previewFile("Presentaciones", "anuncios");
  await expect(slideTile(app, 3)).toBeVisible({ timeout: 60_000 });
  await app.quit();

  fs.writeFileSync(file, buildPdf(["#1f4e9c", "#27ae60"]));
  const again = await relaunch(app);
  await again.previewFile("Presentaciones", "anuncios");
  await expect(slideTile(again, 2)).toBeVisible({ timeout: 60_000 });
  await expect(slideTile(again, 3)).toHaveCount(0);
  await again.goLive();
  await expect(liveSlideTile(again, 2)).toBeVisible();
  await expect(liveSlideTile(again, 3)).toHaveCount(0);
});

test("a long PDF opens without converting anything, and writes nothing to disk", async ({ app }) => {
  // Every status main announces for a deck: a PDF used to say «converting»
  // page by page, then write every page to the slide cache.
  type Bridge = { worship: { on: (channel: string, cb: (payload: { status: string }) => void) => void } };
  await app.control.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { deckStatuses: string[] }).deckStatuses = seen;
    (window as unknown as Bridge).worship.on("deck-progress", (p) => seen.push(p.status));
  });
  const [deck] = await app.addMedia("ppt", "long.pdf");
  if (!deck) throw new Error("import failed");
  await app.previewFile("Presentaciones", "long");
  await expect(slideTile(app, 1)).toBeVisible({ timeout: 30_000 });
  const read = await app.invoke<{ slideCount: number }>("deck:ensure", { assetId: deck.id });
  expect(read.slideCount).toBe(160);

  // Pages the projector has not been sent yet are drawn when it asks.
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projectedSlide(projector)).toBe(1);
  for (let n = 2; n <= 4; n += 1) {
    await app.control.keyboard.press("ArrowRight");
    await expect.poll(() => projectedSlide(projector)).toBe(n);
  }
  await expect
    .poll(() =>
      projector.evaluate(() => {
        const image = [...document.querySelectorAll<HTMLImageElement>('img[src^="worship://deck/"]')].at(-1);
        return image?.complete ? image.naturalWidth : 0;
      }),
    )
    .toBeGreaterThan(0);

  const statuses = await app.control.evaluate(() => (window as unknown as { deckStatuses: string[] }).deckStatuses);
  expect(statuses).not.toContain("converting");
  expect(fs.readdirSync(path.join(app.profile, "slides-cache"))).toEqual([]);
});

test("taking a copy of a PDF out of the library leaves the one on air drawing its pages", async ({ app }) => {
  // Same bytes twice: the two rows share one deck, whose source is whichever
  // was opened last.
  const copy = path.join(app.profile, "long copia.pdf");
  fs.copyFileSync(fixture("long.pdf"), copy);
  await app.addMedia("ppt", "long.pdf");
  const [duplicate] = await app.invoke<MediaAsset[]>("library:add", { kind: "ppt", paths: [copy] });
  if (!duplicate) throw new Error("import failed");

  await app.previewFile("Presentaciones", "long");
  await expect(slideTile(app, 1)).toBeVisible({ timeout: 30_000 });
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projectedSlide(projector)).toBe(1);

  await app.previewFile("Presentaciones", "long copia");
  await expect(slideTile(app, 1)).toBeVisible({ timeout: 30_000 });
  await app.invoke("library:remove", { id: duplicate.id });
  // The hidden window that draws PDFs keeps the document open for 5 minutes;
  // past that (or after a crash) it reads the file again, and that read is
  // what was refused for a source no longer in the library. A crash, not a
  // `destroy()`: a page it was drawing is drawn again in the next window.
  await app.electron.evaluate(({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.getURL().includes("rasterizer")) contents.forcefullyCrashRenderer();
    }
  });

  // Pages nobody drew yet: they have to come from the file still on air.
  for (let n = 2; n <= 6; n += 1) {
    await app.liveColumn().getByRole("button", { name: "Siguiente" }).click();
    await expect.poll(() => projectedSlide(projector)).toBe(n);
  }
  await expect
    .poll(() =>
      projector.evaluate(() => {
        const image = [...document.querySelectorAll<HTMLImageElement>('img[src^="worship://deck/"]')].at(-1);
        return image?.complete ? image.naturalWidth : 0;
      }),
    )
    .toBeGreaterThan(0);
});

test("a PDF page whose hidden drawing window crashes is drawn again, not left blank", async ({ app }) => {
  await app.addMedia("ppt", "long.pdf");
  await app.previewFile("Presentaciones", "long");
  await expect(slideTile(app, 1)).toBeVisible({ timeout: 30_000 });
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projectedSlide(projector)).toBe(1);

  // The first time each full-size page is asked for, the hidden window dies
  // instead of drawing it; asked again, it draws.
  await app.electron.evaluate(({ app: electronApp, webContents }) => {
    const crashed = new Set<number>();
    const sabotage = (contents: Electron.WebContents) => {
      if (!contents.getURL().includes("rasterizer")) return;
      const send = contents.send.bind(contents);
      contents.send = (channel: string, ...args: unknown[]) => {
        const task = args[0] as { op?: string; thumb?: boolean; page?: number };
        if (channel === "raster:task" && task.op === "render" && task.thumb === false && !crashed.has(task.page ?? 0)) {
          crashed.add(task.page ?? 0);
          contents.forcefullyCrashRenderer();
          return;
        }
        send(channel, ...args);
      };
    };
    for (const contents of webContents.getAllWebContents()) sabotage(contents);
    electronApp.on("web-contents-created", (_event, contents) => contents.once("did-finish-load", () => sabotage(contents)));
  });

  for (let n = 2; n <= 5; n += 1) {
    await app.liveColumn().getByRole("button", { name: "Siguiente" }).click();
    await expect.poll(() => projectedSlide(projector)).toBe(n);
  }
  await expect
    .poll(() =>
      projector.evaluate(() => {
        const image = [...document.querySelectorAll<HTMLImageElement>('img[src^="worship://deck/"]')].at(-1);
        return image?.complete ? image.naturalWidth : 0;
      }),
    )
    .toBeGreaterThan(0);
  await expect(app.liveColumn().getByText("No se pudo reproducir el archivo")).toHaveCount(0);
});
