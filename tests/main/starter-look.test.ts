/**
 * The starter look: the shipped backgrounds into the library under the
 * language's names, the themes and overlays added, and only what is still as
 * it came restyled — once.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { openDatabase } from "../../src/main/db/client";
import { runMigrations } from "../../src/main/db/migrate";
import { seedSongThemes } from "../../src/main/db/seed/seed-song-themes";
import {
  factoryVerseStyle,
  reattachBackgrounds,
  seedStarterLook,
  STARTER_LOOK_VERSION,
} from "../../src/main/db/seed/seed-starter-look";
import { seedUtilityScenes } from "../../src/main/db/seed/seed-utility-scenes";
import mainEs from "../../src/main/i18n/messages/es";
import mainPt from "../../src/main/i18n/messages/pt";
import {
  getMediaRepo,
  getOverlaysRepo,
  getSettingsRepo,
  getSongsRepo,
  getUtilityRepo,
  initRepos,
} from "../../src/main/services/repos";
import { DEFAULT_BIBLE_STYLE } from "../../src/shared/types/bible-style";
import { DEFAULT_SCENE_STYLE } from "../../src/shared/types/scene-style";
import { DEFAULT_SETTINGS } from "../../src/shared/types/settings";

const drizzleDir = path.join(process.cwd(), "drizzle");
const backgroundsDir = path.join(process.cwd(), "resources", "backgrounds");
const opened: { dir: string; close: () => void }[] = [];

afterEach(() => {
  for (const { dir, close } of opened.splice(0)) {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A database as a launch leaves it before the look: the older seeds run. */
function profile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-look-"));
  const { db, sqlite } = openDatabase(path.join(dir, "worship.db"));
  opened.push({ dir, close: () => sqlite.close() });
  runMigrations(db, drizzleDir);
  initRepos(db, sqlite);
  seedUtilityScenes(getUtilityRepo(), getSettingsRepo());
  seedSongThemes(getSongsRepo(), getSettingsRepo());
  const seed = (isNewProfile: boolean) =>
    seedStarterLook(
      {
        sqlite,
        media: getMediaRepo(),
        songs: getSongsRepo(),
        utility: getUtilityRepo(),
        overlays: getOverlaysRepo(),
        settings: getSettingsRepo(),
      },
      { from: backgroundsDir, to: path.join(dir, "backgrounds") },
      mainEs.look,
      isNewProfile,
    );
  return { dir, seed, sqlite };
}

describe("the starter look", () => {
  test("a new church gets the backgrounds, the themes, a dressed verse and time scenes, and three overlays — once", () => {
    const { dir, seed } = profile();
    seed(true);

    const media = getMediaRepo();
    expect(media.list("image").map((asset) => asset.name).sort()).toEqual(
      ["Amanecer", "Atardecer", "Bosque", "Brasas", "Cielo", "Grafito", "Noche", "Océano"],
    );
    expect(media.list("video").map((asset) => asset.name).sort()).toEqual(["Amanecer", "Atardecer", "Noche", "Océano"]);
    expect(fs.existsSync(path.join(dir, "backgrounds", "Océano.mp4"))).toBe(true);

    const themes = getSongsRepo().listThemes();
    expect(themes.map((theme) => theme.name)).toEqual([
      "Clásico",
      "Amanecer",
      "Océano",
      "Noche",
      "Atardecer",
      "Bosque",
      "Brasas",
    ]);
    expect(themes[2]?.style.background.kind).toBe("video");
    const settings = getSettingsRepo();
    expect(settings.get("songs.defaultThemeId")).toBe(themes[1]?.id);

    const verse = settings.get("bible.style");
    expect({ ...verse, background: DEFAULT_BIBLE_STYLE.background }).toEqual(DEFAULT_BIBLE_STYLE);
    expect(verse.background.kind).toBe("image");
    expect(getUtilityRepo().list().every((scene) => scene.style.background.kind === "image")).toBe(true);
    expect(getOverlaysRepo().list().map((plate) => plate.kind).sort()).toEqual(["banner", "bug", "lower-third"]);
    expect(settings.get("look.seeded")).toBe(STARTER_LOOK_VERSION);

    seed(true);
    expect(getSongsRepo().listThemes()).toHaveLength(themes.length);
    expect(getOverlaysRepo().list()).toHaveLength(3);
    expect(media.list("image")).toHaveLength(8);
  });

  test("an existing install keeps what the operator changed and its own default theme", () => {
    const { seed } = profile();
    const settings = getSettingsRepo();
    const verse = { ...DEFAULT_BIBLE_STYLE, background: { kind: "solid" as const, color: "#202020" } };
    settings.setMany({ "bible.style": verse });
    const [touched, preRebrand, ...untouched] = getUtilityRepo().list();
    const { id, ...rest } = touched!;
    getUtilityRepo().update(id, { ...rest, style: { ...DEFAULT_SCENE_STYLE, value: { ...DEFAULT_SCENE_STYLE.value, color: "#ffcc00" } } });
    // Seeded before the rebrand and never touched: the colours of then.
    const old = { ...DEFAULT_SCENE_STYLE.message, color: "#f5f5f5" };
    const { id: oldId, ...oldRest } = preRebrand!;
    getUtilityRepo().update(oldId, {
      ...oldRest,
      style: {
        ...DEFAULT_SCENE_STYLE,
        background: { kind: "solid", color: "#04132b" },
        title: { ...DEFAULT_SCENE_STYLE.title, color: "#84adfc" },
        message: old,
        end: { ...DEFAULT_SCENE_STYLE.end, message: old },
      },
    });

    seed(false);

    expect(settings.get("bible.style")).toEqual(verse);
    expect(getUtilityRepo().get(id)?.style.background).toEqual(DEFAULT_SCENE_STYLE.background);
    expect([preRebrand!, ...untouched].map((scene) => getUtilityRepo().get(scene.id)?.style.background.kind)).toEqual([
      "image",
      "image",
      "image",
    ]);
    expect(settings.get("songs.defaultThemeId")).toBeNull();
    expect(getSongsRepo().listThemes()).toHaveLength(7);
  });
});

describe("the starter look, version 2: LOGO without an image", () => {
  test("a new install gets LOGO over «Noche» along with the rest", () => {
    const { dir, seed } = profile();
    seed(true);
    const night = getMediaRepo()
      .list("image")
      .find((asset) => asset.path === path.join(dir, "backgrounds", "Noche.webp"));
    expect(getSettingsRepo().get("logo.background")).toEqual({ kind: "image", assetId: night?.id, fit: "cover" });
  });

  test("an install on version 1 only dresses LOGO — nothing deleted comes back, nothing is added twice", () => {
    const { seed } = profile();
    seed(false);
    const settings = getSettingsRepo();
    // As 2.5.0 left it: version 1, LOGO still black, and a background the operator deleted.
    settings.setMany({ "look.seeded": 1, "logo.background": DEFAULT_SETTINGS["logo.background"] });
    const sky = getMediaRepo().list("image").find((asset) => asset.name === "Cielo");
    getMediaRepo().remove(sky!.id);
    const themes = getSongsRepo().listThemes().length;

    seed(false);

    expect(settings.get("logo.background").kind).toBe("image");
    expect(getMediaRepo().list("image").map((asset) => asset.name)).not.toContain("Cielo");
    expect(getSongsRepo().listThemes()).toHaveLength(themes);
    expect(getOverlaysRepo().list()).toHaveLength(3);
    expect(settings.get("look.seeded")).toBe(STARTER_LOOK_VERSION);
  });

  test("a LOGO background the operator chose is kept", () => {
    const { seed } = profile();
    const chosen = { kind: "solid" as const, color: "#123456" };
    getSettingsRepo().setMany({ "logo.background": chosen });
    seed(false);
    expect(getSettingsRepo().get("logo.background")).toEqual(chosen);
  });
});

describe("the verse's «Restaurar»", () => {
  test("brings the verse back over «Noche», and to plain black once «Noche» is deleted", () => {
    const { dir, seed } = profile();
    seed(true);
    const folder = path.join(dir, "backgrounds");
    expect(factoryVerseStyle(getMediaRepo(), folder, mainEs.look)).toEqual(getSettingsRepo().get("bible.style"));
    expect(factoryVerseStyle(getMediaRepo(), folder, mainEs.look).background.kind).toBe("image");

    const night = getMediaRepo().list("image").find((asset) => asset.name === "Noche");
    getMediaRepo().remove(night!.id);
    expect(factoryVerseStyle(getMediaRepo(), folder, mainEs.look)).toEqual(DEFAULT_BIBLE_STYLE);
  });
});

describe("a profile moved to another computer", () => {
  test("its backgrounds point at this profile's copies; a church's own «backgrounds» folder is left alone", () => {
    const { dir, seed, sqlite } = profile();
    seed(true);
    const folder = path.join(dir, "backgrounds");
    const profileName = path.basename(dir);
    const rows = sqlite.prepare("SELECT id, path FROM media_assets").all() as { id: number; path: string }[];
    const move = sqlite.prepare("UPDATE media_assets SET path = ?, path_key = ? WHERE id = ?");
    // As another user left them: half on Windows, half on a Mac.
    rows.forEach((row, index) => {
      const file = path.basename(row.path);
      const old =
        index % 2
          ? `C:\\Users\\Ana\\AppData\\Roaming\\${profileName}\\backgrounds\\${file}`
          : `/Users/ana/Library/Application Support/${profileName}/backgrounds/${file}`;
      move.run(old, old, row.id);
    });
    const ownFolder = "/Volumes/Iglesia/backgrounds/Cielo.webp";
    const sky = rows.find((row) => path.basename(row.path) === "Cielo.webp")!;
    move.run(ownFolder, ownFolder, sky.id);

    expect(reattachBackgrounds(getMediaRepo(), folder, backgroundsDir)).toBe(rows.length - 1);
    for (const row of rows) {
      const expected = row.id === sky.id ? ownFolder : path.join(folder, path.basename(row.path));
      expect(getMediaRepo().getPathById(row.id)).toBe(expected);
    }
    expect(factoryVerseStyle(getMediaRepo(), folder, mainEs.look).background.kind).toBe("image");
    expect(reattachBackgrounds(getMediaRepo(), folder, backgroundsDir)).toBe(0);
  });
  test("restored on a computer in another language, the backgrounds it lacks come back from the app's own files", () => {
    const { dir, seed, sqlite } = profile();
    seed(true);
    const folder = path.join(dir, "backgrounds");
    // This profile was seeded in Spanish; the copy came from a Portuguese one at another user's.
    const rows = sqlite.prepare("SELECT id, path FROM media_assets").all() as { id: number; path: string }[];
    const move = sqlite.prepare("UPDATE media_assets SET path = ?, path_key = ? WHERE id = ?");
    const pt = Object.fromEntries(Object.entries(mainEs.look.backgrounds).map(([id, name]) => [name, mainPt.look.backgrounds[id as keyof typeof mainPt.look.backgrounds]]));
    for (const row of rows) {
      const ext = path.extname(row.path);
      const old = `C:\\Users\\Ana\\AppData\\Roaming\\${path.basename(dir)}\\backgrounds\\${pt[path.basename(row.path, ext)]}${ext}`;
      move.run(old, old, row.id);
    }

    expect(reattachBackgrounds(getMediaRepo(), folder, backgroundsDir)).toBe(rows.length);
    for (const row of rows) {
      const ext = path.extname(row.path);
      const moved = getMediaRepo().getPathById(row.id)!;
      expect(moved).toBe(path.join(folder, `${pt[path.basename(row.path, ext)]}${ext}`));
      const id = Object.entries(mainPt.look.backgrounds).find(([, name]) => `${name}${ext}` === path.basename(moved))![0];
      expect(fs.readFileSync(moved).equals(fs.readFileSync(path.join(backgroundsDir, `${id}${ext}`)))).toBe(true);
    }
    // A name that is no background of the app's is left alone.
    const own = `C:\\Users\\Ana\\AppData\\Roaming\\${path.basename(dir)}\\backgrounds\\Bautismo.webp`;
    move.run(own, own, rows[0]!.id);
    expect(reattachBackgrounds(getMediaRepo(), folder, backgroundsDir)).toBe(0);
    expect(getMediaRepo().getPathById(rows[0]!.id)).toBe(own);
  });
});
