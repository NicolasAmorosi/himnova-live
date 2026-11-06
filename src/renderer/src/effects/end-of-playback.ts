import { useProjectionStore, type ProjectionStoreState } from "@renderer/stores/projection.store";
import { DECK_SOUNDTRACK_TRACK_ID } from "@renderer/stores/audio.store";
import { clearBaseContent, clearBaseContentUnder, goLiveWithNextScheduleItem } from "@renderer/lib/actions/playback";
import { mediaTargetKey } from "@shared/types/projection";

const VIDEO_STATUS_KEY = mediaTargetKey({ kind: "video" });
const DECK_AUDIO_STATUS_KEY = mediaTargetKey({ kind: "audio", trackId: DECK_SOUNDTRACK_TRACK_ID });

/**
 * A video or an auto-advancing deck that finished playing on its own — as
 * opposed to one the operator cut away from — never stays frozen on the
 * projector. This mirrors the existing rule for a standalone audio track
 * (`projection-sync.ts`'s `ended` handler), extended to content that
 * actually occupies `base`.
 *
 * `MediaStatus.ended` is sticky on the DOM element and gets rebroadcast on
 * mount (`use-media-status-reporter.ts`), and the deck soundtrack always
 * reuses the same target key (`audio:deck-soundtrack`) across different
 * decks/plays. Comparing `status.epoch` against the *current* epoch is what
 * stops a stale `ended: true` from an earlier video or an earlier deck's
 * soundtrack from clearing the new one.
 */
function selectFinishedLiveContent(state: ProjectionStoreState): "video" | "deck" | null {
  const { base } = state;
  if (!base) return null;

  if (base.kind === "video") {
    const status = state.mediaStatus[VIDEO_STATUS_KEY];
    if (status?.ended && status.epoch === base.epoch) return "video";
    return null;
  }

  if (base.kind === "deck") {
    if (!state.liveDeck?.autoAdvance || state.autoplay !== "finished") return null;
    if (!state.liveDeck.soundtrack) return "deck";
    const status = state.mediaStatus[DECK_AUDIO_STATUS_KEY];
    if (status?.ended && status.epoch === state.soundtrackEpoch) return "deck";
    return null;
  }

  return null;
}

/**
 * Registers the auto-clear rule. Runs in the control window only, alongside
 * the other effects (`projection-sync.ts`) — the projection window stays a
 * pure function of `ProjectionOutput` and never decides this on its own.
 */
export function startEndOfPlaybackEffects(): () => void {
  return useProjectionStore.subscribe(selectFinishedLiveContent, (finished) => {
    if (finished === "deck") clearBaseContent();
    if (finished !== "video") return;
    // The operator's choice (`projection.videoEnd`). A looping video never
    // ends; one held on its last frame stays until the operator moves on —
    // stopped, and the store says so: `videoPaused` still false left the LIVE
    // row offering «Pausar» over a still picture, and its first press paused
    // nothing. Paused, «Reproducir» plays it again from the top.
    const { setVideoPaused, videoEnd } = useProjectionStore.getState();
    if (videoEnd === "hold") setVideoPaused(true);
    if (videoEnd === "logo" || videoEnd === "black") clearBaseContentUnder(videoEnd);
    // Nothing after it in the schedule (or not from the schedule): the logo.
    if (videoEnd === "next") void goLiveWithNextScheduleItem().then((moved) => moved || clearBaseContent());
  });
}
