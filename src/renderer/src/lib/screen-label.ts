import type { Translate } from "@renderer/lib/i18n/i18n-provider";
import { resolutionLabel, type DisplayInfo } from "@shared/types/display";

/** macOS speaks of a Retina screen in points («se ve como»), Windows and Linux in a scale. */
const ON_MAC = navigator.userAgent.includes("Mac");

/** A screen's resolution as every place that shows one says it (`resolutionLabel`), with the projector's fit when
 *  given. Said here, at render, so it follows a change of language at once. */
export function screenResolution(display: DisplayInfo, t: Translate, fit = 100): string {
  const words = {
    looksLike: (size: string) => t("settings.screens.looksLike", { size }),
    pictureTakes: (size: string) => t("settings.screens.pictureTakes", { size }),
  };
  return resolutionLabel(display.bounds.width, display.bounds.height, display.scaleFactor, ON_MAC, words, fit);
}

/** «Name · resolution», or the resolution alone for a screen with no name. */
export function screenLabel(display: DisplayInfo, t: Translate): string {
  const resolution = screenResolution(display, t);
  return display.name ? `${display.name} · ${resolution}` : resolution;
}
