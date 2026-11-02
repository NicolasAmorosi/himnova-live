import { cancel as cancelDeckJob } from "../slides/deck-service";
import { getDbHandle, getMediaRepo, getProgramsRepo } from "./repos";
import { forgetEngineAsset } from "../media/engine-assets";

/**
 * Deleting a media asset crosses two repositories — `program_items` (the FK
 * that blocks the delete) and `media_assets` itself — so it lives here rather
 * than in either repo. Without `force`, this is just `MediaRepo.remove()`,
 * which still throws `IpcError("MEDIA_ASSET_IN_USE")` when the asset is in a
 * saved program. With `force`, the referencing items are deleted first, in
 * the same transaction as the asset, so a failure never leaves items gone
 * without the asset actually being removed.
 */
export function removeMediaAsset(id: number, force: boolean): void {
  if (!force) {
    // `remove()` throws MEDIA_ASSET_IN_USE when a saved program references the
    // asset, so the job is cancelled only once the row is actually gone —
    // cancelling first would kill a conversion for an asset that survives.
    getMediaRepo().remove(id);
    cancelDeckJob(id);
    forgetEngineAsset(id);
    return;
  }

  // Before the transaction, not after: a conversion that finished mid-delete
  // would insert a slides row for an asset that no longer exists.
  cancelDeckJob(id);
  const { sqlite } = getDbHandle();
  const run = sqlite.transaction(() => {
    getProgramsRepo().deleteItemsByMediaAsset(id);
    getMediaRepo().remove(id);
  });
  run();
  forgetEngineAsset(id);
}
