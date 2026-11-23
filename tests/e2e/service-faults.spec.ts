import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { MediaAsset } from "../../src/shared/types/media";
import { DEFAULT_BIBLE_STYLE } from "../../src/shared/types/bible-style";
import { buildPptx, CM } from "./support/pptx";
import { fixture } from "./support/paths";
import { audioStates, expect, test, videoStates, type WorshipApp } from "./support/app";

/**
 * What a service does when something goes wrong in it (2026-11-10 review, agents 3, 4 and 5): a file that is
 * missing or goes away, an extra key, a cover over a deck that loops. Each case failed in 2.7.1 — the
 * projector went black, the music sang behind BLACK, a video restarted in front of the congregation.
 */

const JUAN_3_16 = "Porque de tal manera amó Dios al mundo";

const scheduleSection = (app: WorshipApp) =>
  app.control.locator("section").filter({ has: app.control.getByRole("heading", { name: "Programa", exact: true }) });
const scheduleRows = (app: WorshipApp) => scheduleSection(app).getByRole("list").first().getByRole("listitem");

async function addToSchedule(app: WorshipApp, ...files: string[]) {
  await app.answerOpenDialog(...files);
  await scheduleSection(app).getByRole("button", { name: "Agregar medios" }).click();
}

/** A copy of a generated file in this test's own profile, free to rename. */
function copyIn(app: WorshipApp, name: string, as = name): string {
  const dir = path.join(app.profile, "material");
  fs.mkdirSync(dir, { recursive: true });
  const to = path.join(dir, as);
  fs.copyFileSync(fixture(name), to);
  return to;
}

async function verseLive(app: WorshipApp) {
  await app.openChapter("Juan 3");
  await app.control.getByRole("listitem").filter({ hasText: JUAN_3_16 }).click();
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.getByText(JUAN_3_16, { exact: false })).toBeVisible();
  return projector;
}

function projectedSlide(projector: Page): Promise<number | null> {
  return projector.evaluate(() => {
    const last = [...document.querySelectorAll<HTMLElement>('img[src^="worship://deck/"], [data-slide-model^="worship://deck/"]')].at(-1);
    const url = last instanceof HTMLImageElement ? last.src : (last?.dataset["slideModel"] ?? "");
    const match = /\/(\d+)(?:\/model)?$/.exec(url);
    return match ? Number(match[1]) : null;
  });
}

/** The slide image on the projector, and whether it drew. */
function projectedImage(projector: Page) {
  return projector.evaluate(() => {
    const last = [...document.querySelectorAll<HTMLImageElement>('img[src^="worship://deck/"]')].at(-1);
    return last ? { n: Number(/\/(\d+)$/.exec(last.src)?.[1]), loaded: last.complete && last.naturalWidth > 0 } : null;
  });
}

for (const [label, name] of [
  ["video", "clip.mp4"],
  ["picture", "photo.png"],
] as const) {
  test(`a ${label} gone since the last sweep never takes the verse off the projector, and Enter marks it`, async ({ app }) => {
    const projector = await verseLive(app);
    const file = copyIn(app, name);
    await addToSchedule(app, file);
    fs.renameSync(file, `${file}.gone`); // moved, deleted, a pendrive pulled
    await scheduleRows(app).first().click();
    // No sweep is waited for: it runs on a window's focus, 30 s apart, and this test failed whenever none came after
    // the rename (2026-11-22 audit, TQ11). Enter looks at the file itself.
    await app.control.keyboard.press("Enter");
    await expect(app.control.getByRole("status").filter({ hasText: "no se puede proyectar" })).toBeVisible();
    await expect(app.previewColumn().getByText("Media no encontrada").first()).toBeVisible();
    await app.control.waitForTimeout(1000);
    await expect(projector.getByText(JUAN_3_16, { exact: false })).toBeVisible();
  });
}

test("a hymn whose .pps goes away while it is live keeps showing its next slides", async ({ app }) => {
  const pps = copyIn(app, "legacy-hymn.pps", "Himno 522.pps");
  await app.invoke<MediaAsset[]>("library:add", { kind: "ppt", paths: [pps] });
  await app.previewFile("Presentaciones", "Himno 522");
  await expect(app.previewColumn().getByText("1/3", { exact: true })).toBeVisible({ timeout: 60_000 });
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projectedImage(projector)).toEqual({ n: 1, loaded: true });
  await app.control.waitForTimeout(1000); // its copy is taken in the background as it goes live
  fs.renameSync(pps, `${pps}.gone`); // a pendrive pulled, a network share that drops
  await app.control.keyboard.press("PageDown");
  await app.control.keyboard.press("PageDown");
  await expect.poll(() => projectedImage(projector), { timeout: 10_000 }).toEqual({ n: 3, loaded: true });
});

test("a .pptx whose file goes away while it is live keeps showing its next slides", async ({ app }) => {
  const deck = path.join(app.profile, "avisos.pptx");
  fs.writeFileSync(
    deck,
    buildPptx(
      Array.from({ length: 6 }, (_, i) => ({
        background: ["#20304a", "#4a2030", "#304a20", "#202020", "#403020", "#203040"][i] ?? "#000000",
        text: { paragraphs: [{ text: `Diapo ${i + 1}`, size: 60, color: "#ffffff" }], box: [2 * CM, 5 * CM, 24 * CM, 5 * CM] },
      })),
    ),
  );
  await app.invoke<MediaAsset[]>("library:add", { kind: "ppt", paths: [deck] });
  await app.previewFile("Presentaciones", "avisos");
  await expect(app.previewColumn().getByText("1/6", { exact: true })).toBeVisible({ timeout: 60_000 });
  await app.goLive();
  const projector = await app.projector();
  await expect(projector.locator("body")).toContainText("Diapo 1");
  await app.control.waitForTimeout(1000);
  fs.renameSync(deck, `${deck}.gone`);
  for (let i = 0; i < 3; i++) await app.control.keyboard.press("PageDown");
  await expect(projector.locator("body")).toContainText("Diapo 4");
});

test("a PDF whose file goes away while it is live keeps showing its next pages", async ({ app }) => {
  const pdf = copyIn(app, "long.pdf", "avisos.pdf");
  await app.invoke<MediaAsset[]>("library:add", { kind: "ppt", paths: [pdf] });
  await app.previewFile("Presentaciones", "avisos");
  await expect(app.previewColumn().getByText("1/160", { exact: true })).toBeVisible({ timeout: 60_000 });
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projectedImage(projector)).toEqual({ n: 1, loaded: true });
  await app.control.waitForTimeout(1500); // its copy is taken in the background as it goes live
  fs.renameSync(pdf, `${pdf}.gone`);
  for (let i = 0; i < 3; i++) await app.control.keyboard.press("PageDown");
  // Pages nobody drew yet. Before, the projector froze on page 2, the last one drawn ahead (2026-11-15 audit, A6).
  await expect.poll(() => projectedImage(projector), { timeout: 10_000 }).toEqual({ n: 4, loaded: true });
});

test("an extra Enter on the video live does not restart it; under NEGRO, its row picked again, Enter only uncovers it", async ({
  app,
}) => {
  await addToSchedule(app, copyIn(app, "clip.mp4"));
  await scheduleRows(app).first().click();
  await app.control.keyboard.press("Enter");
  const projector = await app.projector();
  await expect.poll(async () => (await videoStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(2);
  // It left PREVIEW when it went out (owner, 2026-11-15): an extra Enter has nothing to send.
  await app.control.keyboard.press("Enter");
  await app.control.waitForTimeout(500);
  expect((await videoStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(2);
  // Under BLACK, Enter with PREVIEW empty does nothing either (owner, 2026-11-15)…
  await app.control.locator("body").press("b");
  await expect(app.liveColumn().getByText("NEGRO").first()).toBeVisible();
  await app.control.keyboard.press("Enter");
  await app.control.waitForTimeout(500);
  expect((await videoStates(projector))[0]?.paused).toBe(true);
  // …and its row picked again — an easy slip mid-service — only uncovers it, still where it was.
  await scheduleRows(app).first().click();
  await app.control.keyboard.press("Enter");
  await expect.poll(async () => (await videoStates(projector))[0]?.paused).toBe(false);
  expect((await videoStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(2);
});

/** hymn.pptx (3 slides × 2 s) with an 8 s mp3 beside it as its music. */
async function hymnWithMusicLive(app: WorshipApp) {
  const dir = path.join(app.profile, "himnario");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(fixture("hymn.pptx"), path.join(dir, "Himno largo.pptx"));
  fs.copyFileSync(fixture("song.mp3"), path.join(dir, "Himno largo.mp3"));
  await app.invoke("library:add", { kind: "ppt", paths: [path.join(dir, "Himno largo.pptx")] });
  await app.previewFile("Presentaciones", "Himno largo");
  await expect(app.previewColumn().getByText("Himno largo.mp3").first()).toBeVisible({ timeout: 60_000 });
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await audioStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.5);
  return projector;
}

test("a projector whose renderer dies mid-hymn comes back on its slide, the music where it was, not from 0:00", async ({
  app,
}) => {
  app.crashLogExpected = true;
  const first = await hymnWithMusicLive(app);
  await expect.poll(async () => (await audioStates(first))[0]?.currentTime ?? 0).toBeGreaterThan(2.5);
  await app.electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().endsWith("/projection.html"))
      ?.webContents.forcefullyCrashRenderer(),
  );
  await expect(app.control.getByText("La ventana de proyección se cayó y se volvió a abrir sola")).toBeVisible();
  const projector = await app.projector();
  // The first reading of the new window, not a later one: a hymn restarted from 0:00 is past 2 s again soon enough.
  // Its slides follow its music («synced»), so a restart would also show slide 1 (2026-11-15 audit, A1).
  await expect.poll(async () => (await audioStates(projector))[0]?.readyState ?? 0).toBeGreaterThan(0);
  expect((await audioStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(2);
  expect(await projectedSlide(projector)).toBeGreaterThanOrEqual(2);
  // How long the room was without a projector, for the record.
  console.log(app.log.find((line) => line.includes("[projector] mounted again")) ?? "[projector] no timing line");
});

test("«Reiniciar» under BLACK rewinds the hymn but its music stays paused behind the cover", async ({ app }) => {
  const projector = await hymnWithMusicLive(app);
  await app.control.locator("body").press("b");
  await expect.poll(async () => (await audioStates(projector))[0]?.paused).toBe(true);
  await app.liveColumn().getByRole("button", { name: "Reiniciar", exact: true }).click();
  await app.control.waitForTimeout(2_000);
  const after = (await audioStates(projector))[0];
  expect(after?.paused).toBe(true);
  expect(after?.currentTime ?? 99).toBeLessThan(0.5);
  // Uncovered: the first slide, its music from the top.
  await app.control.locator("body").press("b");
  await expect.poll(() => projectedSlide(projector)).toBe(1);
  await expect.poll(async () => (await audioStates(projector))[0]?.paused).toBe(false);
});

test("a deck that loops, stepped past its last slide under BLACK, does not sing behind the cover", async ({ app }) => {
  await app.invoke("settings:set", { "projection.deckEnd": "loop" });
  await app.control.reload();
  await expect(app.control.getByRole("button", { name: "EN VIVO", exact: true })).toBeVisible();
  const projector = await hymnWithMusicLive(app);
  await app.liveColumn().getByRole("list", { name: "Presentación" }).getByRole("button", { name: "3", exact: true }).click();
  await expect.poll(() => projectedSlide(projector)).toBe(3);
  await app.control.locator("body").press("b");
  await expect.poll(async () => (await audioStates(projector))[0]?.paused).toBe(true);
  await app.control.locator("body").press("ArrowRight");
  await app.control.waitForTimeout(2_000);
  expect((await audioStates(projector))[0]?.paused).toBe(true);
  // Uncovered, it starts over from its first slide with its music.
  await app.control.locator("body").press("b");
  await expect.poll(async () => (await audioStates(projector))[0]?.paused).toBe(false);
  expect(await projectedSlide(projector)).toBe(1);
});

test("a looping deck without music keeps each slide's own time across the loop", async ({ app }) => {
  test.setTimeout(90_000);
  await app.invoke("settings:set", { "projection.deckEnd": "loop" });
  await app.control.reload();
  await expect(app.control.getByRole("button", { name: "EN VIVO", exact: true })).toBeVisible();
  const deck = path.join(app.profile, "avisos.pptx");
  fs.writeFileSync(
    deck,
    buildPptx(
      Array.from({ length: 3 }, (_, i) => ({
        background: ["#20304a", "#4a2030", "#304a20"][i] ?? "#000000",
        text: { paragraphs: [{ text: `Aviso ${i + 1}`, size: 60, color: "#ffffff" }], box: [2 * CM, 5 * CM, 24 * CM, 5 * CM] },
        advanceMs: 2000,
      })),
    ),
  );
  await app.invoke<MediaAsset[]>("library:add", { kind: "ppt", paths: [deck] });
  await app.previewFile("Presentaciones", "avisos");
  await expect(app.previewColumn().getByText("1/3", { exact: true })).toBeVisible({ timeout: 60_000 });
  await app.goLive();
  const projector = await app.projector();
  await projector.evaluate(() => {
    const w = window as unknown as { qa: { t: number; s: string }[] };
    w.qa = [];
    const onAir = () => [...(document.body.innerText.match(/Aviso \d/g) ?? [])].at(-1) ?? "";
    // From the slide already up: the first mutation seen is not a change, and logging it put a mid-slide time first.
    let last = onAir();
    new MutationObserver(() => {
      const s = onAir();
      if (s && s !== last) w.qa.push({ t: Date.now(), s: (last = s) });
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  // Changes at 2, 4.5, 7, 9 and 11.5 s after GO LIVE: 13 s from here sees all five, past the loop twice.
  await app.control.waitForTimeout(13_000);
  const log = await projector.evaluate(() => (window as unknown as { qa: { t: number; s: string }[] }).qa);
  const gaps = log.slice(1).map((x, i) => x.t - log[i]!.t);
  expect(gaps.length).toBeGreaterThanOrEqual(4);
  // Each slide its own time, both ways: in 2.7.1 the first slide after the loop stayed 4 s. Slide 1 is 2 s (it comes
  // back by a cut); slides 2 and 3 their half-second fade and then their 2 s, as in PowerPoint.
  gaps.forEach((gap, i) => {
    const expected = log[i]!.s === "Aviso 1" ? 2000 : 2500;
    expect(gap, JSON.stringify(log)).toBeGreaterThan(expected - 300);
    expect(gap, JSON.stringify(log)).toBeLessThan(expected + 400);
  });
});

test("«Achicar si no entra» turned off with a verse live keeps the verse at its size", async ({ app }) => {
  const projector = await verseLive(app);
  const verse = projector.getByText(JUAN_3_16, { exact: false });
  const measure = () =>
    verse.evaluate((el) => {
      let stage: HTMLElement | null = el as HTMLElement;
      while (stage && getComputedStyle(stage).containerType === "normal") stage = stage.parentElement;
      return { fontPx: Number.parseFloat(getComputedStyle(el).fontSize), stageWidth: stage?.getBoundingClientRect().width ?? Number.NaN };
    });
  const expected = (m: { stageWidth: number }) => (m.stageWidth * DEFAULT_BIBLE_STYLE.text.sizeCqw) / 100;
  const before = await measure();
  expect(before.fontPx).toBeCloseTo(expected(before), 0);
  await app.openResources("Biblia");
  await app.control.getByRole("tabpanel", { name: "Biblia" }).getByRole("button", { name: "Estilo del versículo" }).click();
  const editor = app.control.getByRole("dialog", { name: "Estilo del versículo" });
  const toggle = editor.getByRole("group", { name: "Achicar si no entra" }).getByRole("switch");
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await projector.waitForTimeout(500);
  // In 2.7.1 it fell to the page's 16 px.
  const after = await measure();
  expect(after.fontPx).toBeCloseTo(expected(after), 0);
});
