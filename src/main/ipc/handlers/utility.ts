import type { Handlers } from "../register";
import { getProgramsRepo, getUtilityRepo } from "../../services/repos";
import { removeUtilityScene } from "../../services/removal";
import { IpcError } from "@shared/ipc/result";
import { isSceneName, isUtilitySceneUpsert } from "@shared/scene-validators";
import type { UtilityScene } from "@shared/types/utility";
import { mt } from "../../i18n";

/**
 * Saved time scenes. CRUD and nothing else — main deliberately knows nothing
 * about which scene is on the projector or which timer is armed: that is the
 * control window's, and `.claude/knowledge/main-cannot-know-what-is-live-under-an-overlay.md`
 * is the entry that explains why a guard here that is right 95 % of the time
 * is worse than no guard at all.
 *
 * Every write validates the WHOLE scene first. `registerHandlers` casts the
 * request from `unknown` straight to its declared type, the renderer is
 * another process, and a row written wrong outlives the session that wrote it
 * — the same argument `SETTINGS_VALIDATORS` makes, applied to a bigger shape.
 */
function assertValid(input: unknown): Omit<UtilityScene, "id"> {
  if (!isUtilitySceneUpsert(input)) {
    throw new IpcError({ code: "INVALID_UTILITY_SCENE", message: mt("scenes.invalid") });
  }
  const { id: _id, ...scene } = input;
  return scene;
}

export const utilityHandlers: Pick<
  Handlers,
  | "utility:list"
  | "utility:create"
  | "utility:update"
  | "utility:duplicate"
  | "utility:delete"
  | "utility:usages"
  | "utility:reorder"
> = {
  "utility:list": () => getUtilityRepo().list(),
  "utility:create": (input) => getUtilityRepo().create(assertValid(input)),
  "utility:update": (input) => getUtilityRepo().update(input.id, assertValid(input)),
  "utility:duplicate": ({ id, name }) => {
    if (!isSceneName(name)) {
      throw new IpcError({ code: "INVALID_UTILITY_SCENE", message: mt("scenes.invalidName") });
    }
    return getUtilityRepo().duplicate(id, name.trim());
  },
  "utility:delete": ({ id, force }) => {
    removeUtilityScene(id, force ?? false);
  },
  "utility:usages": ({ id }) => getProgramsRepo().findSceneUsages(id),
  "utility:reorder": ({ ids }) => getUtilityRepo().reorder(ids),
};
