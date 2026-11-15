import { onIpc } from "@renderer/lib/ipc";
import { startLevelTap } from "@renderer/lib/level-tap";
import { previewVideo } from "@renderer/lib/actions/preview-playback";
import { SILENT, useAudioLevelsStore, type StereoLevel } from "@renderer/stores/audio-levels.store";

/**
 * Feeds the audio strips' meters (`audio-levels.store`): LIVE and PREVIEW as main mixes them (`audio-levels`: the
 * media engine's sessions and the projector's own elements), plus PREVIEW's own `<video>`, which plays in this window
 * and is measured here. PREVIEW is the louder of the two, as both would be heard.
 */
export function startAudioLevels(): () => void {
  const { setLevels } = useAudioLevelsStore.getState();
  let fromMain: StereoLevel = SILENT;
  let fromHere: StereoLevel = SILENT;
  const setPreview = () => setLevels("preview", [Math.max(fromMain[0], fromHere[0]), Math.max(fromMain[1], fromHere[1])]);

  const off = onIpc("audio-levels", (buses) => {
    setLevels("live", buses.live);
    fromMain = buses.preview;
    setPreview();
  });
  const stopTap = startLevelTap(
    () => {
      const video = previewVideo();
      return video ? [video] : [];
    },
    (level) => {
      fromHere = level;
      setPreview();
    },
  );
  return () => {
    off();
    stopTap();
    setLevels("live", SILENT);
    setLevels("preview", SILENT);
  };
}
