import { screen, type Display } from "electron";
import type { Handlers } from "../register";
import { projectorFitKey, type DisplayInfo } from "@shared/types/display";
import { operatorDisplay } from "../../windows/control-window";
import { identifyDisplays } from "../../windows/identify-displays";

/**
 * The name is what the operator tells screens apart by in Settings ▸ Screens, so it has to survive the case this
 * app is actually deployed into: a booth with two identical screens. `Display.label` is the device name the OS
 * reports (Electron ≥ 22) and is the only field that distinguishes them; the renderer says it with the resolution
 * (`resolutionLabel`, in its own language), and two of the same model at the same mode would still be literally
 * the same string, so an ordinal is appended: a Select with two identical options is a coin flip. The name can come
 * back empty (it regularly does on Linux) or as a bare size, and then the resolution alone says it.
 */
function screenNames(displays: Display[]): string[] {
  const nameOf = (d: Display) => (/^\d+x\d+$/.test(d.label.trim()) ? "" : d.label.trim());
  const keyOf = (d: Display) => `${nameOf(d)}|${d.bounds.width}x${d.bounds.height}|${d.scaleFactor}`;
  const seen = new Map<string, number>();
  const total = new Map<string, number>();
  for (const d of displays) total.set(keyOf(d), (total.get(keyOf(d)) ?? 0) + 1);
  return displays.map((d) => {
    const name = nameOf(d);
    if ((total.get(keyOf(d)) ?? 0) < 2) return name;
    const n = (seen.get(keyOf(d)) ?? 0) + 1;
    seen.set(keyOf(d), n);
    return name ? `${name} #${n}` : `#${n}`;
  });
}

export const displaysHandlers: Pick<Handlers, "displays:list" | "displays:identify"> = {
  "displays:identify": (screens) => identifyDisplays(screens),
  "displays:list": (): DisplayInfo[] => {
    const displays = screen.getAllDisplays();
    const operatorId = operatorDisplay().id;
    const names = screenNames(displays);
    return displays.map((d, i) => ({
      id: d.id,
      name: names[i] ?? "",
      operator: d.id === operatorId,
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
      fitKey: projectorFitKey(d.label, d.bounds.width, d.bounds.height, d.scaleFactor),
    }));
  },
};
