import { useAudioStore } from "@renderer/stores/audio.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { mediaTargetKey, SLIDE_VIDEO_STATUS_KEY, VIDEO_STATUS_KEY } from "@shared/types/projection";

/**
 * Folds "where each live media element actually is" back into "where it would
 * start if it had to be mounted again".
 *
 * `startAtSeconds` is a mount-time seek, not a position: the projection window
 * applies it exactly once per element (`AudioTrackElement`, `LiveVideo`) and
 * never again. That is right for as long as the element lives, and wrong the
 * moment it has to be rebuilt — which is precisely what closing, reopening or
 * moving the projection window does. Replaying main's snapshot into a fresh
 * window mounted every audio track and the live video at the point the
 * operator originally chose, so a ten-minute backing track went back to zero.
 *
 * For a deck with a soundtrack it was worse than restarted audio: in "synced"
 * mode the slide cursor is derived from the audio clock
 * (`effects/deck-autoplay.ts`), and that module's `seededEpoch` recovery has
 * already been spent on the deck's first play — nothing re-seeks the new
 * element. A soundtrack back at 0 therefore dragged the deck back to slide 1
 * in front of the congregation.
 *
 * Called only by whoever is about to lose the projection window. The last
 * `mediaStatus` report is at most one `timeupdate` tick old (~250 ms), which
 * is the best answer available and needs no new channel — main deliberately
 * knows nothing about what is live. Elements that never reported are left
 * alone, and nothing else about a track is touched: `paused` is the operator's
 * own declarative state and has to survive untouched.
 */
export function freezeLivePositions(): void {
  const projection = useProjectionStore.getState();
  const { mediaStatus } = projection;

  const positions = new Map<string, number>();
  for (const track of useAudioStore.getState().tracks) {
    const status = mediaStatus[mediaTargetKey({ kind: "audio", trackId: track.trackId })];
    // Same epoch guard as `end-of-playback.ts`: the deck's soundtrack reuses
    // one status key across decks and plays, so a report still describing the
    // previous one must never be written back as this track's resume point.
    if (status && status.epoch === track.epoch) {
      positions.set(track.trackId, status.currentTimeSeconds);
    }
  }
  useAudioStore.getState().setStartPositions(positions);

  const { base } = projection;

  // A video embedded in the live slide is the same mount-time seek as every
  // other element here, and forgetting it has the same cost: moving the
  // projector to another screen mid-service would restart the clip from zero.
  // Guarded by `slideVideoEpoch` for the reason the tracks above are — the
  // slot is reused by every slide, so a report describing the previous one
  // must never become this one's resume point.
  if (base?.kind === "deck") {
    const slideVideoStatus = mediaStatus[SLIDE_VIDEO_STATUS_KEY];
    if (slideVideoStatus && slideVideoStatus.epoch === projection.slideVideoEpoch) {
      projection.setSlideVideoResumeAt(slideVideoStatus.currentTimeSeconds);
    }
    return;
  }

  if (base?.kind !== "video") return;
  const videoStatus = mediaStatus[VIDEO_STATUS_KEY];
  if (videoStatus && videoStatus.epoch === base.epoch) {
    projection.setVideoResumeAt(videoStatus.currentTimeSeconds);
  }
}
