import { screen } from "electron";
import type { Handlers } from "../register";
import type { DisplayInfo } from "@shared/types/display";
import { operatorDisplay } from "../../windows/control-window";

/**
 * The label is what the operator picks a projector by in Settings → Screen,
 * so it has to survive the case this app is actually deployed into: a booth
 * with two identical screens. Resolution alone does not — two monitors of the
 * same model are literally the same string, and choosing the wrong one sends
 * the service to the wrong wall.
 *
 * `Display.label` is the device name the OS reports (Electron ≥ 22) and is the
 * only field that distinguishes them. It can come back empty (it regularly
 * does on Linux), so the resolution stays as the fallback and as the suffix —
 * "DELL U2718Q · 3840x2160" tells the operator both which box and which
 * picture. When even that collides, an ordinal is appended, because a Select
 * with two identical options is a coin flip.
 */
function composeLabels(labels: string[]): string[] {
  const seen = new Map<string, number>();
  const total = new Map<string, number>();
  for (const label of labels) total.set(label, (total.get(label) ?? 0) + 1);
  return labels.map((label) => {
    if ((total.get(label) ?? 0) < 2) return label;
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return `${label} #${n}`;
  });
}

export const displaysHandlers: Pick<Handlers, "displays:list"> = {
  "displays:list": (): DisplayInfo[] => {
    const displays = screen.getAllDisplays();
    const operatorId = operatorDisplay().id;
    const labels = composeLabels(
      displays.map((d) => {
        const resolution = `${d.bounds.width}x${d.bounds.height}`;
        const name = d.label.trim();
        return name && name !== resolution ? `${name} · ${resolution}` : resolution;
      }),
    );
    return displays.map((d, i) => ({
      id: d.id,
      label: labels[i] ?? `${d.bounds.width}x${d.bounds.height}`,
      operator: d.id === operatorId,
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
    }));
  },
};
