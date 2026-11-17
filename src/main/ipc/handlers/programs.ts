import type { Handlers } from "../register";
import { getProgramsRepo, getSlidesRepo } from "../../services/repos";
import { pinDecks } from "../../slides/deck-service";
import type { ProgramDTO } from "@shared/types/program";

/** The program the operator opened, whose decks are pinned. */
let currentProgramId: number | null = null;

/**
 * Protects the loaded service's decks from LRU eviction.
 *
 * `pinDecks`'s `"program"` reason once had no caller, so a deck sitting in the open order of
 * service was evictable mid-service, exactly what the pin exists to prevent —
 * masked only by `evictIfOverCap`'s 24h recency grace.
 *
 * Pins are by deck id, so an unconverted PPT contributes nothing yet — that is
 * correct: there is no cache directory to protect until it converts, and
 * conversion is what `loadProgram`'s prewarm (renderer side, `"program"` lane)
 * is already asking for.
 */
/** The exact inverse of `adoptProgram`: nothing is the current program any
 *  more, so the program's decks go back to being ordinary eviction candidates. */
function releaseCurrentProgram(): void {
  currentProgramId = null;
  pinDecks("program", []);
}

function adoptProgram(program: ProgramDTO): ProgramDTO {
  currentProgramId = program.id;
  const assetIds = program.items
    .filter((item) => item.kind === "ppt")
    .map((item) => item.mediaAssetId);
  const statuses = getSlidesRepo().statusesByAsset(assetIds);
  pinDecks("program", [...statuses.values()].map((row) => row.deckId));
  return program;
}

export const programsHandlers: Pick<
  Handlers,
  | "programs:list"
  | "programs:load"
  | "programs:peek"
  | "programs:save"
  | "programs:delete"
  | "programs:releaseCurrent"
  | "programs:updateMeta"
  | "programs:duplicate"
  | "programs:setFavorite"
  | "programs:reorder"
> = {
  "programs:list": () => getProgramsRepo().list(),
  "programs:load": ({ id }) => adoptProgram(getProgramsRepo().load(id)),
  // Deliberately NOT `adoptProgram`: the programs modal opens its preview
  // panel on a single click, and routing that through `programs:load` moved
  // the anti-eviction deck pins onto a program the
  // operator was only looking at — while `program.store.currentProgramId` in
  // the renderer never changed, leaving main and renderer disagreeing about
  // which program is open.
  "programs:peek": ({ id }) => getProgramsRepo().peek(id),
  "programs:save": (input) => {
    const summary = getProgramsRepo().save(input);
    // Saving is also how an unsaved service first gets an id, and its decks their pin.
    adoptProgram(getProgramsRepo().load(summary.id));
    return summary;
  },
  "programs:delete": ({ id }) => {
    getProgramsRepo().delete(id);
    // Deleting the open program left its decks pinned against eviction
    // forever, since nothing ever replaced the `"program"` set.
    if (id === currentProgramId) releaseCurrentProgram();
  },

  "programs:releaseCurrent": () => {
    releaseCurrentProgram();
  },
  "programs:updateMeta": (input) => getProgramsRepo().updateMeta(input),
  "programs:duplicate": (input) => getProgramsRepo().duplicate(input),
  "programs:setFavorite": ({ id, favorite }) => getProgramsRepo().setFavorite(id, favorite),
  "programs:reorder": ({ ids }) => getProgramsRepo().reorder(ids),
};
