import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import { DEFAULT_BIBLE_STYLE, type BibleStyle } from "@shared/types/bible-style";
import { DEFAULT_BUG_STYLE, DEFAULT_PLATE_STYLE, type Plate } from "@shared/types/overlay";
import { DEFAULT_SCENE_STYLE, type SceneStyle } from "@shared/types/scene-style";
import { DEFAULT_SETTINGS } from "@shared/types/settings";
import { DEFAULT_SONG_THEME, type SongBackground } from "@shared/types/song";
import type { TimerTool } from "@shared/types/timer";
import type { MainMessages } from "../../i18n/messages/es";
import type { MediaRepo } from "../repositories/media.repo";
import type { OverlaysRepo } from "../repositories/overlays.repo";
import type { SettingsRepo } from "../repositories/settings.repo";
import type { SongsRepo } from "../repositories/songs.repo";
import type { UtilityRepo } from "../repositories/utility.repo";

/**
 * The look a church starts with (owner, 2026-11-05: «que se vea lindo»): the
 * backgrounds the app ships (`resources/backgrounds/`, drawn by
 * `scripts/make-backgrounds.ts`) copied into the library, song themes over
 * them, a quiet one behind the verse, the time scenes dressed, and three
 * overlays ready to fill in.
 *
 * Each version of the look once (`look.seeded`), the rule of the other seeds:
 * whatever the operator deletes stays deleted. On an install that already
 * exists it ADDS — themes, backgrounds, overlays — and restyles only what is
 * still exactly as it came (the verse's style, a time scene's), never what
 * the operator changed (owner, 2026-11-05). One transaction: a seed that
 * fails halfway leaves nothing, and tries again on the next launch. Never
 * throws: a church without its sample look still has a working app.
 */
export const STARTER_LOOK_VERSION = 2;

export type BackgroundId = "night" | "sunrise" | "ocean" | "dusk" | "forest" | "ember" | "graphite" | "sky";
const STILLS: readonly BackgroundId[] = ["night", "sunrise", "ocean", "dusk", "forest", "ember", "graphite", "sky"];
const LOOPS: readonly BackgroundId[] = ["night", "sunrise", "ocean", "dusk"];

type Repos = { sqlite: Database.Database; media: MediaRepo; songs: SongsRepo; utility: UtilityRepo; overlays: OverlaysRepo; settings: SettingsRepo };
type Dirs = { from: string; to: string };
type Text = MainMessages["look"];

/** The shipped files, copied under the language's names («Amanecer.webp»)
 *  into the profile — the app's own folder can move (an AppImage mounts
 *  somewhere new on every launch) — and added to the library. */
function addBackgrounds(media: MediaRepo, dirs: Dirs, text: Text) {
  fs.mkdirSync(dirs.to, { recursive: true });
  const copy = (id: BackgroundId, ext: string) => {
    const target = path.join(dirs.to, `${text.backgrounds[id]}.${ext}`);
    if (!fs.existsSync(target)) fs.copyFileSync(path.join(dirs.from, `${id}.${ext}`), target);
    return { path: target, stat: fs.statSync(target) };
  };
  const images = media.upsertBatch(STILLS.map((id) => copy(id, "webp")), "image", true).assets;
  const videos = media.upsertBatch(LOOPS.map((id) => copy(id, "mp4")), "video", true).assets;
  const idOf = (assets: typeof images, ids: readonly BackgroundId[]) =>
    Object.fromEntries(ids.map((id, index) => [id, assets[index]!.id])) as Record<BackgroundId, number>;
  return { image: idOf(images, STILLS), video: idOf(videos, LOOPS) };
}

type Backgrounds = ReturnType<typeof addBackgrounds>;

/** How the built-in time scenes looked before the rebrand (2026-10-22): an
 *  install seeded then and never touched still has exactly this. Every field
 *  added since reads back as its default, and the end message as the message. */
const PRE_REBRAND_SCENE_STYLE: SceneStyle = {
  ...DEFAULT_SCENE_STYLE,
  background: { kind: "solid", color: "#04132b" },
  title: { ...DEFAULT_SCENE_STYLE.title, color: "#84adfc" },
  message: { ...DEFAULT_SCENE_STYLE.message, color: "#f5f5f5" },
  end: { ...DEFAULT_SCENE_STYLE.end, message: { ...DEFAULT_SCENE_STYLE.end.message, color: "#f5f5f5" } },
};
const FACTORY_SCENE_STYLES = [DEFAULT_SCENE_STYLE, PRE_REBRAND_SCENE_STYLE];

/** A time scene's look by what it counts: warm before the service, quiet
 *  during it. The title turns from steel to near-white, which reads on all four. */
function sceneStyleFor(tool: TimerTool, backgrounds: Backgrounds): SceneStyle {
  const by: Record<TimerTool, BackgroundId> = {
    countdown: "dusk",
    "countdown-to-time": "sunrise",
    clock: "night",
    stopwatch: "graphite",
  };
  return {
    ...DEFAULT_SCENE_STYLE,
    background: { kind: "image", assetId: backgrounds.image[by[tool]], fit: "cover" },
    title: { ...DEFAULT_SCENE_STYLE.title, color: "#e8eef5" },
  };
}

function plates(text: Text): Omit<Plate, "id">[] {
  return [
    {
      name: text.lowerThirdName,
      kind: "lower-third",
      position: "bottom-left",
      title: text.lowerThirdTitle,
      subtitle: text.lowerThirdSubtitle,
      imageAssetId: null,
      style: {
        ...DEFAULT_PLATE_STYLE,
        background: { kind: "gradient", from: "#162231", to: "#1d6f86", direction: "to-right" },
        backgroundOpacity: 0.92,
        subtitle: { ...DEFAULT_PLATE_STYLE.subtitle, color: "#9fd3d0" },
        animation: { style: "slide", durationMs: 400 },
      },
    },
    {
      name: text.bannerName,
      kind: "banner",
      position: "bottom-center",
      title: text.bannerTitle,
      subtitle: text.bannerSubtitle,
      imageAssetId: null,
      style: {
        ...DEFAULT_PLATE_STYLE,
        background: { kind: "gradient", from: "#2a1446", to: "#a8351a", direction: "to-right" },
        backgroundOpacity: 0.9,
        subtitle: { ...DEFAULT_PLATE_STYLE.subtitle, color: "#f6d6b8" },
        ticker: { enabled: true, speedCqw: 10 },
      },
    },
    {
      name: text.bugName,
      kind: "bug",
      position: "top-right",
      title: text.bugTitle,
      subtitle: null,
      imageAssetId: null,
      style: { ...DEFAULT_BUG_STYLE, title: { ...DEFAULT_BUG_STYLE.title, sizeCqw: 1.8 } },
    },
  ];
}

export function seedStarterLook(repos: Repos, dirs: Dirs, text: Text, isNewProfile: boolean): void {
  try {
    if (repos.settings.get("look.seeded") >= STARTER_LOOK_VERSION) return;
    repos.sqlite.transaction(() => {
      if (repos.settings.get("look.seeded") < 1) seedFirstLook(repos, dirs, text, isNewProfile);
      dressLogo(repos, dirs, text);
      repos.settings.setMany({ "look.seeded": STARTER_LOOK_VERSION });
    })();
  } catch (error) {
    console.warn("[look] seeding the starter look failed", error);
  }
}

/** Version 1 (2.5.0): the backgrounds, themes, verse, time scenes and overlays. */
function seedFirstLook(repos: Repos, dirs: Dirs, text: Text, isNewProfile: boolean): void {
  const backgrounds = addBackgrounds(repos.media, dirs, text);

  const image = (id: BackgroundId) => ({ kind: "image", assetId: backgrounds.image[id], fit: "cover" }) as const;
  const themes: [string, SongBackground][] = [
    [text.backgrounds.sunrise, image("sunrise")],
    [text.backgrounds.ocean, { kind: "video", assetId: backgrounds.video.ocean, fit: "cover" }],
    [text.backgrounds.night, image("night")],
    [text.backgrounds.dusk, image("dusk")],
    [text.backgrounds.forest, image("forest")],
    [text.backgrounds.ember, image("ember")],
  ];
  const created = themes.map(([name, background]) => repos.songs.createTheme(name, { ...DEFAULT_SONG_THEME, background }));
  // A new church sings over the first; an existing one keeps its own default.
  if (isNewProfile) repos.settings.setMany({ "songs.defaultThemeId": created[0]!.id });

  if (isDeepStrictEqual(repos.settings.get("bible.style"), DEFAULT_BIBLE_STYLE)) {
    repos.settings.setMany({ "bible.style": { ...DEFAULT_BIBLE_STYLE, background: image("night") } });
  }

  for (const scene of repos.utility.list()) {
    if (!FACTORY_SCENE_STYLES.some((factory) => isDeepStrictEqual(scene.style, factory))) continue;
    const { id, ...rest } = scene;
    repos.utility.update(id, { ...rest, style: sceneStyleFor(scene.tool, backgrounds) });
  }

  for (const plate of plates(text)) repos.overlays.create(plate);
}

/** Version 2: LOGO without an image, still black as it came, over «Noche» —
 *  found in the library where version 1 put it, never added again: a
 *  background the operator deleted stays deleted. */
function dressLogo(repos: Repos, dirs: Dirs, text: Text): void {
  if (!isDeepStrictEqual(repos.settings.get("logo.background"), DEFAULT_SETTINGS["logo.background"])) return;
  const night = nightBackground(repos.media, dirs.to, text);
  if (night) repos.settings.setMany({ "logo.background": night });
}

/** «Noche» where version 1 put it in the library, or `null` once the operator deleted it.
 *  ponytail: looks it up under the CURRENT language's name — a profile seeded in another
 *  language falls back to black; search every dictionary's name if that ever matters. */
function nightBackground(media: MediaRepo, folder: string, text: Text) {
  const night = path.join(folder, `${text.backgrounds.night}.webp`);
  const asset = media.list("image").find((candidate) => candidate.path === night);
  return asset ? ({ kind: "image", assetId: asset.id, fit: "cover" } as const) : null;
}

/** The verse's style as it comes (its «Restaurar»; owner, 2026-11-06): over «Noche» while the
 *  library still has it, plain black otherwise. */
export function factoryVerseStyle(media: MediaRepo, folder: string, text: Text): BibleStyle {
  const night = nightBackground(media, folder, text);
  return night ? { ...DEFAULT_BIBLE_STYLE, background: night } : DEFAULT_BIBLE_STYLE;
}
