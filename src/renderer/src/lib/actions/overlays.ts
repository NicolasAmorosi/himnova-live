import { api } from "@renderer/lib/api";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import { useOverlayStore } from "@renderer/stores/overlay.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProgramStore } from "@renderer/stores/program.store";
import type { Plate, PlateUpsert, PlateUsage } from "@shared/types/overlay";

/**
 * Overlay plates: the list's CRUD.
 *
 * Putting one UP follows the two-stage flow like everything else: a click
 * previews it (`previewPlate`), and `goLive()` is what puts it on the
 * projector (`goLiveWithPlate`). Taking it down is `hidePlate`.
 *
 * Same rule as `lib/actions/utility.ts` for the list: every write re-reads
 * what main answered instead of patching the array.
 */

export function isPlateUp(id: number): boolean {
  return useProjectionStore.getState().livePlates.some((plate) => plate.id === id);
}

export function hidePlate(id: number): void {
  useProjectionStore.getState().hidePlate(id);
}

export async function loadPlates(): Promise<void> {
  try {
    useOverlayStore.getState().setPlates(await api.overlays.list());
  } catch (error) {
    console.warn("[overlays] could not load the saved plates", error);
    toast.danger(t("overlays.loadError"));
  }
}

/** Creates or updates a plate and re-dresses it in place if it is up —
 *  `setLivePlate`, so the projector redraws it without playing its entrance
 *  again. */
export async function savePlate(input: PlateUpsert): Promise<Plate | null> {
  try {
    const plate =
      input.id === undefined ? await api.overlays.create(input) : await api.overlays.update({ ...input, id: input.id });
    await loadPlates();
    useProjectionStore.getState().setLivePlate(plate);
    return plate;
  } catch (error) {
    console.warn("[overlays] could not save the plate", error);
    toast.danger(t("overlays.saveError"));
    return null;
  }
}

export async function duplicatePlate(id: number, name: string): Promise<Plate | null> {
  try {
    const plate = await api.overlays.duplicate(id, name);
    await loadPlates();
    return plate;
  } catch (error) {
    console.warn("[overlays] could not duplicate the plate", error);
    toast.danger(t("overlays.saveError"));
    return null;
  }
}

/**
 * Deletes a plate. One that is up comes OFF the projector first, and the
 * operator is told so — unlike a time scene, a plate has no resolved copy
 * worth keeping on screen: it would be a plate nobody can take down any more,
 * because its row in the list is gone.
 *
 * `force` is `deleteScene`'s: the operator has read which saved programs use
 * it and confirmed anyway. The unsaved schedule and the preview are cleaned
 * here, since no FK reaches them.
 */
export async function deletePlate(id: number, force = false): Promise<boolean> {
  const wasUp = isPlateUp(id);
  try {
    await api.overlays.remove(id, force);
    if (wasUp) {
      useProjectionStore.getState().hidePlate(id);
      toast.info(t("overlays.deletedWhileUp"));
    }
    await loadPlates();
    useProgramStore.getState().removeByPlate(id);
    const target = usePreviewStore.getState().target;
    if (target?.kind === "plate" && target.plateId === id) usePreviewStore.getState().clear();
    return true;
  } catch (error) {
    console.warn("[overlays] could not delete the plate", error);
    toast.danger(t("overlays.deleteError"));
    return false;
  }
}

/** `isSceneInSchedule`, for a plate. */
export function isPlateInSchedule(id: number): boolean {
  return useProgramStore.getState().items.some((item) => item.kind === "plate" && item.overlayPlateId === id);
}

/** Which saved programs a plate appears in. Never throws — `sceneUsages`'s
 *  contract. */
export async function plateUsages(id: number): Promise<PlateUsage[]> {
  try {
    return await api.overlays.usages(id);
  } catch (error) {
    console.warn("[overlays] could not read the plate's usages", error);
    return [];
  }
}

export async function reorderPlates(ids: number[]): Promise<void> {
  try {
    useOverlayStore.getState().setPlates(await api.overlays.reorder(ids));
  } catch (error) {
    console.warn("[overlays] could not reorder the plates", error);
    toast.danger(t("overlays.reorderError"));
    await loadPlates();
  }
}
