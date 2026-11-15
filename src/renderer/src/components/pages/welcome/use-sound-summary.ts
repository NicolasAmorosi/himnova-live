import { useT } from "@renderer/lib/i18n/i18n-provider";
import { useSettingsStore } from "@renderer/stores/settings.store";

/** «Con tiras · EN VIVO: … · PREVIEW: …»: the «Sonido» step said in one line, for the summaries
 *  that close the welcome and «Novedades». */
export function useSoundSummary(): string {
  const t = useT();
  const strips = useSettingsStore((s) => s.settings["audio.strips"]);
  const live = useSettingsStore((s) => s.settings["audio.output.live"]);
  const preview = useSettingsStore((s) => s.settings["audio.output.preview"]);
  const stripsText = t(strips ? "welcome.done.stripsOn" : "welcome.done.stripsOff");
  // Both on the system's: said once, or the line wraps on the system's long name.
  if (!live && !preview) return t("welcome.done.soundDefault", { strips: stripsText });
  const name = (choice: { label: string } | null) => choice?.label ?? t("audio.systemDefault");
  return t("welcome.done.soundSummary", { strips: stripsText, live: name(live), preview: name(preview) });
}
