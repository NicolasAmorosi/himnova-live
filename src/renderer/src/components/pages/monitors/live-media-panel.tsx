import type { ReactNode } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { MediaPanel } from "@renderer/components/ui";
import { MediaTrackRow } from "@renderer/components/shared/media-track-row";
import { UtilityTrackRow } from "@renderer/components/shared/utility-track-row";
import { PlateTrackRow } from "@renderer/components/shared/plate-track-row";
import { selectOutputMemo, useProjectionStore } from "@renderer/stores/projection.store";
import { useAudioStore } from "@renderer/stores/audio.store";
import { useLiveHeading } from "@renderer/lib/hooks/use-live";
import {
  restartMedia,
  seekMedia,
  setMediaVolume,
  stopAudioTrack,
  toggleAudioTrackPause,
  toggleSlideVideoPause,
  toggleVideoPause,
} from "@renderer/lib/actions/media";
import { clearBaseContent } from "@renderer/lib/actions/playback";
import { hidePlate } from "@renderer/lib/actions/overlays";
import { mediaErrorKey, mediaTargetKey } from "@shared/types/projection";
import { assetUrl } from "@shared/urls";

const VIDEO_STATUS_KEY = mediaTargetKey({ kind: "video" });
const VIDEO_ERROR_KEY = mediaErrorKey({ kind: "video" });
const SLIDE_VIDEO_STATUS_KEY = mediaTargetKey({ kind: "slideVideo" });
const SLIDE_VIDEO_ERROR_KEY = mediaErrorKey({ kind: "slideVideo" });

/**
 * The global media control — every audio-producing thing live right now, in
 * one place: the video (if the base content is one), the current deck's own
 * soundtrack (if it has one), and every standalone audio track sent live
 * independently. Any number of these can sound at once; this panel is what
 * keeps that legible instead of leaving the operator guessing what's on.
 * A live image gets a row too, even though it has nothing to play — just its
 * name and a way to clear it back to empty. A live time scene gets the full
 * transport of its clock, which is the one live thing whose value moves
 * without anybody touching it. Every plate that is up gets one too — its
 * auto-hide count and the X that takes it down.
 *
 * Renders nothing at all when silent, so a service with no audio in play
 * looks exactly like it did before this panel existed.
 */
export function LiveMediaPanel() {
  const t = useT();
  const base = useProjectionStore((s) => s.base);
  // The memoized output, for the one live thing this panel cannot derive from
  // `base` alone: whether the CURRENT slide of the live deck carries a video.
  // Identity is stable across unrelated store writes, so subscribing to the
  // whole output costs nothing beyond the re-render a slide change already
  // causes here (the heading moves with it).
  const slideVideo = useProjectionStore(selectOutputMemo).slideVideo;
  const slideVideoPaused = useProjectionStore((s) => s.slideVideoPaused);
  const videoPaused = useProjectionStore((s) => s.videoPaused);
  const videoVolume = useProjectionStore((s) => s.videoVolume);
  // The whole record, not a per-target selector: the number of rows below is
  // dynamic (0..N audio tracks), so there is no fixed set of hooks to call
  // one-per-track — see the Rules of Hooks. Indexing a single subscribed
  // object during render is still reactive and stays simple.
  const mediaStatus = useProjectionStore((s) => s.mediaStatus);
  const mediaErrors = useProjectionStore((s) => s.mediaErrors);
  const audioTracks = useAudioStore((s) => s.tracks);
  const livePlates = useProjectionStore((s) => s.livePlates);
  const heading = useLiveHeading();

  /** Only surface an error that still describes the url this row is about —
   *  same rule the monitors' notice follows, so the panel and the stage can
   *  never disagree about whether something is broken. */
  function errorFor(key: string, url: string): string | undefined {
    return mediaErrors[key]?.url === url ? t("media.loadErrorRow") : undefined;
  }

  const rows: ReactNode[] = [];

  if (base?.kind === "video") {
    const status = mediaStatus[VIDEO_STATUS_KEY];
    rows.push(
      <MediaTrackRow
        currentSeconds={status?.currentTimeSeconds ?? 0}
        durationSeconds={status?.durationSeconds ?? 0}
        error={errorFor(VIDEO_ERROR_KEY, base.url)}
        key="video"
        kind="video"
        label={heading ?? ""}
        offAir
        onDelete={clearBaseContent}
        onRestart={() => restartMedia({ kind: "video" })}
        onSeek={(seconds) => seekMedia({ kind: "video" }, seconds)}
        onTogglePause={toggleVideoPause}
        onVolumeChange={(volume) => setMediaVolume({ kind: "video" }, volume)}
        paused={videoPaused}
        volume={videoVolume}
      />,
    );
  }

  if (base?.kind === "image") {
    rows.push(
      <MediaTrackRow
        error={errorFor(mediaErrorKey({ kind: "scene" }), assetUrl(base.assetId))}
        key="image"
        kind="image"
        label={heading ?? ""}
        offAir
        onDelete={clearBaseContent}
      />,
    );
  }

  if (base?.kind === "utility") {
    // The whole transport of the live scene, not just a way to dismiss it:
    // this panel is where the operator controls everything that is on the
    // projector right now, and a countdown is the one live thing whose value
    // changes on its own. Its own row (`UtilityTrackRow`) rather than a bare
    // `MediaTrackRow`, because which controls a time scene deserves depends on
    // its tool — see that component.
    rows.push(<UtilityTrackRow key="utility" offAir onDelete={clearBaseContent} scene={base.scene} />);
  }

  // A deck's slide can carry its own clip. Its own row rather than folded into
  // the deck's music, because the two are genuinely separate elements: pausing
  // the clip must not pause the presentation, which is exactly what pausing
  // the soundtrack does (`toggleAudioTrackPause`).
  //
  // No `onDelete`: there is nothing here to clear on its own. Dismissing this
  // would mean taking the deck off the projector, and that button belongs to
  // the deck, not to one slide's video.
  if (slideVideo) {
    const status = mediaStatus[SLIDE_VIDEO_STATUS_KEY];
    rows.push(
      <MediaTrackRow
        currentSeconds={status?.currentTimeSeconds ?? 0}
        durationSeconds={status?.durationSeconds ?? 0}
        error={errorFor(SLIDE_VIDEO_ERROR_KEY, slideVideo.url)}
        key="slide-video"
        kind="video"
        label={t("media.slideVideo", { title: heading ?? "" })}
        onRestart={() => restartMedia({ kind: "slideVideo" })}
        onSeek={(seconds) => seekMedia({ kind: "slideVideo" }, seconds)}
        onTogglePause={toggleSlideVideoPause}
        onVolumeChange={(volume) => setMediaVolume({ kind: "slideVideo" }, volume)}
        paused={slideVideoPaused}
        volume={slideVideo.volume}
      />,
    );
  }

  // Every plate that is up, with what it has left and a way down. Covered or
  // not: a plate under BLACK is still up, and still has to be takeable down.
  for (const plate of livePlates) {
    rows.push(<PlateTrackRow key={`plate-${plate.id}`} offAir onDelete={() => hidePlate(plate.id)} plate={plate} />);
  }

  for (const track of audioTracks) {
    const status = mediaStatus[mediaTargetKey({ kind: "audio", trackId: track.trackId })];
    const isDeck = track.source === "deck";
    rows.push(
      <MediaTrackRow
        currentSeconds={status?.currentTimeSeconds ?? 0}
        durationSeconds={status?.durationSeconds ?? 0}
        error={errorFor(mediaErrorKey({ kind: "audio", trackId: track.trackId }), track.url)}
        key={track.trackId}
        kind="audio"
        label={isDeck ? t("media.deckMusic", { title: heading ?? "" }) : track.label}
        // Never on the deck's own music: the transport under the LIVE monitor
        // already has a restart, and that one puts the slide cursor back to 1
        // with it. A second button that rewound only the audio would leave the
        // soundtrack playing under the wrong slide — the two are one clock
        // (`effects/deck-autoplay.ts`).
        onRestart={isDeck ? undefined : () => restartMedia({ kind: "audio", trackId: track.trackId })}
        onSeek={(seconds) => seekMedia({ kind: "audio", trackId: track.trackId }, seconds)}
        onStop={isDeck ? undefined : () => stopAudioTrack(track.trackId)}
        onTogglePause={() => toggleAudioTrackPause(track.trackId)}
        onVolumeChange={(volume) => setMediaVolume({ kind: "audio", trackId: track.trackId }, volume)}
        paused={track.paused}
        volume={track.volume}
      />,
    );
  }

  if (rows.length === 0) return null;

  // Capped and scrolling on its own: it sits right under the monitor, so it
  // must never push the live grid out of the column — see `MonitorsColumn`.
  return <MediaPanel className="max-h-[40%] shrink-0 overflow-y-auto">{rows}</MediaPanel>;
}
