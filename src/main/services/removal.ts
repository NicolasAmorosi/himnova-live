import { getDbHandle, getMediaRepo, getOverlaysRepo, getProgramsRepo, getSongsRepo, getUtilityRepo } from "./repos";

/**
 * Deleting what a saved program can point at crosses two repositories:
 * `program_items` (the FK that blocks the delete) and the row's own table, so
 * it lives here rather than in either repo.
 *
 * Without `force`, this is just the repo's delete, which throws the row's
 * `IpcError` (`MEDIA_ASSET_IN_USE`, `OVERLAY_PLATE_IN_USE`, `SONG_IN_USE`,
 * `UTILITY_SCENE_IN_USE`) when a saved program still references it. With
 * `force`, the referencing items are deleted first, in the SAME transaction as
 * the row, so a failure can never leave a program missing a row while what it
 * pointed at survives.
 *
 * Nothing here imports Electron (the engine is told by the IPC handler), so the
 * tests run these as they are.
 */
function removeWithProgramItems(force: boolean, deleteItems: () => void, deleteRow: () => void): void {
  if (!force) {
    deleteRow();
    return;
  }
  getDbHandle().sqlite.transaction(() => {
    deleteItems();
    deleteRow();
  })();
}

export function removeMediaAsset(id: number, force: boolean): void {
  removeWithProgramItems(force, () => getProgramsRepo().deleteItemsByMediaAsset(id), () => getMediaRepo().remove(id));
}

/** Whether the plate is UP is the control window's business, not main's: it
 *  takes the plate down itself (`deletePlate`). */
export function removeOverlayPlate(id: number, force: boolean): void {
  removeWithProgramItems(force, () => getProgramsRepo().deleteItemsByPlate(id), () => getOverlaysRepo().delete(id));
}

export function removeSong(id: number, force: boolean): void {
  removeWithProgramItems(force, () => getProgramsRepo().deleteItemsBySong(id), () => getSongsRepo().delete(id));
}

/**
 * Nothing here touches the projector: `base` holds a resolved COPY of the
 * scene (see `BaseContent`'s `utility` variant), so a countdown that is live
 * keeps counting for the congregation. That is the control window's call, and
 * main has no business making it; see
 * `.claude/knowledge/main-cannot-know-what-is-live-under-an-overlay.md`.
 */
export function removeUtilityScene(id: number, force: boolean): void {
  const deleteItems = (): void => getProgramsRepo().deleteItemsByUtilityScene(id);
  removeWithProgramItems(force, deleteItems, () => getUtilityRepo().delete(id));
}
