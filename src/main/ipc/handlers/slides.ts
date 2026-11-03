import type { Handlers } from "../register";
import { cacheStats, clearCache, getDeck, prepareDeck, prewarm } from "../../slides/deck-service";
import { cancelPrewarmBatch, deckStatuses, startPrewarmBatch } from "../../services/prewarm-service";

export const slidesHandlers: Pick<
  Handlers,
  | "deck:get"
  | "deck:ensure"
  | "deck:prewarm"
  | "deck:prewarmBatch"
  | "deck:cancelPrewarmBatch"
  | "deck:statuses"
  | "deck:cacheStats"
  | "deck:clearCache"
> = {
  "deck:get": ({ assetId }) => getDeck(assetId),

  "deck:ensure": ({ assetId, force }) =>
    prepareDeck(assetId, { force: force ?? false, priority: "interactive" }),

  "deck:prewarm": ({ assetIds }) => {
    prewarm(assetIds);
  },

  "deck:prewarmBatch": ({ assetIds, label }) => startPrewarmBatch(assetIds, label),

  "deck:cancelPrewarmBatch": ({ jobId }) => {
    cancelPrewarmBatch(jobId);
  },

  "deck:statuses": ({ assetIds }) => deckStatuses(assetIds),

  "deck:cacheStats": () => cacheStats(),
  "deck:clearCache": () => clearCache(),
};
