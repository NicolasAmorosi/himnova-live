import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import { useDisplayStore } from "@renderer/stores/display.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { projectorDisplayFor } from "@shared/display-roles";

/** What a screen does: the projector's, the stage's, or nothing (the operator's own reads «only control»). */
export type ScreenRole = "projector" | "stage" | "none";

/** On the operator's own screen both can be at once, as movable windows (one screen, or testing): there the
 *  stage is what the row says, since the projector falls back to it whatever is chosen. */
export function screenRole(id: number, projectorId: number | null, stageId: number | null, operator = false): ScreenRole {
  if (operator && id === stageId) return "stage";
  return id === projectorId ? "projector" : id === stageId ? "stage" : "none";
}

const nameOf = (id: number): string => useDisplayStore.getState().displays.find((d) => d.id === id)?.label ?? String(id);

/**
 * Gives `id` a role, and the roles exclude each other (plan 2026-11-13 §2.4): the projector given the stage's screen
 * leaves the stage without one, and the stage given the projector's screen moves the projector to another
 * (`projectorDisplayFor`) — each said in a toast, never in silence. The projector always has a screen, so «none»
 * only takes a screen from the stage.
 */
export async function assignScreenRole(id: number, role: ScreenRole): Promise<void> {
  const display = useDisplayStore.getState();
  const settings = useSettingsStore.getState();
  const stageId = settings.settings["stage.displayId"];
  if (role === "projector") {
    if (stageId === id) {
      await settings.update({ "stage.displayId": null });
      toast.info(t("settings.screens.stageTakenByProjector", { name: nameOf(id) }));
    }
    if (display.displayId !== id) await display.setDisplayId(id);
    return;
  }
  if (role === "stage") {
    if (stageId === id) return;
    await settings.update({ "stage.displayId": id });
    const operatorId = display.displays.find((d) => d.operator)?.id ?? id;
    // The operator's own screen holds both, as movable windows: the projector stays.
    if (display.displayId === id && id !== operatorId) {
      const moved = projectorDisplayFor(display.displays.map((d) => d.id), operatorId, null, id);
      if (moved !== null && moved !== id) {
        await display.setDisplayId(moved);
        toast.info(t("settings.screens.projectorMoved", { name: nameOf(moved) }));
      }
    }
    return;
  }
  if (stageId === id) await settings.update({ "stage.displayId": null });
}
