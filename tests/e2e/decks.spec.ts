import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import { strToU8, zipSync } from "fflate";
import type { MediaAsset } from "../../src/shared/types/media";
import { SLIDES_CONVERTER_VERSION } from "../../src/shared/constants";
import { fixture } from "./support/paths";
import { buildPdf } from "./support/pdf";
import { audioStates, engineCanvas, expect, moving, relaunch, test, videoStates, type WorshipApp } from "./support/app";

/** A rasterized slide in the centre grid, once the deck is converted. */
const slideTile = (app: WorshipApp, n: number) =>
  app.previewColumn().getByRole("list", { name: "Presentación" }).getByRole("button", { name: String(n), exact: true });

/** The same slide in the LIVE column's grid, which only exists while the deck
 *  is on the projector. */
const liveSlideTile = (app: WorshipApp, n: number) =>
  app.liveColumn().getByRole("list", { name: "Presentación" }).getByRole("button", { name: String(n), exact: true });

const hasHymn = () => fs.existsSync(fixture("hymn.pptx"));

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

test("a PDF is a deck: converted without LibreOffice, projected, stepped", async ({ app }) => {
  await app.addMedia("ppt", "deck.pdf");
  await app.previewFile("Presentaciones", "deck");
  // Its three pages, rasterized, in the centre grid.
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
  test.skip(!hasHymn(), "LibreOffice is not installed, so there is no .pptx fixture");
  await app.addMedia("ppt", "hymn.pptx");
  await app.previewFile("Presentaciones", "hymn");
  await expect(slideTile(app, 3)).toBeVisible({ timeout: 90_000 });

  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projectedSlide(projector)).toBe(1);
  // Two seconds a slide, from the deck's own timings.
  await expect.poll(() => projectedSlide(projector), { timeout: 8_000 }).toBe(2);
  await expect.poll(() => projectedSlide(projector), { timeout: 8_000 }).toBe(3);
});

test("the EN VIVO that opens the projector still gives slide 1 its whole time", async ({ app }) => {
  test.skip(!hasHymn(), "LibreOffice is not installed, so there is no .pptx fixture");
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
  test.skip(!fs.existsSync(fixture("clipdeck.pptx")), "LibreOffice is not installed, so there is no .pptx fixture");
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
  expect(app.log.some((line) => line.includes("[convert] slide clip"))).toBe(false);
});

test("after a restart, a deck prepared before still plays its WMV through the engine", async ({ app }) => {
  test.skip(!fs.existsSync(fixture("clipdeck.pptx")), "LibreOffice is not installed, so there is no .pptx fixture");
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

test("a deck whose music is a WMA follows the media engine's clock, and NEGRO freezes both", async ({ app }) => {
  test.skip(!fs.existsSync(fixture("hymn-wma.pptx")), "LibreOffice is not installed, so there is no .pptx fixture");
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
  await app.control.waitForTimeout(500);
  const coveredAt = await music.getAttribute("aria-valuenow");
  // Covered for longer than a slide: neither the music nor the deck moves.
  await app.control.waitForTimeout(3000);
  await expect(live.getByText("2/3", { exact: true })).toBeVisible();
  expect(await music.getAttribute("aria-valuenow")).toBe(coveredAt);

  await app.control.locator("body").press("b");
  await expect.poll(() => projectedSlide(projector), { timeout: 5_000 }).toBe(3);
  expect(app.log.some((line) => line.includes("[convert] slide clip"))).toBe(false);
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
  await expect(live.getByRole("button", { name: "Siguiente" })).toBeDisabled();
  await live.getByRole("button", { name: "Anterior" }).click();
  await expect.poll(() => projectedSlide(projector)).toBe(2);

  // A double click in PREVIEW on a deck that is already live jumps there too.
  await slideTile(app, 1).dblclick();
  await expect.poll(() => projectedSlide(projector)).toBe(1);
});

test("Space freezes a deck that advances by itself, and resumes it", async ({ app }) => {
  test.skip(!hasHymn(), "LibreOffice is not installed, so there is no .pptx fixture");
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
  test.skip(!hasHymn(), "LibreOffice is not installed, so there is no .pptx fixture");
  await app.addMedia("ppt", "hymn.pptx");
  await app.previewFile("Presentaciones", "hymn");
  await expect(slideTile(app, 3)).toBeVisible({ timeout: 90_000 });
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projectedSlide(projector), { timeout: 10_000 }).toBe(3);
  await expect.poll(() => projectedSlide(projector), { timeout: 10_000 }).toBeNull();
  await expect(app.liveColumn().getByRole("button", { name: "Siguiente" })).toHaveCount(0);
});

test("a song assigned to a deck plays under it, and NEGRO pauses the song and the slides together", async ({ app }) => {
  test.skip(!hasHymn(), "LibreOffice is not installed, so there is no .pptx fixture");
  await app.addMedia("ppt", "hymn.pptx");
  await app.previewFile("Presentaciones", "hymn");
  await expect(slideTile(app, 3)).toBeVisible({ timeout: 90_000 });

  const preview = app.previewColumn();
  await expect(preview.getByText("Sin audio")).toBeVisible();
  await app.answerOpenDialog(fixture("song.mp3"));
  await preview.getByRole("button", { name: "Asignar audio" }).click();
  await expect(preview.getByText("song", { exact: false }).first()).toBeVisible();
  await expect(preview.getByRole("button", { name: "Cambiar", exact: true })).toBeVisible();

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
  await preview.getByRole("button", { name: "Quitar", exact: true }).first().click();
  await expect(preview.getByText("Sin audio")).toBeVisible();
});

test("a deck that cannot be converted says so and can be retried", async ({ app }) => {
  const broken = path.join(app.profile, "roto.pdf");
  fs.writeFileSync(broken, "%PDF-1.4\nthis is not a pdf\n");
  await app.invoke<MediaAsset[]>("library:add", { kind: "ppt", paths: [broken] });
  await app.previewFile("Presentaciones", "roto");
  await expect(app.previewColumn().getByText("No se pudo convertir la presentación").first()).toBeVisible({ timeout: 60_000 });

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

test("without LibreOffice, a .pptx is drawn from its model and projected", async ({ app }) => {
  test.skip(!hasHymn(), "LibreOffice is not installed, so there is no .pptx fixture");
  await app.invoke("settings:set", { "slides.sofficePath": path.join(app.profile, "missing", "soffice") });
  await app.addMedia("ppt", "hymn.pptx");
  await app.quit();

  const again = await relaunch(app);
  await again.previewFile("Presentaciones", "hymn");
  await expect(slideTile(again, 3)).toBeVisible({ timeout: 30_000 });
  await expect(again.previewColumn().getByText("Hace falta LibreOffice para convertir esta presentación")).toHaveCount(0);
  await again.goLive();
  await expect.poll(async () => projectedSlide(await again.projector())).toBe(1);
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

test("without LibreOffice: warned at launch, a PowerPoint is gated, a PDF still projects", async ({ app }) => {
  // A machine with no LibreOffice, whatever this one has: an override is
  // authoritative, and one that is not there is never swapped for autodetection.
  await app.invoke("settings:set", { "slides.sofficePath": path.join(app.profile, "missing", "soffice") });
  await app.invoke("deck:environment", { force: true });
  // Not a presentation, so it can't be drawn from a model: it would need
  // LibreOffice, and the gate stops it there.
  const pptx = path.join(app.profile, "himno.pptx");
  fs.writeFileSync(pptx, "PK not a presentation");
  await app.invoke<MediaAsset[]>("library:add", { kind: "ppt", paths: [pptx] });
  await app.addMedia("ppt", "deck.pdf");
  await app.quit();

  const again = await relaunch(app);
  const toast = (on: WorshipApp, text: string) => on.control.getByRole("status").filter({ hasText: text });
  await expect(toast(again, "algunas presentaciones de PowerPoint no se van a poder convertir")).toBeVisible();

  await again.previewFile("Presentaciones", "himno");
  const tab = again.control.getByRole("tabpanel", { name: "Presentaciones" });
  await expect(tab.getByText("Algunos PowerPoint no se pueden abrir sin convertir")).toBeVisible();
  await expect(again.previewColumn().getByText("Lumina Live usa LibreOffice para convertir")).toBeVisible();
  // The stage says why — it used to say «Preparando la conversión…» forever.
  await expect(again.previewColumn().getByText("Hace falta LibreOffice para convertir esta presentación")).toBeVisible();
  await expect(again.previewColumn().getByText("Preparando la conversión")).toHaveCount(0);

  await again.goLive();
  await expect(toast(again, "«himno» no se puede proyectar")).toBeVisible({ timeout: 30_000 });
  expect(await projectedSlide(await again.projector())).toBeNull();

  // Everything that does not need LibreOffice is untouched.
  await again.previewFile("Presentaciones", "deck");
  await expect(slideTile(again, 3)).toBeVisible({ timeout: 60_000 });
  await again.goLive();
  await expect.poll(async () => projectedSlide(await again.projector())).toBe(1);

  // Silenced from the strip — the launch toast saying the same goes with it —
  // and it stays silenced.
  await tab.getByRole("button", { name: "No volver a mostrar" }).click();
  await expect(tab.getByText("Algunos PowerPoint no se pueden abrir sin convertir")).toHaveCount(0);
  await expect(toast(again, "algunas presentaciones de PowerPoint no se van a poder convertir")).toHaveCount(0);
  await again.quit();
  const third = await relaunch(again);
  await third.openResources("Media", "Presentaciones");
  await expect(third.control.getByText("Algunos PowerPoint no se pueden abrir sin convertir")).toHaveCount(0);
  await expect(toast(third, "algunas presentaciones de PowerPoint no se van a poder convertir")).toHaveCount(0);

  // Installed while the app is open (here: the bad override goes away), found
  // by «Comprobar de nuevo» without a restart. Only where there is one to find.
  if (!hasHymn()) return;
  await third.invoke("settings:set", { "slides.sofficePath": null });
  await third.control.getByRole("button", { name: "Configuración" }).click();
  const settings = third.control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Diapositivas" }).click();
  await expect(settings.getByText("No disponible", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Comprobar de nuevo" }).click();
  await expect(toast(third, "está listo")).toBeVisible();
  await expect(settings.getByText(/^Versión \d/)).toBeVisible();
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

test("a deck finished in the background after the operator cancelled it shows its slides, not «Preparando…»", async ({ app }) => {
  test.skip(!hasHymn(), "LibreOffice is not installed, so there is no .odp fixture");
  const [hymn] = await app.addMedia("ppt", "converted.odp");
  if (!hymn) throw new Error("import failed");
  await app.previewFile("Presentaciones", "converted");
  const preview = app.previewColumn();
  // Main's own word that the job stopped: until its `soffice` is gone, a new
  // request for the same deck joins the dying job instead of starting one.
  type Bridge = { worship: { on: (channel: string, cb: (payload: { status: string }) => void) => void } };
  const stopped = app.control.evaluate(
    () =>
      new Promise<void>((resolve) =>
        (window as unknown as Bridge).worship.on("deck-progress", (p) => {
          if (p.status === "stale") resolve();
        }),
      ),
  );
  await preview.getByRole("button", { name: "Cancelar" }).first().click();
  await expect(preview.getByText("Conversión cancelada").first()).toBeVisible();
  await stopped;

  // Later the background prewarm (the library's visible decks, the
  // schedule's) converts it after all — with nobody in the control window
  // awaiting that job.
  await app.invoke("deck:prewarm", { assetIds: [hymn.id], scope: "explicit" });
  await expect(slideTile(app, 3)).toBeVisible({ timeout: 90_000 });
  await expect(preview.getByText("Preparando la conversión…")).toHaveCount(0);
});

test("cancelling a deck that is still waiting in line says so", async ({ app }) => {
  test.skip(!hasHymn(), "LibreOffice is not installed, so there is no .odp fixture");
  await app.addMedia("ppt", "converted.odp", "queued.odp");
  // The first converts; the second deck waits behind it.
  await app.previewFile("Presentaciones", "converted");
  await app.previewFile("Presentaciones", "queued");
  const preview = app.previewColumn();
  await preview.getByRole("button", { name: "Cancelar" }).first().click();
  await expect(preview.getByText("Conversión cancelada").first()).toBeVisible();
  await expect(preview.getByText("Preparando la conversión…")).toHaveCount(0);
});
