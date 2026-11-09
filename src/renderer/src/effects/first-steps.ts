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
  const stops = [
    usePreviewStore.subscribe((state) => {
      if (state.target !== null) markFirstStep("preview");
    }),
    useProjectionStore.subscribe((state) => {
      if (state.base !== null) markFirstStep("live");
      if (state.base?.kind === "song") markFirstStep("song");
      if (state.overlay === "black" || state.overlay === "logo") markFirstStep("cover");
    }),
    useProgramStore.subscribe((state) => {
      if (state.items.length > 0) markFirstStep("schedule");
    }),
    useSettingsStore.subscribe((state) => {
      // Written whenever a saved program is the one open (`App`): saving one, or opening one.
      if (state.settings["programs.openId"] !== null) markFirstStep("save");
    }),
  ];
  return () => stops.forEach((stop) => stop());
}
