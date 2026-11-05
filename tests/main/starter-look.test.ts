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
import { seedStarterLook, STARTER_LOOK_VERSION } from "../../src/main/db/seed/seed-starter-look";
import { seedUtilityScenes } from "../../src/main/db/seed/seed-utility-scenes";
import mainEs from "../../src/main/i18n/messages/es";
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
  return { dir, seed };
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
