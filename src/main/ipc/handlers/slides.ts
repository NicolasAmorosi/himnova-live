import type { Handlers } from "../register";
import {
  cacheStats,
  cancel,
  clearCache,
  getDeck,
  prepareDeck,
  prewarmExplicit,
  setVisiblePrewarm,
} from "../../slides/deck-service";
import { cancelPrewarmBatch, deckStatuses, startPrewarmBatch } from "../../services/prewarm-service";

export const slidesHandlers: Pick<
  Handlers,
  | "deck:get"
  | "deck:ensure"
  | "deck:cancel"
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

  "deck:cancel": ({ assetId }) => {
    cancel(assetId);
  },

  "deck:prewarm": ({ assetIds, scope }) => {
    if (scope === "visible") setVisiblePrewarm(assetIds);
    else prewarmExplicit(assetIds, scope);
  },

  "deck:prewarmBatch": ({ assetIds, label }) => startPrewarmBatch(assetIds, label),

  "deck:cancelPrewarmBatch": ({ jobId }) => {
    cancelPrewarmBatch(jobId);
  },

  "deck:statuses": ({ assetIds }) => deckStatuses(assetIds),

  "deck:cacheStats": () => cacheStats(),
  "deck:clearCache": () => clearCache(),
};
