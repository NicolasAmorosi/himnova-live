import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { api } from "@renderer/lib/api";
import { onIpc } from "@renderer/lib/ipc";
import { OutputView } from "@renderer/components/shared/output-view";
import { useMediaStatusReporter } from "./use-media-status-reporter";
import { INSTANT_TRANSITION } from "@shared/types/projection";
import { isEngineUrl } from "@shared/urls";
import type {
  AudioTrackPush,
  MediaCommand,
  ProjectionMediaError,
  ProjectionOutput,
} from "@shared/types/projection";

/** The projector reports what it cannot play and shows nothing about it — the
 *  congregation must never see a warning. Telling the operator is the control
 *  window's job (see `projection-sync.ts`). */
function reportMediaError(error: ProjectionMediaError): void {
  void api.projection.reportMediaError(error);
}

/** This page as the NDI® output's offscreen copy of the projection (`main/ndi/ndi-output.ts`): the same
 *  pixels, but it is not the projector — it reports nothing (the panel would see every video twice),
 *  mounts no audio track (main mutes it too: the room hears the projector) and its errors are the
 *  projector's to report. */
const IS_NDI_OUTPUT = new URLSearchParams(window.location.search).get("role") === "ndi";
const NO_ELEMENT: RefObject<HTMLMediaElement | null> = { current: null };

type AudioTrackElementProps = {
  /** The shared `trackId -> element` map `media-command` routes through. Passed
   *  as the map itself rather than as a per-track callback so the `ref` below
   *  can be stable: a fresh closure every render makes React detach and
   *  reattach the ref on every one of them (`delete` then `set`), and a command
   *  arriving inside that window finds no element at all. */
  registry: Map<string, HTMLAudioElement>;
  track: AudioTrackPush;
};

/**
 * One live audio track. Any number of these can be mounted at once — a deck's
 * soundtrack plus every standalone audio asset sent live — each independent
 * of `OutputView` because none of them are keyed off what's on screen, and
 * the element itself is never remounted by a slide change.
 *
 * `paused` is declarative (set from the control window's media panel), so an
 * operator's explicit pause survives an overlay round-trip and a projection
 * window reload the same way `LiveVideo`'s does. A standalone asset track
 * keeps playing through BLACK/LOGO; the deck's own soundtrack does not — the
 * control window (`projection-sync.ts`) folds the overlay into this track's
 * `paused` before it ever reaches here, so BLACK/LOGO pauses and holds it
 * exactly like `LiveVideo` does for a video.
 */
function AudioTrackElement({ registry, track }: AudioTrackElementProps) {
  const elementRef = useRef<HTMLAudioElement | null>(null);
  useMediaStatusReporter(elementRef, track.trackId, track.epoch);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    if (track.paused) element.pause();
    else element.play().catch(() => undefined);
  }, [track.paused]);

  // Declarative, exactly like `paused` above: re-applied on every render of
  // this element, so a remount (a new epoch, this whole window rebuilt onto
  // another screen) comes back at the level the operator set rather than at
  // the default. Assignment throws outside 0..1, which is why both stores
  // clamp before it ever gets here.
  useEffect(() => {
    const element = elementRef.current;
    if (element) element.volume = track.volume;
  }, [track.volume]);

  // Applied once, the moment metadata is available — after that the operator
  // scrubs through the panel's own `seek` command, not this.
  useEffect(() => {
    const element = elementRef.current;
    if (!element || track.startAtSeconds <= 0) return;
    const apply = () => {
      element.currentTime = track.startAtSeconds;
    };
    if (element.readyState >= 1) apply();
    else element.addEventListener("loadedmetadata", apply, { once: true });
    return () => element.removeEventListener("loadedmetadata", apply);
    // Intentionally only on mount/epoch change: startAtSeconds is a one-shot
    // starting point, not something to re-apply on every re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.epoch]);

  const trackId = track.trackId;
  const attach = useCallback(
    (element: HTMLAudioElement | null) => {
      elementRef.current = element;
      if (element) registry.set(trackId, element);
      else registry.delete(trackId);
    },
    [registry, trackId],
  );

  return (
    <audio
      autoPlay={!track.paused}
      loop={track.loop}
      onError={(event) =>
        reportMediaError({
          target: { kind: "audio", trackId: track.trackId },
          url: track.url,
          code: event.currentTarget.error?.code ?? null,
        })
      }
      ref={attach}
      src={track.url}
    />
  );
}

/** Which element a one-shot `MediaCommand` is for. A `switch`, so a target
 *  added to the contract cannot quietly fall through to the audio registry
 *  and look up `undefined`. */
function resolveCommandTarget(
  target: MediaCommand["target"],
  videoRef: RefObject<HTMLVideoElement | null>,
  slideVideoRef: RefObject<HTMLVideoElement | null>,
  audioRefs: Map<string, HTMLAudioElement>,
): HTMLMediaElement | null {
  switch (target.kind) {
    case "video":
      return videoRef.current;
    case "slideVideo":
      return slideVideoRef.current;
    case "audio":
      return audioRefs.get(target.trackId) ?? null;
  }
}

/**
 * The projection window is a pure function of its declarative inputs — it owns
 * no domain logic (no schedule, no Bible, no deck timings) and no state of its
 * own to lose: reopening it and replaying main's snapshot (projection-state.ts)
 * is what makes that safe.
 *
 * There are two inputs, not one. `display-content` says what pixels to show;
 * `audio-tracks` says which audio elements should exist — a deck's soundtrack
 * and any number of standalone audio assets sent live, none of them keyed off
 * the current output because they have to outlive every slide change (only a
 * standalone asset keeps playing through BLACK/LOGO itself — see
 * `AudioTrackElement`).
 *
 * The pixels themselves are `OutputView`, the very component the control
 * window's monitors use, so a confidence monitor can never disagree with the
 * projector.
 */
export function ProjectionApp() {
  const [output, setOutput] = useState<ProjectionOutput>({
    kind: "black",
    videoUnderlay: null,
    slideVideo: null,
    plates: [],
    transition: INSTANT_TRANSITION,
  });
  // Flips once, the first time real data (a push or the replayed snapshot)
  // replaces the synthetic placeholder above. Used only to change
  // `OutputView`'s `key` below — remounting it means its own "the very first
  // scene never fades" rule (see `output-view.tsx`) applies to the real
  // content, instead of animating a fade FROM the placeholder INTO whatever
  // was actually live when the window reopened.
  const [hasRealOutput, setHasRealOutput] = useState(false);
  const [tracks, setTracks] = useState<AudioTrackPush[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const slideVideoRef = useRef<HTMLVideoElement>(null);
  const audioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());

  // A fresh `projection:open` shows this window before its page has loaded,
  // so goLive() (which runs right after opening it, with no wait for
  // readiness) can push `display-content`/`audio-tracks` before these
  // listeners exist — a silent drop, not a queued delivery. Pulling main's
  // last known state once mounted closes that race without depending on any
  // load-event timing. `sawPush` stops a late-arriving snapshot from
  // clobbering a push that has since arrived.
  useEffect(() => {
    let sawPush = false;
    const offOutput = onIpc("display-content", (next) => {
      sawPush = true;
      setHasRealOutput(true);
      setOutput(next);
    });
    const offTracks = onIpc("audio-tracks", (next) => {
      sawPush = true;
      setTracks(next);
    });
    void api.projection.getSnapshot().then(({ output: snapshot, audioTracks }) => {
      if (sawPush) return;
      if (snapshot) {
        setHasRealOutput(true);
        setOutput(snapshot);
      }
      setTracks(audioTracks);
    });
    return () => {
      offOutput();
      offTracks();
    };
  }, []);

  useEffect(
    () =>
      onIpc("media-command", (command: MediaCommand) => {
        const el = resolveCommandTarget(command.target, videoRef, slideVideoRef, audioRefs.current);
        if (!el) return;
        switch (command.action) {
          case "seek":
            el.currentTime = command.timeSeconds;
            break;
          case "restart":
            el.currentTime = 0;
            void el.play();
            break;
        }
      }),
    [],
  );

  useMediaStatusReporter(IS_NDI_OUTPUT ? NO_ELEMENT : videoRef, null, output.videoUnderlay?.epoch ?? 0);
  useMediaStatusReporter(IS_NDI_OUTPUT ? NO_ELEMENT : slideVideoRef, null, output.slideVideo?.epoch ?? 0, "slideVideo");

  return (
    <div className="h-screen w-screen bg-black">
      <OutputView
        key={hasRealOutput ? "live" : "placeholder"}
        mode="live"
        {...(IS_NDI_OUTPUT ? {} : { onMediaError: reportMediaError })}
        output={output}
        slideVideoRef={slideVideoRef}
        videoRef={videoRef}
      />

      {/* Outside the output view on purpose: keyed by trackId+epoch so a track
          restarts from the beginning only when it is truly a new play (a
          fresh GO LIVE on the same asset bumps the epoch), never merely
          because BLACK/LOGO or a pause toggled. A track the media engine
          plays has no element at all: main plays it, sound included. */}
      {tracks.filter((track) => !IS_NDI_OUTPUT && !isEngineUrl(track.url)).map((track) => (
        <AudioTrackElement
          key={`${track.trackId}:${track.epoch}`}
          registry={audioRefs.current}
          track={track}
        />
      ))}
    </div>
  );
}
