import { defaultUtilityScenes } from "@shared/types/utility";
import { mainMessages } from "../../i18n";
import type { SettingsRepo } from "../repositories/settings.repo";
import type { UtilityRepo } from "../repositories/utility.repo";

/**
 * Gives a fresh database the four built-in time scenes, once and only once.
 *
 * "Once" is a flag (`utility.seeded`) rather than "the table is empty", and
 * the difference is the whole behaviour: seeding an empty table would mean an
 * operator who deletes a scene they never use finds it back next launch, and
 * deleting all four would be impossible. With the flag, deleting is deleting —
 * the panel shows an empty state and offers to create one.
 *
 * Never throws: a church that cannot seed its examples still has a working
 * app, and taking the launch down over four sample rows would be the worst
 * possible trade. Same rule the legacy-data migration follows.
 */
export function seedUtilityScenes(repo: UtilityRepo, settings: SettingsRepo): void {
  try {
    if (settings.get("utility.seeded")) return;
    // The flag is written either way. A database that already holds scenes is
    // one upgraded from a build that seeded differently, or one whose flag was
    // lost — writing rows on top of it would duplicate what is already there,
    // and asking again on every launch would keep paying for the question.
    if (repo.isEmpty()) repo.insertMany(defaultUtilityScenes(mainMessages().seed));
    settings.setMany({ "utility.seeded": true });
  } catch (error) {
    console.warn("[utility] seeding the default scenes failed", error);
  }
}
