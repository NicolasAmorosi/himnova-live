import os from "node:os";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { parseLyrics } from "../../src/shared/song-text";
import { LOCALES, type Locale } from "../../src/shared/types/settings";
import { expect, relaunch, test, type WorshipApp } from "./support/app";
import { generateDemoMedia, lyrics, prepare } from "./support/demo";
import { Recorder } from "./support/recorder";
import { CONTENT, type Content } from "./screenshots.content";
import { CAPTIONS, REFERENCE, type TutorialId } from "./tutorials.content";

/**
 * `npm run tutorials`: the landing's short videos, recorded off the real app
 * in each language with the same demo as the screenshots. Each test leaves
 * `<TUTORIALS_OUT>/<locale>/<id>/`: the frames of the control window and the
 * projector, and `timeline.json` (pointer, clicks, keys, captions, camera) —
 * composed into a video outside this repo. `TUTORIALS=song,bible` and
 * `TUTORIAL_LOCALES=es` record only those.
 */

const OUT = process.env["TUTORIALS_OUT"] ?? path.join(os.tmpdir(), "himnova-tutorials");
const pick = <T extends string>(all: readonly T[], env: string | undefined) =>
  env ? all.filter((item) => env.split(",").includes(item)) : all;

type Ctx = {
  app: WorshipApp;
  rec: Recorder;
  content: Content;
  locale: Locale;
  media: (name: string) => string;
  /** Shows a caption of this tutorial, its `{labels}` in this language. */
  say: (key: string, extraMs?: number) => Promise<void>;
};

/** What every tutorial's library starts with: the two hymns as songs. */
async function seed(app: WorshipApp, content: Content): Promise<void> {
  for (const hymn of [content.fortress, content.holy])
    await app.invoke("song:create", {
      title: hymn.title,
      number: null,
      authors: hymn.credit,
      copyright: content.copyright,
      ccliNumber: null,
      notes: null,
      sections: parseLyrics(lyrics(hymn), "es").sections,
      order: [],
      themeId: null,
    });
}

const ui = (app: WorshipApp) => {
  const { control } = app;
  const tr = (text: string) => app.tr(text);
  const schedule = control.locator("section").filter({ has: control.getByRole("heading", { name: tr("Programa"), exact: true }) });
  const songs = control.getByRole("tabpanel", { name: tr("Canciones") });
  const bible = control.getByRole("tabpanel", { name: tr("Biblia") });
  return {
    schedule,
    rows: schedule.getByRole("list").first().getByRole("listitem"),
    tab: (name: string) => control.getByRole("tab", { name: tr(name) }),
    songs,
    songSearch: songs.getByRole("textbox", { name: tr("Buscar por título, número, autor o letra") }),
    songRows: songs.getByRole("list", { name: tr("Canciones") }).getByRole("listitem"),
    bible,
    bibleFinder: bible.getByRole("textbox", { name: tr("Libro, capítulo y versículo…") }),
    goLive: control.getByRole("button", { name: tr("EN VIVO"), exact: true }).first(),
    black: control.getByRole("button", { name: tr("NEGRO"), exact: true }).first(),
    backToLive: control.getByRole("button", { name: tr("VIVO"), exact: true }).first(),
    addToSchedule: (panel: Locator) => panel.getByRole("button", { name: tr("Agregar al programa") }),
    preview: app.previewColumn(),
    live: app.liveColumn(),
  };
};

/** Adds the program the overview walks through, through the UI, before filming. */
async function buildProgram(app: WorshipApp, content: Content, media: (name: string) => string, locale: Locale) {
  const u = ui(app);
  await app.answerOpenDialog(media(`${content.files.welcome}.webp`));
  await u.schedule.getByRole("button", { name: app.tr("Agregar medios") }).click();
  await u.tab("Canciones").click();
  await u.songRows.filter({ hasText: content.fortress.title }).click();
  await u.addToSchedule(u.songs).click();
  await u.tab("Biblia").click();
  await u.bibleFinder.fill(REFERENCE[locale]);
  await app.control.keyboard.press("Enter");
  await expect(u.preview.getByText(/3:16/).first()).toBeVisible();
  await u.addToSchedule(u.bible).click();
  await app.answerOpenDialog(media(`${content.files.announcements}.mp4`));
  await u.schedule.getByRole("button", { name: app.tr("Agregar medios") }).click();
  await expect(u.rows).toHaveCount(4);
}

const SCRIPTS: Record<TutorialId, { setup?: (ctx: Omit<Ctx, "rec" | "say">) => Promise<void>; run: (ctx: Ctx) => Promise<void> }> = {
  "how-it-works": {
    setup: ({ app, content, media, locale }) => buildProgram(app, content, media, locale),
    async run({ app, rec, say, content }) {
      const u = ui(app);
      await rec.focus(u.schedule);
      await say("schedule", 1600);
      await rec.click(u.rows.filter({ hasText: content.files.welcome }));
      await rec.focus(null);
      await say("preview", 1600);
      await rec.click(u.goLive);
      await say("live", 1800);
      await rec.click(u.rows.filter({ hasText: content.fortress.title }));
      await say("next", 1200);
      await rec.click(u.goLive);
      await rec.hold(1200);
      await say("arrows", 300);
      await rec.press("ArrowRight", "→");
      await rec.hold(1300);
      await rec.press("ArrowRight", "→");
      await rec.hold(1300);
      await rec.click(u.rows.filter({ hasText: "3:16" }));
      await say("verse", 600);
      await rec.click(u.goLive);
      await rec.hold(1800);
      await say("black", 400);
      await rec.click(u.black);
      await rec.hold(1800);
      await say("back", 300);
      await rec.click(u.backToLive);
      await rec.hold(2000);
    },
  },
  song: {
    async run({ app, rec, say, content }) {
      const u = ui(app);
      await say("tab", 200);
      await rec.click(u.tab("Canciones"));
      await rec.focus(u.songs);
      await say("search", 600);
      await rec.type(u.songSearch, content.fortress.title.split(" ")[0]!.toLowerCase().slice(0, 7));
      await rec.hold(800);
      await say("pick", 400);
      await rec.click(u.songRows.filter({ hasText: content.fortress.title }));
      await rec.focus(u.preview);
      await rec.hold(1800);
      await rec.focus(null);
      await say("live", 300);
      await rec.click(u.goLive);
      await rec.hold(2000);
      await say("arrows", 300);
      await rec.press("ArrowRight", "→");
      await rec.hold(1500);
      await rec.press("ArrowRight", "→");
      await rec.hold(1500);
      await rec.focus(u.live);
      await say("jump", 300);
      const liveSlides = u.live.getByRole("list", { name: app.tr("Diapositivas de «{title}»", { title: content.fortress.title }) });
      await rec.click(liveSlides.getByRole("listitem").first().getByRole("button"));
      await rec.hold(2200);
    },
  },
  bible: {
    async run({ app, rec, say, locale }) {
      const u = ui(app);
      await say("tab", 600);
      await rec.click(u.tab("Biblia"));
      await rec.focus(u.bible);
      await rec.type(u.bibleFinder, REFERENCE[locale]);
      await say("enter", 200);
      await rec.press("Enter");
      await rec.focus(null);
      await rec.hold(1600);
      await say("live", 200);
      await rec.click(u.goLive);
      await rec.hold(2200);
      await say("next", 300);
      await rec.press("ArrowRight", "→");
      await rec.hold(2500);
    },
  },
  presentation: {
    async run({ app, rec, say, content, media }) {
      const u = ui(app);
      await say("tab", 200);
      await rec.click(u.tab("Medios"));
      await rec.click(u.tab("Presentaciones"));
      const decks = app.control.getByRole("tabpanel", { name: app.tr("Presentaciones") });
      await say("add", 600);
      await app.answerOpenDialog(media(`${content.holy.title}.pptx`));
      await rec.click(decks.getByRole("button", { name: app.tr("Agregar"), exact: true }));
      const tile = decks.getByRole("button", { name: content.holy.title });
      await expect(tile).toBeVisible();
      await rec.hold(600);
      await say("pick", 300);
      await rec.click(tile);
      const slides = u.preview.getByRole("list", { name: app.tr("Presentación") });
      await expect(slides.getByRole("button", { name: "2", exact: true })).toBeVisible({ timeout: 60_000 });
      await rec.focus(u.preview);
      await rec.hold(1600);
      await rec.focus(null);
      await say("live", 300);
      await rec.click(u.goLive);
      await rec.hold(2000);
      await say("arrows", 500);
      await rec.press("ArrowRight", "→");
      await rec.hold(1600);
      await rec.press("ArrowRight", "→");
      await rec.hold(2200);
    },
  },
  video: {
    async run({ app, rec, say, content, media }) {
      const u = ui(app);
      await say("tab", 600);
      await rec.click(u.tab("Medios"));
      await rec.click(u.tab("Videos"));
      const videos = app.control.getByRole("tabpanel", { name: app.tr("Videos") });
      await app.answerOpenDialog(media(`${content.files.announcements}.mp4`));
      await rec.click(videos.getByRole("button", { name: app.tr("Agregar"), exact: true }));
      const tile = videos.getByRole("button", { name: content.files.announcements }).first();
      await expect(tile).toBeVisible();
      await say("pick", 300);
      await rec.click(tile);
      await rec.focus(u.preview);
      await rec.hold(2400);
      await rec.focus(null);
      await say("live", 300);
      await rec.click(u.goLive);
      await rec.hold(3500);
      await say("black", 500);
      await rec.click(u.black);
      await rec.hold(2200);
    },
  },
  schedule: {
    async run({ app, rec, say, content, locale, media }) {
      const u = ui(app);
      await rec.focus(null);
      await say("song", 1200);
      await rec.click(u.tab("Canciones"));
      await rec.click(u.songRows.filter({ hasText: content.holy.title }));
      await rec.click(u.addToSchedule(u.songs));
      await rec.hold(900);
      await say("verse", 400);
      await rec.click(u.tab("Biblia"));
      await rec.type(u.bibleFinder, REFERENCE[locale]);
      await rec.press("Enter");
      await rec.hold(700);
      await rec.click(u.addToSchedule(u.bible));
      await rec.hold(900);
      await say("video", 400);
      await rec.click(u.tab("Medios"));
      await rec.click(u.tab("Videos"));
      const videos = app.control.getByRole("tabpanel", { name: app.tr("Videos") });
      await app.answerOpenDialog(media(`${content.files.announcements}.mp4`));
      await rec.click(videos.getByRole("button", { name: app.tr("Agregar"), exact: true }));
      const tile = videos.getByRole("button", { name: content.files.announcements }).first();
      await expect(tile).toBeVisible();
      // Dragged onto the schedule, under its last row.
      const last = await u.rows.last().boundingBox();
      if (!last) throw new Error("the schedule has no rows");
      await rec.drag(tile, { x: last.x + last.width / 2, y: last.y + last.height + 30 });
      await expect(u.rows).toHaveCount(3);
      await rec.focus(u.schedule);
      await rec.hold(1400);
      await say("save", 300);
      await rec.click(app.control.getByRole("button", { name: app.tr("Guardar"), exact: true }));
      const programs = app.control.getByRole("dialog", { name: app.tr("Programas") });
      await rec.focus(null);
      await rec.type(programs.getByRole("textbox", { name: app.tr("Nombre") }), content.program);
      await rec.click(programs.getByRole("button", { name: app.tr("Guardar"), exact: true }).last());
      await rec.hold(800);
      await say("reopen", 600);
      await rec.click(programs.getByRole("button", { name: app.tr("Cerrar") }));
      await rec.focus(u.schedule);
      await rec.hold(800);
      await say("run", 400);
      await rec.click(u.rows.first());
      await rec.focus(null);
      await rec.click(u.goLive);
      await rec.hold(2400);
    },
  },
};

test.beforeAll(generateDemoMedia);

for (const locale of pick(LOCALES, process.env["TUTORIAL_LOCALES"])) {
  test.describe(locale, () => {
    test.use({ appLocale: locale, starterLook: true });

    for (const id of pick(Object.keys(SCRIPTS) as TutorialId[], process.env["TUTORIALS"])) {
      test(`${id} (${locale})`, async ({ app: first }) => {
        test.setTimeout(300_000);
        const content = CONTENT[locale];
        const media = prepare(locale);
        await seed(first, content);
        await first.quit();
        const app = await relaunch(first);
        const script = SCRIPTS[id];
        await script.setup?.({ app, content, locale, media });

        const rec = await Recorder.start(path.join(OUT, locale, id), app.control);
        const opened = app.electron
          .waitForEvent("window", { predicate: (page) => page.url().endsWith("/projection.html"), timeout: 0 })
          .then((page) => rec.projector(page))
          .catch(() => undefined);
        const say = (key: string, extraMs = 0) => {
          const text = CAPTIONS[id][locale][key];
          if (!text) throw new Error(`no caption «${key}» for ${id} in ${locale}`);
          return rec.say(text.replace(/\{([^}]+)\}/g, (_, label: string) => (label === "ref" ? REFERENCE[locale] : `**${app.tr(label)}**`)), extraMs);
        };
        await script.run({ app, rec, content, locale, media, say });
        await Promise.race([opened, Promise.resolve()]);
        await rec.finish();
      });
    }
  });
}
