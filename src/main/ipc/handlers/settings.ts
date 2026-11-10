import type { Handlers } from "../register";
import { getMediaRepo, getSettingsRepo } from "../../services/repos";
import { IpcError } from "@shared/ipc/result";
import { SETTINGS_VALIDATORS, isSettingsKey, type SettingsMap } from "@shared/types/settings";
import { mainMessages, setMainLocale } from "../../i18n";
import { installApplicationMenu } from "../../windows/app-menu";
import { syncStageWindow } from "../../windows/stage-window";
import { factoryVerseStyle } from "../../db/seed/seed-starter-look";
import { profileBackgroundsDir } from "../../paths";
import { syncNdiOutput } from "../../ndi/ndi-output";

/**
 * The IPC contract is a compile-time guarantee, and this is the one channel
 * where that is not enough: it writes durable rows. `registerHandlers` casts
 * `req: unknown` to the declared type and `SettingsRepo.setMany` inserts
 * whatever it is handed — its `if (key in current)` guard protects the
 * in-memory cache, not the table.
 *
 * Rejected as a whole rather than filtered down to the good keys: a caller
 * sending a bad value is a bug, and half-applying its batch would leave the
 * renderer's optimistic state disagreeing with the database in a way nobody
 * ever sees. `settings.store.update` re-reads from main on a rejection, so the
 * UI snaps back to the truth.
 */
function assertValidSettings(partial: Partial<SettingsMap>): void {
  for (const [key, value] of Object.entries(partial)) {
    if (!isSettingsKey(key)) {
      throw new IpcError({ code: "INVALID_SETTING", message: `Unknown setting key: ${key}` });
    }
    if (!SETTINGS_VALIDATORS[key](value)) {
      throw new IpcError({
        code: "INVALID_SETTING",
        message: `Invalid value for setting ${key}: ${JSON.stringify(value)}`,
      });
    }
    // `worship://logo` serves this file: only `files:setLogo`, which decodes the picture the operator chose, picks
    // one. Here it can only be cleared (or left as it is) — any path a renderer wrote was served back to it
    // (2026-11-10 review, agent6-03).
    if (key === "logo.path" && value !== null && value !== getSettingsRepo().get("logo.path")) {
      throw new IpcError({ code: "INVALID_SETTING", message: "logo.path is chosen through files:setLogo" });
    }
  }
}

export const settingsHandlers: Pick<Handlers, "settings:get" | "settings:set" | "settings:factoryVerseStyle"> = {
  "settings:get": () => getSettingsRepo().getAll(),
  "settings:set": (partial) => {
    assertValidSettings(partial);
    getSettingsRepo().setMany(partial);
    // Main speaks the interface language too: its menu, dialogs and errors.
    if (partial["ui.locale"]) {
      setMainLocale(partial["ui.locale"]);
      installApplicationMenu();
    }
    // The projector's screen counts too: the stage never shares it.
    if ("stage.displayId" in partial || "projection.displayId" in partial) syncStageWindow();
    if (Object.keys(partial).some((key) => key.startsWith("ndi.output."))) syncNdiOutput();
  },
  "settings:factoryVerseStyle": () => factoryVerseStyle(getMediaRepo(), profileBackgroundsDir, mainMessages().look),
};
