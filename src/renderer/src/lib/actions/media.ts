import { useProjectionStore } from "@renderer/stores/projection.store";
import { useAudioStore, DECK_SOUNDTRACK_TRACK_ID } from "@renderer/stores/audio.store";
import { toggleAutoplay } from "@renderer/effects/deck-autoplay";
import { api } from "@renderer/lib/api";
import { mediaTargetKey, type MediaTarget } from "@shared/types/projection";

/**
 * Sets the level of one live media target, 0..1.
 *
 * Declarative on purpose — it writes the store, which rides out to the
 * projector inside `VideoUnderlay`/`AudioTrackPush`, rather than sending a
 * one-shot command to the element. A command would be lost by every remount
 * (a new epoch, the projection window rebuilt onto another screen), leaving
 * the panel showing a level the room cannot hear. Same rule as `paused`.
 */
export function setMediaVolume(target: MediaTarget, volume: number): void {
  switch (target.kind) {
    case "video":
      useProjectionStore.getState().setVideoVolume(volume);
      return;
    case "slideVideo":
      useProjectionStore.getState().setSlideVideoVolume(volume);
      return;
    case "audio":
      useAudioStore.getState().setVolume(target.trackId, volume);
      return;
  }
}

/** Pauses/resumes the live video. Declarative — see `VideoUnderlay.paused` —
 *  so it survives a BLACK/LOGO round-trip instead of BLACK silently
 *  overriding an operator's explicit pause. */
export function toggleVideoPause(): void {
  const { base, mediaStatus, videoPaused, setVideoPaused } = useProjectionStore.getState();
  // A video held on its last frame («Al terminar»: hold) plays again from the
  // top. Chromium's `<video>` would restart by itself, the media engine
  // (`keep-open`) would only unpause on its last frame.
  const status = mediaStatus[mediaTargetKey({ kind: "video" })];
  if (videoPaused && base?.kind === "video" && status?.ended && status.epoch === base.epoch) {
    seekMedia({ kind: "video" }, 0);
  }
  setVideoPaused(!videoPaused);
}

/** Pauses/resumes the video embedded in the live slide. Declarative for the
 *  same reason `toggleVideoPause` is, and deliberately independent of it: a
 *  slide video and a full-screen video are never live at the same time, but
 *  they are two different elements with two different pauses, and sharing one
 *  flag would make the projector's state depend on which of them was live
 *  last. Never touches the deck's auto-advance: pausing a clip is not pausing
 *  the presentation. */
export function toggleSlideVideoPause(): void {
  const { slideVideoPaused, setSlideVideoPaused } = useProjectionStore.getState();
  setSlideVideoPaused(!slideVideoPaused);
}

/**
 * Pauses/resumes one audio track. The deck's own soundtrack is special-cased
 * to `toggleAutoplay()` (`effects/deck-autoplay.ts`) rather than flipping
 * `paused` directly — pausing that track has to pause the slide auto-advance
 * with it, since the two are the same clock (per-product decision: pausing
 * a PPT's music pauses the PPT).
 */
export function toggleAudioTrackPause(trackId: string): void {
  // Only a deck that advances by itself shares a clock with its music. A
  // manual deck's autoplay stays "off" for good, so routing its music here too
  // made the pause button on that row a no-op: the only ways left to silence
  // it were BLACK/LOGO or taking the deck off the air.
  if (trackId === DECK_SOUNDTRACK_TRACK_ID && useProjectionStore.getState().liveDeck?.autoAdvance) {
    toggleAutoplay();
    return;
  }
  const track = useAudioStore.getState().tracks.find((t) => t.trackId === trackId);
  if (track) useAudioStore.getState().setPaused(trackId, !track.paused);
}

/** One-shot seek command — the target is already playing, this just moves it. */
export function seekMedia(target: MediaTarget, seconds: number): void {
  void api.projection.mediaCommand({ target, action: "seek", timeSeconds: Math.max(0, seconds) });
}

/**
 * Back to the beginning, leaving play/pause exactly as it was.
 *
 * A seek to 0 and NOT the `"restart"` command, which also calls `play()` on
 * the element (see `ProjectionApp`'s media-command handler) — that is what
 * `restartDeck()` wants, because restarting a deck IS starting it again. Here
 * it would be a lie twice over: the operator who paused a track and rewound
 * it did not ask for it to sound, and `paused` is declarative state in the
 * store (`CLAUDE.md`), so an element playing behind a store that still says
 * "paused" leaves the panel showing a pause button while the room hears the
 * track.
 */
export function restartMedia(target: MediaTarget): void {
  seekMedia(target, 0);
}

/** Stops a standalone audio track and drops its row — never available for the
 *  video or the deck's soundtrack, so there is no button anywhere that can
 *  cut what's actually on the projector. */
export function stopAudioTrack(trackId: string): void {
  useAudioStore.getState().removeTrack(trackId);
}
