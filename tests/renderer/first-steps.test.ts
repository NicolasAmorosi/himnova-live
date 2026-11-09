/**
 * «Primeros pasos» ticks itself from the stores the work screen already drives
 * (`effects/first-steps.ts`): each step once, and only while the checklist is open.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { startFirstSteps } from "@renderer/effects/first-steps";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { DEFAULT_SETTINGS, SETTINGS_VALIDATORS } from "@shared/types/settings";

const done = () => useSettingsStore.getState().settings["welcome.firstStepsDone"];
let stop: () => void = () => undefined;

beforeEach(() => {
  (window as unknown as { worship: unknown }).worship = { invoke: () => Promise.resolve({ ok: true, data: null }) };
  useProjectionStore.setState(useProjectionStore.getInitialState(), true);
  usePreviewStore.setState(usePreviewStore.getInitialState(), true);
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, "welcome.firstStepsOpen": true } });
  stop = startFirstSteps();
});
afterEach(() => stop());

test("each thing done ticks its step once, in the order it happened", () => {
  usePreviewStore.getState().setTarget({ kind: "verse", verseIndex: 0 });
  useProjectionStore.getState().setBase({ kind: "bible", text: "…", reference: "Juan 3:16", versionLabel: null });
  useProjectionStore.getState().setOverlay("black");
  useProjectionStore.getState().setOverlay("none");
  expect(done()).toEqual(["preview", "live", "cover"]);
  expect(SETTINGS_VALIDATORS["welcome.firstStepsDone"](done())).toBe(true);
});

test("nothing is ticked while the checklist is closed", () => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, "welcome.firstStepsOpen": false } });
  usePreviewStore.getState().setTarget({ kind: "verse", verseIndex: 0 });
  expect(done()).toEqual([]);
});

test("a stored list with an unknown step is refused", () => {
  expect(SETTINGS_VALIDATORS["welcome.firstStepsDone"](["preview", "fly"])).toBe(false);
  expect(SETTINGS_VALIDATORS["welcome.firstStepsDone"]("preview")).toBe(false);
});
