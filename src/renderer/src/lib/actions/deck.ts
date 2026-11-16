import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import { useDeckStore } from "@renderer/stores/deck.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { survivingAssetId } from "@renderer/stores/program.store";

/**
 * "Convert again" from the slide grid.
 *
 * A forced reconversion replaces the deck row that has the same identity
 * (contentHash + renderWidth + imageFormat — see `insertDeck` in
 * `slides.repo.ts`), and replacing it means deleting the old row and its
 * slides. If that deck is the one on the projector, its
 * `worship://deck/<id>/<n>` urls start answering 404 underneath it: every
 * slide Chromium has not already decoded turns black, mid-service, and stays
 * that way until the conversion finishes.
 *
 * So the rule is the operator's own: what is live is not reconverted. The
 * check lives here rather than in main because this is the only place that
 * knows what is live *under an overlay* — main sees nothing but the last
 * `ProjectionOutput`, and BLACK or LOGO over a deck is indistinguishable
 * there from no deck at all.
 */
export function reconvertDeck(assetId: number): void {
  const base = useProjectionStore.getState().base;
  if (base?.kind === "deck" && survivingAssetId(base.assetId) === assetId) {
    toast.warning(t("deck.reconvertBlockedLive"));
    return;
  }
  void useDeckStore.getState().ensure(assetId, true);
}
