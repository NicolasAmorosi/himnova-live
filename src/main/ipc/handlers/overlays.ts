import type { Handlers } from "../register";
import { getOverlaysRepo, getProgramsRepo } from "../../services/repos";
import { removeOverlayPlate } from "../../services/removal";
import { IpcError } from "@shared/ipc/result";
import { isPlateName, isPlateUpsert } from "@shared/overlay-validators";
import type { Plate } from "@shared/types/overlay";
import { mt } from "../../i18n";

/** Saved overlay plates. CRUD only, every write validated whole — the same
 *  reasoning as `handlers/utility.ts`. */
function assertValid(input: unknown): Omit<Plate, "id"> {
  if (!isPlateUpsert(input)) {
    throw new IpcError({ code: "INVALID_OVERLAY_PLATE", message: mt("plates.invalid") });
  }
  const { id: _id, ...plate } = input;
  return plate;
}

export const overlaysHandlers: Pick<
  Handlers,
  | "overlay:list"
  | "overlay:create"
  | "overlay:update"
  | "overlay:duplicate"
  | "overlay:delete"
  | "overlay:usages"
  | "overlay:reorder"
> = {
  "overlay:list": () => getOverlaysRepo().list(),
  "overlay:create": (input) => getOverlaysRepo().create(assertValid(input)),
  "overlay:update": (input) => getOverlaysRepo().update(input.id, assertValid(input)),
  "overlay:duplicate": ({ id, name }) => {
    if (!isPlateName(name)) {
      throw new IpcError({ code: "INVALID_OVERLAY_PLATE", message: mt("plates.invalidName") });
    }
    return getOverlaysRepo().duplicate(id, name.trim());
  },
  "overlay:delete": ({ id, force }) => {
    removeOverlayPlate(id, force ?? false);
  },
  "overlay:usages": ({ id }) => getProgramsRepo().findPlateUsages(id),
  "overlay:reorder": ({ ids }) => getOverlaysRepo().reorder(ids),
};
