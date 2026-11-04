import { songThemeFromBibleStyle } from "@shared/types/song";
import { mainMessages } from "../../i18n";
import type { SettingsRepo } from "../repositories/settings.repo";
import type { SongsRepo } from "../repositories/songs.repo";

/**
 * Gives a database its default song theme, once (`songs.seeded`, the rule of
 * `seedUtilityScenes`): the operator's verse as configured today, at a
 * singer's size. Never throws — a church without a theme still sings, on
 * `DEFAULT_SONG_THEME`.
 */
export function seedSongThemes(repo: SongsRepo, settings: SettingsRepo): void {
  try {
    if (settings.get("songs.seeded")) return;
    if (repo.listThemes().length === 0) {
      repo.createTheme(mainMessages().seed.songThemeName, songThemeFromBibleStyle(settings.get("bible.style")));
    }
    settings.setMany({ "songs.seeded": true });
  } catch (error) {
    console.warn("[songs] seeding the default theme failed", error);
  }
}
