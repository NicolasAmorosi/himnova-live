import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useUiStore } from "@renderer/stores/ui.store";
import { liveMasterVolume } from "@shared/types/audio";

/**
 * The strips' switch (Settings ▸ Sound, the welcome, «Novedades»). Off, LIVE plays at 100 % (D3), so a master the room
 * heard lower is said; and LIVE's mute goes with them: kept, it silenced LIVE again the moment they came back.
 *
 * On, a «Volumen inicial» under 100 % becomes LIVE's master and goes back to 100 % (owner, 2026-11-15, audit U5): the
 * room keeps its level and the strip shows it, instead of a ceiling the strip hides and its fader cannot pass. At 0 it
 * stays as it is: a master of 0 is not kept (`audio.live.volume` reads it back as 100 %).
 */
export function setAudioStrips(on: boolean): Promise<void> {
  const { settings, update } = useSettingsStore.getState();
  const ui = useUiStore.getState();
  if (!on && settings["audio.strips"]) {
    if (liveMasterVolume(true, settings["audio.live.volume"], ui.liveMuted) < 1) toast.info(t("audio.toastStripsOff"));
    ui.setLiveMuted(false);
  }
  const start = settings["media.volume"];
  if (on && !settings["audio.strips"] && start > 0 && start < 1) {
    toast.info(t("audio.toastStripsOn", { level: String(Math.round(start * 100)) }));
    return update({ "audio.strips": true, "audio.live.volume": start, "media.volume": 1 });
  }
  return update({ "audio.strips": on });
}
