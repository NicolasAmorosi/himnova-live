import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import { useAudioStore } from "@renderer/stores/audio.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useUiStore } from "@renderer/stores/ui.store";
import { liveMasterVolume } from "@shared/types/audio";

/**
 * The strips' switch (Settings ▸ Sound, the welcome, «Novedades»). Off, LIVE plays at 100 % (D3), so a master the room
 * heard lower is said; and LIVE's mute goes with them: kept, it silenced LIVE again the moment they came back.
 *
 * On, a «Volumen inicial» under 100 % becomes LIVE's master and goes back to 100 % (owner, 2026-11-15, audit U5): the
 * room keeps its level and the strip shows it, instead of a ceiling the strip hides and its fader cannot pass. At 0 it
 * stays as it is: a master of 0 is not kept (`audio.live.volume` reads it back as 100 %). Off again, with the starting
 * volume at 100 %, a master under it goes back to being the starting volume, the way back of the same move: off, LIVE
 * ignores its master, and the room's 50 % became 100 % (review of U5). What is already live keeps its own level, so
 * the room hears it change: the notice says so (owner, 2026-11-16).
 */
/** Something the room hears is live: a video, a deck's clip, or a track. */
function soundingOnAir(): boolean {
  const { presentationOpen, base, liveDeck } = useProjectionStore.getState();
  if (!presentationOpen) return false;
  // `liveDeck` outlives its deck (a verse sent after it keeps it): only the deck on air counts (review of 2026-11-16).
  const deckClips = base?.kind === "deck" && (liveDeck?.videos.length ?? 0) > 0;
  return base?.kind === "video" || deckClips || useAudioStore.getState().tracks.length > 0;
}

export function setAudioStrips(on: boolean): Promise<void> {
  const { settings, update } = useSettingsStore.getState();
  const ui = useUiStore.getState();
  const start = settings["media.volume"];
  if (!on && settings["audio.strips"]) {
    const master = settings["audio.live.volume"];
    const moveBack = start === 1 && master > 0 && master < 1;
    if (!moveBack && liveMasterVolume(true, master, ui.liveMuted) < 1) toast.info(t("audio.toastStripsOff"));
    ui.setLiveMuted(false);
    if (moveBack) {
      const key = soundingOnAir() ? "audio.toastStripsOffKeptLive" : "audio.toastStripsOffKept";
      toast.info(t(key, { level: String(Math.round(master * 100)) }));
      return update({ "audio.strips": false, "media.volume": master, "audio.live.volume": 1 });
    }
  }
  if (on && !settings["audio.strips"] && start > 0 && start < 1) {
    const key = soundingOnAir() ? "audio.toastStripsOnLive" : "audio.toastStripsOn";
    toast.info(t(key, { level: String(Math.round(start * 100)) }));
    return update({ "audio.strips": true, "audio.live.volume": start, "media.volume": 1 });
  }
  return update({ "audio.strips": on });
}
