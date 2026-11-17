import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import type { FirstStepId } from "@shared/types/settings";

/** Ticks a step of «Primeros pasos» the first time it is done, and only while the checklist is open:
 *  what was done before it opened does not count, so the list always ends having been practised. */
export function markFirstStep(id: FirstStepId): void {
  const { settings, update } = useSettingsStore.getState();
  const done = settings["welcome.firstStepsDone"];
  if (!settings["welcome.firstStepsOpen"] || done.includes(id)) return;
  void update({ "welcome.firstStepsDone": [...done, id] });
}

/**
 * «Primeros pasos» learns by watching the stores the work screen already drives — nothing in the work
 * screen knows the checklist exists, but for the Songs tab, whose choice is the resource panel's own state
 * (`ResourcePanel` ticks «song» on opening it: owner, 2026-11-09, no song has to be made). `update` merges synchronously, so a second change in the same tick
 * finds the step already done.
 */
export function startFirstSteps(): () => void {
  // Each on the change that IS the step, never on a state that was already so: any later change of the store (a
  // media report, opening the checklist itself) ticked what was done before it opened (2026-11-15 audit, U9).
  const stops = [
    usePreviewStore.subscribe((state, previous) => {
      if (state.target !== null && state.target !== previous.target) markFirstStep("preview");
    }),
    useProjectionStore.subscribe((state, previous) => {
      if (state.base !== null && state.base !== previous.base) markFirstStep("live");
      if (state.base?.kind === "song" && state.base !== previous.base) markFirstStep("song");
      if ((state.overlay === "black" || state.overlay === "logo") && state.overlay !== previous.overlay) markFirstStep("cover");
    }),
    useProgramStore.subscribe((state, previous) => {
      if (state.items.length > previous.items.length) markFirstStep("schedule");
    }),
    useSettingsStore.subscribe((state, previous) => {
      // Written whenever a saved program is the one open (`App`): saving one, or opening one.
      const open = state.settings["programs.openId"];
      if (open !== null && open !== previous.settings["programs.openId"]) markFirstStep("save");
    }),
  ];
  return () => stops.forEach((stop) => stop());
}
