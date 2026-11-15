import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useUiStore } from "@renderer/stores/ui.store";
import { liveMasterVolume } from "@shared/types/audio";

/**
 * The strips' switch (Settings ▸ Sound, the welcome, «Novedades»). Off, LIVE plays at 100 % (D3), so a master the room
 * heard lower is said; and LIVE's mute goes with them: kept, it silenced LIVE again the moment they came back.
 */
export function setAudioStrips(on: boolean): Promise<void> {
  const { settings, update } = useSettingsStore.getState();
  const ui = useUiStore.getState();
  if (!on && settings["audio.strips"]) {
    if (liveMasterVolume(true, settings["audio.live.volume"], ui.liveMuted) < 1) toast.info(t("audio.toastStripsOff"));
    ui.setLiveMuted(false);
  }
  return update({ "audio.strips": on });
}
