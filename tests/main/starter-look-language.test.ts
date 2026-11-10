/**
 * A15 of the landing-guide audit (2026-11-10 review, agent4). The starter look names its backgrounds in the
 * language the profile was seeded in («Noche.webp»), and the verse's «Restaurar» looks «Noche» up under the
 * CURRENT language's name (`settings:factoryVerseStyle` → `mainMessages().look`). Since 2.7.0 the welcome
 * invites the language change on the very first launch, right after the look was seeded in the OS language.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { openDatabase } from "../../src/main/db/client";
import { runMigrations } from "../../src/main/db/migrate";
import { seedSongThemes } from "../../src/main/db/seed/seed-song-themes";
import { factoryVerseStyle, seedStarterLook } from "../../src/main/db/seed/seed-starter-look";
import { seedUtilityScenes } from "../../src/main/db/seed/seed-utility-scenes";
import mainEn from "../../src/main/i18n/messages/en";
import mainEs from "../../src/main/i18n/messages/es";
import {
  getMediaRepo,
  getOverlaysRepo,
  getSettingsRepo,
  getSongsRepo,
  getUtilityRepo,
  initRepos,
} from "../../src/main/services/repos";

const opened: { dir: string; close: () => void }[] = [];
afterEach(() => {
  for (const { dir, close } of opened.splice(0)) {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a profile seeded in English, switched to Spanish, restores the verse over its «Night», not black", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-starter-look-"));
  const { db, sqlite } = openDatabase(path.join(dir, "worship.db"));
  opened.push({ dir, close: () => sqlite.close() });
  runMigrations(db, path.join(process.cwd(), "drizzle"));
  initRepos(db, sqlite);
  seedUtilityScenes(getUtilityRepo(), getSettingsRepo());
  seedSongThemes(getSongsRepo(), getSettingsRepo());
  const folder = path.join(dir, "backgrounds");
  seedStarterLook(
    { sqlite, media: getMediaRepo(), songs: getSongsRepo(), utility: getUtilityRepo(), overlays: getOverlaysRepo(), settings: getSettingsRepo() },
    { from: path.join(process.cwd(), "resources", "backgrounds"), to: folder },
    mainEn.look,
    true,
  );
  const seeded = getSettingsRepo().get("bible.style");
  expect(seeded.background.kind).toBe("image");
  // The operator picks «Español» in the welcome (or Settings): main now speaks Spanish.
  expect(factoryVerseStyle(getMediaRepo(), folder, mainEs.look)).toEqual(seeded);
});
