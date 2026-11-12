import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { flushSync } from "react-dom";
import { Icon } from "@renderer/components/ui";
import { cn } from "@renderer/lib/utils";
import { frameCaptureSize } from "@renderer/lib/frame-capture";
import {
  isAnimatable,
  isRandomBars,
  randomBarDelays,
  transitionStyle,
  LEAVE_FALLBACK_MARGIN_MS,
  RANDOM_BAR_COUNT,
  type LayerRole,
  type LayerTransition,
} from "@renderer/lib/transition";
import { loadSlideModel } from "@renderer/lib/slide-models";
import { api } from "@renderer/lib/api";
import { isEngineUrl, liveEngineFrameKey, previewEngineFrameKey } from "@shared/urls";
import { ModelSlide } from "./slide-view/ModelSlide";
import { BibleScene } from "./bible-scene";
import { LogoScene } from "./logo-scene";
import { TimerScene } from "./timer-scene";
import { SongScene } from "./song-scene";
import { PlateLayer } from "./plate-layer";
import { StageImage } from "./stage-image";
import { FramePacer } from "@renderer/lib/frame-pacer";
import { followProjector } from "@renderer/lib/follow-projector";
import { releaseMedia } from "@renderer/lib/release-media";
import type {
  MediaStatus,
  ProjectionMediaError,
  ProjectionOutput,
  SlideEnter,
  SlideVideo,
  SongVideo,
} from "@shared/types/projection";

/** Above this drift (seconds) the LIVE monitor's own video is resynced to the
 *  projector's reported position instead of left to run — see
 *  `LiveVideo`'s drift-correction effect. */
const MONITOR_DRIFT_THRESHOLD_SECONDS = 0.35;

/** The longest a transition into a new video waits for that video's first
 *  frame before fading anyway — see the video hold in `OutputView`. A cap and
 *  not a promise: a file that takes longer than this to show anything is
 *  better faded in late than left holding the previous scene indefinitely.
 *  3 s, not 1 (owner, 2026-11-12): the room keeps the previous picture until
 *  the new one has a frame, never black in between — at 1 s, every engine
 *  start on the owner's Windows PC (~1.45 s) faded to black first. */
const VIDEO_READY_TIMEOUT_MS = 3000;

export type OutputViewMode = "live" | "preview" | "monitor";

/**
 * Whether a monitor's own copy of a video is in a state where a resync seek
 * helps rather than hurts. A copy that has no frame yet or is already seeking
 * is BEHIND by construction, and seeking it again restarts the very decode it
 * is waiting on — at ~4 status reports a second, a slow 4K start used to become
 * a seek storm that kept the monitor's decoder busy through the whole
 * transition. HAVE_CURRENT_DATA and not a higher bar: a paused copy can rest
 * there, and a seek from the media panel still has to reach it.
 */
function canResync(element: HTMLVideoElement): boolean {
  return element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !element.seeking;
}

/**
 * Serializes everything in an output EXCEPT `transition` — used to tell a
 * genuinely new scene from a push that only bumped `sceneEpoch` while
 * showing the exact same thing (an action re-asserting an overlay that was
 * already up, say). `beginScene()` is called from the action layer based on
 * "did the operator do something", not "did the picture actually change" —
 * that distinction is occasionally wrong at the source (an action forcing an
 * overlay it didn't need to), and re-checking it here, once, means a push
 * like that can never animate a scene fading into an identical copy of
 * itself, no matter which action produced it.
 */
/** How a slide of the same scene arrives — a deck's slide by its file's own
 *  transition, a song's by its theme's fade. */
function entryOf(output: ProjectionOutput): SlideEnter | null {
  return output.kind === "slide" || output.kind === "song" ? output.enter : null;
}

function sceneContentKey(output: ProjectionOutput): string {
  // `plates` is not the scene: putting a name on screen must not cross-fade
  // the stage under it (`PlateLayer` animates each plate on its own).
  return JSON.stringify(output, (key: string, value: unknown) =>
    key === "transition" || key === "plates" ? undefined : value,
  );
}

type LiveVideoProps = {
  /** BLACK/LOGO is over the video right now. */
  covered: boolean;
  /** The transition this video is entering on is held at its first keyframe
   *  until `onFirstFrame` — see the video hold in `OutputView`. */
  held: boolean;
  /** See `transitionStyle`: what enters paints the whole stage, so this video
   *  stays at full opacity under it while it leaves. */
  incomingCovers: boolean;
  /** This video's identity for its whole mount — see the drift-correction
   *  effect below, which must ignore a `liveVideoStatus` still describing the
   *  previous epoch's video during the instant it takes the projector to
   *  report the new one. */
  epoch: number;
  /** The projector's own video reporting its real position (`mediaStatus`,
   *  keyed "video") — provided for `mode === "monitor"`, where it drives the
   *  LIVE monitor's drift correction, and to the NDI window's "live" view,
   *  whose copy follows it (`follow-projector.ts`). Never to the projector. */
  liveVideoStatus?: MediaStatus | null | undefined;
  mode: OutputViewMode;
  /** This element failed to load or decode. `code` is
   *  `HTMLMediaElement.error.code`, which is the only reason the browser
   *  gives — not a message. */
  onError: (code: number | null) => void;
  /** Called once, with this element's `epoch`, when it first has a frame on
   *  screen. */
  onFirstFrame?: ((epoch: number) => void) | undefined;
  /** Called with this element as it is torn down, while it still holds
   *  decoded pixels, so the scene it leaves behind has something real to fade
   *  out. See `freezeFrame` in `OutputView`. */
  onFreezeFrame?: ((video: HTMLVideoElement) => void) | undefined;
  /** Declarative, operator-controlled pause from the media panel — distinct
   *  from `covered`, and deliberately takes priority: an explicit pause must
   *  survive a BLACK/LOGO round-trip instead of being silently overridden by
   *  it when the overlay comes back off. */
  paused: boolean;
  /** This element's part in whatever transition is currently in flight (or
   *  "steady" when there isn't one) — see `OutputView`'s `videoRole`. */
  role: LayerRole;
  /** Point the operator chose on the preview scrubber before GO LIVE. Applied
   *  once, right when this element mounts — never re-applied later, so a
   *  scrub from the media panel afterwards isn't fought on the next render. */
  startAtSeconds: number;
  transition: LayerTransition;
  url: string;
  videoRef?: Ref<HTMLVideoElement> | undefined;
  /** 0..1, and only ever honored when `audible` — the monitors are muted by
   *  construction, and a confidence monitor that could make noise is a way to
   *  put two copies of the same soundtrack in the room. */
  volume: number;
  /** The projector (`mode === "live"`) and PREVIEW's own monitor, at the
   *  volume the operator set there (owner, 2026-11-05). Nothing else ever
   *  sounds. */
  audible: boolean;
  /** `VideoUnderlay.loop`: the element starts over and never ends. */
  loop: boolean;
};

/**
 * The projector's video element. Kept mounted for as long as the *base* content
 * is this video — BLACK/LOGO only covers it — because tearing the element down
 * and rebuilding it on every overlay toggle churns Chromium's media pipeline
 * for nothing.
 *
 * Covering it pauses it and holds its position, rather than letting it run on
 * unseen: the operator expects BLACK to stop the video. A deck's own
 * soundtrack (`ProjectionApp`) now follows the same rule; only a standalone
 * audio asset sent live is meant to keep playing through an overlay.
 *
 * Hidden by `opacity` (via `transitionStyle`), not `display:none`: it's the
 * one element that survives across scenes, so covering/uncovering it is
 * itself a transition (fading a scene layer in over it, or fading it back in
 * over a scene layer) rather than an instant toggle. `role`/`transition` come
 * from `OutputView`, which is the only place that knows which side of an
 * in-flight transition (if any) this video is currently on.
 *
 * "monitor" (the LIVE confidence monitor) plays a second, independently
 * decoding instance of the same file, muted — it is a separate `<video>` in
 * the control window's own renderer process (Electron gives each
 * `BrowserWindow` its own process; a decoder can't be shared across that
 * boundary), so it free-runs on its own clock and can drift from the
 * projector's from decode-timing jitter alone. The drift-correction effect
 * below periodically snaps it back to the projector's real position
 * (`liveVideoStatus`, sourced from the same `mediaStatus` the transport bar
 * already reads) — play/pause need no such correction since both elements
 * derive `paused` from the same declarative store field in the same render.
 */
function LiveVideo({
  audible,
  covered,
  epoch,
  held,
  incomingCovers,
  liveVideoStatus,
  loop,
  mode,
  onError,
  onFirstFrame,
  onFreezeFrame,
  paused,
  role,
  startAtSeconds,
  transition,
  url,
  videoRef,
  volume,
}: LiveVideoProps) {
  const elementRef = useRef<HTMLVideoElement | null>(null);
  /** Never cleared, unlike `elementRef`: the unmount hook below has to reach
   *  the element AFTER React has detached its ref. */
  const lastElementRef = useRef<HTMLVideoElement | null>(null);
  const freezeRef = useRef(onFreezeFrame);
  freezeRef.current = onFreezeFrame;
  const firstFrameRef = useRef(onFirstFrame);
  firstFrameRef.current = onFirstFrame;
  const shouldPlay = !covered && !paused;

  // `requestVideoFrameCallback` and not `loadeddata`/`canplay`: those say the
  // pipeline HAS a frame, this says one was handed to the compositor — which
  // is the moment fading it in stops being a fade of an empty box. It also
  // fires for an element that is paused on its first frame. `loadeddata` is
  // only the fallback for an engine without it (jsdom).
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const fire = () => firstFrameRef.current?.(epoch);
    if (typeof element.requestVideoFrameCallback === "function") {
      const handle = element.requestVideoFrameCallback(fire);
      return () => element.cancelVideoFrameCallback(handle);
    }
    element.addEventListener("loadeddata", fire, { once: true });
    return () => element.removeEventListener("loadeddata", fire);
    // Keyed by epoch at the call site: one element, one first frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A LAYOUT effect, and empty deps: its cleanup has to run in the very commit
  // that removes this element — a passive effect's would run after the browser
  // has already painted the frame where the video is simply gone, which is the
  // black flash this exists to remove. Read through `freezeRef` so a changed
  // callback never re-arms it mid-playback. The player goes only after its
  // last frame is taken.
  useLayoutEffect(
    () => () => {
      const element = lastElementRef.current;
      if (!element) return;
      freezeRef.current?.(element);
      releaseMedia(element);
    },
    [],
  );

  function attach(element: HTMLVideoElement | null) {
    elementRef.current = element;
    if (element) lastElementRef.current = element;
    // Belt-and-suspenders alongside the `muted` attribute below: an explicit
    // `volume = 0` on every view that is not `audible` means a future mode
    // that forgets to check `muted` still can't make this element audible.
    if (element && !audible) element.volume = 0;
    if (typeof videoRef === "function") videoRef(element);
    else if (videoRef) (videoRef as { current: HTMLVideoElement | null }).current = element;
  }

  // `autoPlay` only applies to a freshly loaded element, so every transition —
  // BLACK/LOGO, and an operator pause/resume from the media panel — has to be
  // driven imperatively.
  //
  // Except lifting BLACK/LOGO off a video that had already ended: «hold»
  // (`projection.videoEnd`) keeps it on air on its last frame, and so does
  // «next» while the next row is still being read. `play()` on an ended
  // element restarts it from 0 by spec — the whole clip again, sound included,
  // just because the operator uncovered it. An explicit resume from the media
  // panel still replays it.
  const wasCovered = useRef(covered);
  useEffect(() => {
    const element = elementRef.current;
    const uncovered = wasCovered.current && !covered;
    wasCovered.current = covered;
    if (!element) return;
    if (shouldPlay && !(uncovered && element.ended)) element.play().catch(() => undefined);
    else element.pause();
  }, [shouldPlay, covered]);

  // Declarative, like `paused`: re-applied whenever the operator moves the
  // level AND on every remount, so a video that survives a rebuilt projection
  // window comes back at the level it was playing at. Never in a muted view
  // — `attach` pins those to 0 and the element also carries `muted`.
  useEffect(() => {
    const element = elementRef.current;
    if (element && audible) element.volume = volume;
  }, [audible, volume]);

  // Resyncs the LIVE monitor's independently decoding video to the
  // projector's real position whenever a fresh `mediaStatus` report arrives
  // (~4x/second) and drifts past the threshold — this is also what makes a
  // manual seek/restart from the media panel reach this element: it isn't
  // routed here directly, it just shows up as a jump in `liveVideoStatus` on
  // the next report and gets corrected like any other drift. Guarded by
  // `epoch` so a status report still describing the previous video (the
  // instant before the projector reports the new one) is never applied here.
  useEffect(() => {
    if (mode !== "monitor" || !liveVideoStatus || liveVideoStatus.epoch !== epoch) return;
    const element = elementRef.current;
    if (!element || !canResync(element)) return;
    const drift = Math.abs(element.currentTime - liveVideoStatus.currentTimeSeconds);
    if (drift > MONITOR_DRIFT_THRESHOLD_SECONDS) {
      element.currentTime = liveVideoStatus.currentTimeSeconds;
    }
  }, [mode, liveVideoStatus, epoch]);

  // The NDI window's copy keeps step with the projector's, whose sound NDI sends (`follow-projector.ts`).
  // Only it gets a status in "live" mode; the projector's own view never does.
  useEffect(() => {
    if (mode !== "live" || !liveVideoStatus || liveVideoStatus.epoch !== epoch) return;
    const element = elementRef.current;
    if (!element || !canResync(element) || liveVideoStatus.paused || liveVideoStatus.ended) return;
    followProjector(element, liveVideoStatus.currentTimeSeconds, liveVideoStatus.durationSeconds, element.loop);
  }, [mode, liveVideoStatus, epoch]);

  // The component is keyed by epoch at the call site, so this instance only
  // ever has one `startAtSeconds` for its whole lifetime — applying it once,
  // on mount, is correct without watching for later changes.
  useEffect(() => {
    const element = elementRef.current;
    if (!element || startAtSeconds <= 0) return;
    const apply = () => {
      element.currentTime = startAtSeconds;
    };
    if (element.readyState >= 1) apply();
    else element.addEventListener("loadedmetadata", apply, { once: true });
    return () => element.removeEventListener("loadedmetadata", apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <video
      autoPlay={shouldPlay}
      loop={loop}
      // Black, not transparent, around a picture that does not fill the stage:
      // fading in over a scene that holds at full opacity (`incomingCovers`),
      // a 4:3 video's bars would show that scene and then snap to black.
      className="absolute inset-0 size-full bg-black object-contain"
      // Whitelist, not a check against "monitor": any future view is muted
      // by default; only the real projector and PREVIEW's own monitor (at the
      // operator's volume, 0 to start) ever get sound.
      muted={!audible || volume === 0}
      onError={(event) => onError(event.currentTarget.error?.code ?? null)}
      // "auto" wherever this element exists to be played right now: "metadata"
      // stops buffering after the first seek, so the decoder started cold in
      // the middle of the fade. The preview keeps "metadata" — it moves with
      // every click through the library and only plays on the operator's own
      // button.
      preload={mode === "preview" ? "metadata" : "auto"}
      ref={attach}
      src={url}
      style={transitionStyle(role, transition, covered ? 0 : 1, held, incomingCovers)}
    />
  );
}

type EngineVideoProps = {
  className: string;
  /** The projector and the NDI window: frames go up on the page's clock (`FramePacer`). A monitor
   *  draws them as they land — its cadence nobody watches, and it costs the control window less. */
  paced: boolean;
  /** What main sends this video's frames under (`liveEngineFrameKey`, `previewEngineFrameKey`). */
  frameKey: string;
  onFirstFrame?: (() => void) | undefined;
  onFreezeFrame?: ((canvas: HTMLCanvasElement) => void) | undefined;
  style?: CSSProperties | undefined;
};

/**
 * The `<video>` of `LiveVideo` or `SlideVideoLayer` for a video the media
 * engine plays (`isEngineUrl`): a canvas its frames are drawn into, the very
 * same frame in the projector and in every monitor
 * (`main/media/engine-sessions.ts`). Main plays, pauses, seeks and
 * sounds it from the same output this view gets, so there is nothing here to
 * drive, and no second copy to keep in step in a monitor.
 *
 * Each frame is copied as it lands and handed back at once (`onVideoFrame`):
 * the engine reuses its texture. Where the room looks (`paced`), it goes up at
 * an animation frame (`FramePacer`). The canvas starts at no size, so one that
 * never drew has no pixels for `captureFrame` to freeze on the way out.
 */
function EngineVideo({ className, frameKey, onFirstFrame, onFreezeFrame, paced, style }: EngineVideoProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const firstFrameRef = useRef(onFirstFrame);
  firstFrameRef.current = onFirstFrame;
  const freezeRef = useRef(onFreezeFrame);
  freezeRef.current = onFreezeFrame;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    let first = true;
    const present = (source: CanvasImageSource, width: number, height: number) => {
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.drawImage(source, 0, 0);
      if (first) {
        first = false;
        firstFrameRef.current?.();
      }
    };
    let raf = 0;
    let off: () => void;
    if (!paced) {
      off = window.worship.onVideoFrame(frameKey, (frame) => present(frame, frame.displayWidth, frame.displayHeight));
    } else {
      // Each frame copied as it lands — the engine's texture goes back at once, its ring has six — and
      // put up at an animation frame. Three copies: two waiting at most, the oldest dropped past that.
      const free = [0, 1, 2].map(() => new OffscreenCanvas(1, 1));
      const queue: OffscreenCanvas[] = [];
      const pacer = new FramePacer();
      off = window.worship.onVideoFrame(frameKey, (frame) => {
        if (!pacer.arrived(performance.now())) return;
        const stage = free.pop() ?? queue.shift();
        const stageContext = stage?.getContext("2d");
        if (!stage || !stageContext) return;
        if (stage.width !== frame.displayWidth || stage.height !== frame.displayHeight) {
          stage.width = frame.displayWidth;
          stage.height = frame.displayHeight;
        }
        stageContext.drawImage(frame, 0, 0);
        queue.push(stage);
      });
      const loop = (now: number) => {
        if (pacer.tick(now, queue.length)) {
          const stage = queue.shift()!;
          present(stage, stage.width, stage.height);
          free.push(stage);
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }
    // A paused engine sends nothing: a projector rebuilt onto another screen
    // would stay black until play.
    void api.projection.wantVideoFrame(frameKey);
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
    // Keyed by `frameKey` at the call site: one canvas, one stream of frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `LiveVideo`'s frozen frame, from the canvas: a LAYOUT effect for the same
  // reason, and the node captured on mount because React detaches the ref
  // before this cleanup runs.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    return () => {
      if (canvas) freezeRef.current?.(canvas);
    };
  }, []);

  return (
    <canvas className={className} data-frame-key={frameKey} height={0} ref={canvasRef} style={style} width={0} />
  );
}

type SlideVideoLayerProps = {
  /** BLACK/LOGO is over the slide right now, or something else entirely went
   *  live. Hides and pauses; never unmounts. */
  covered: boolean;
  held: boolean;
  incomingCovers: boolean;
  mode: OutputViewMode;
  onError: (code: number | null) => void;
  role: LayerRole;
  slideVideo: NonNullable<SlideVideo>;
  /** The projector's own report for this element — only passed in
   *  `mode === "monitor"`, exactly like `LiveVideo`'s. */
  status?: MediaStatus | null | undefined;
  transition: LayerTransition;
  videoRef?: Ref<HTMLVideoElement> | undefined;
};

/**
 * A video embedded inside the live slide, laid over the slide image in the
 * rect the source file declared for it.
 *
 * ## Why it reconstructs the image's box instead of filling the stage
 *
 * The slide is painted by an `<img class="size-full object-contain">`, so on a
 * stage whose shape differs from the deck's it is letterboxed: the pixels the
 * rect is relative to occupy only part of this element. Positioning against
 * the stage would put the video off the slide by exactly the size of the black
 * bars. So the box `object-contain` produced is rebuilt here — `min(100cqw,
 * ratio * 100cqh)` is literally the contain formula — and the rect is applied
 * inside it in percentages.
 *
 * That needs BOTH container-query axes, and `cqh` only exists under
 * `container-type: size`; the view's own root is an `inline-size` container
 * (which is all the `cqw` type sizes everywhere else need). Hence the private
 * sized container here, which shadows nothing: no descendant of this element
 * reads a container unit from the root.
 *
 * ## What it deliberately does NOT do
 *
 * It never unmounts on an overlay. Covering is opacity + pause, the same
 * bargain `LiveVideo` makes and for the same reason — a `<video>` torn down
 * and rebuilt on every BLACK is the documented road to
 * `PIPELINE_ERROR_DECODE`. And it captures no frozen frame on the way out:
 * the still slide underneath already shows this video's poster frame, drawn
 * there from its model, so there is nothing to preserve.
 */
function SlideVideoLayer({
  covered,
  held,
  incomingCovers,
  mode,
  onError,
  role,
  slideVideo,
  status,
  transition,
  videoRef,
}: SlideVideoLayerProps) {
  const elementRef = useRef<HTMLVideoElement | null>(null);
  const shouldPlay = !covered && !slideVideo.paused;
  const { rect } = slideVideo;
  const rectStyle = {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  };

  function attach(element: HTMLVideoElement | null) {
    elementRef.current = element;
    // Same belt-and-suspenders as `LiveVideo`: only the projector is audible,
    // whatever a future mode forgets to check.
    if (element && mode !== "live") element.volume = 0;
    if (typeof videoRef === "function") videoRef(element);
    else if (videoRef) (videoRef as { current: HTMLVideoElement | null }).current = element;
  }

  // `autoPlay` only applies to a freshly loaded element, so every later
  // transition — an overlay, an operator pause — is driven imperatively.
  //
  // Except one: lifting BLACK/LOGO off a clip that had already ended — it
  // stays on its slide, and `play()` on an ended element restarts it from 0 by
  // spec, the whole clip again, sound included, just because the operator
  // uncovered the slide. `LiveVideo` has the same guard for a video held on
  // its last frame. An explicit resume from the media panel still replays it.
  const wasCovered = useRef(covered);
  useEffect(() => {
    const element = elementRef.current;
    const uncovered = wasCovered.current && !covered;
    wasCovered.current = covered;
    if (!element) return;
    if (shouldPlay && !(uncovered && element.ended)) element.play().catch(() => undefined);
    else element.pause();
  }, [shouldPlay, covered]);

  useEffect(() => {
    const element = elementRef.current;
    if (element && mode === "live") element.volume = slideVideo.volume;
  }, [mode, slideVideo.volume]);

  // Resyncs a confidence monitor's own independently decoding copy to the
  // projector's real position — and, as a side effect, is how a seek from the
  // media panel reaches this element at all. See `LiveVideo`'s twin.
  const epoch = slideVideo.epoch;
  useEffect(() => {
    if (mode !== "monitor" || !status || status.epoch !== epoch) return;
    const element = elementRef.current;
    if (!element || !canResync(element)) return;
    if (Math.abs(element.currentTime - status.currentTimeSeconds) > MONITOR_DRIFT_THRESHOLD_SECONDS) {
      element.currentTime = status.currentTimeSeconds;
    }
  }, [mode, status, epoch]);

  // The NDI window's copy follows the projector's, like `LiveVideo`'s.
  useEffect(() => {
    if (mode !== "live" || !status || status.epoch !== epoch) return;
    const element = elementRef.current;
    if (!element || !canResync(element) || status.paused || status.ended) return;
    followProjector(element, status.currentTimeSeconds, status.durationSeconds, element.loop);
  }, [mode, status, epoch]);

  // Captured on mount: by the time an unmount's cleanup runs, React has
  // already detached the ref.
  useEffect(() => {
    const element = elementRef.current;
    return () => {
      if (element) releaseMedia(element);
    };
  }, []);

  // Keyed by epoch at the call site, so this instance has exactly one
  // `startAtSeconds` for its whole life — applied once, on mount.
  useEffect(() => {
    const element = elementRef.current;
    if (!element || slideVideo.startAtSeconds <= 0) return;
    const apply = () => {
      element.currentTime = slideVideo.startAtSeconds;
    };
    if (element.readyState >= 1) apply();
    else element.addEventListener("loadedmetadata", apply, { once: true });
    return () => element.removeEventListener("loadedmetadata", apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      style={{ ...transitionStyle(role, transition, covered ? 0 : 1, held, incomingCovers), containerType: "size" }}
    >
      <div
        className="relative"
        style={{
          aspectRatio: `${slideVideo.aspectRatio}`,
          width: `min(100cqw, ${slideVideo.aspectRatio} * 100cqh)`,
        }}
      >
        {/* Main plays, pauses, loops and sounds an engine clip: every hook
            above finds no element and does nothing. */}
        {isEngineUrl(slideVideo.url) ? (
          <EngineVideo
            className="absolute object-contain"
            frameKey={liveEngineFrameKey("slideVideo", slideVideo.epoch)}
            paced={mode === "live"}
            style={rectStyle}
          />
        ) : (
          <video
            autoPlay={shouldPlay}
            className="absolute object-contain"
            loop={slideVideo.loop}
            muted={mode !== "live"}
            onError={(event) => onError(event.currentTarget.error?.code ?? null)}
            preload="metadata"
            ref={attach}
            src={slideVideo.url}
            style={rectStyle}
          />
        )}
      </div>
    </div>
  );
}

/**
 * A song theme's video background (`SongVideo`), UNDER every scene layer —
 * whose song scene is then transparent (`videoBehind`) — and outside all of
 * them, so a slide's fade, which is two layers, never builds a second one.
 * Its still sits under the picture until the first frame. BLACK and LOGO only
 * pause it: their scene is opaque and on top, so nothing here has to hide.
 * Silent always; the engine's frames, when the media engine plays it.
 */
function SongVideoLayer({
  covered,
  onError,
  paced,
  songVideo,
}: {
  covered: boolean;
  onError: (code: number | null) => void;
  paced: boolean;
  songVideo: SongVideo;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    if (covered) element.pause();
    else element.play().catch(() => undefined);
  }, [covered]);
  // Captured on mount (the ref is detached before an unmount's cleanup runs).
  // An engine background has no element, and a theme changed to another file
  // reuses this one with a new `src`, which drops the old player by itself.
  useEffect(() => {
    const element = videoRef.current;
    return () => {
      if (element) releaseMedia(element);
    };
  }, []);
  const fit = { objectFit: songVideo.fit } as const;
  return (
    <div className="absolute inset-0" data-song-video="">
      <StageImage className="absolute inset-0 size-full" src={songVideo.posterUrl} style={fit} />
      {isEngineUrl(songVideo.url) ? (
        <EngineVideo
          className="absolute inset-0 size-full"
          frameKey={liveEngineFrameKey("songVideo", songVideo.epoch)}
          paced={paced}
          style={fit}
        />
      ) : (
        <video
          autoPlay={!covered}
          className="absolute inset-0 size-full"
          loop
          muted
          onError={(event) => onError(event.currentTarget.error?.code ?? null)}
          playsInline
          ref={videoRef}
          src={songVideo.url}
          style={fit}
        />
      )}
    </div>
  );
}

/**
 * The last frame of a video that has already been torn down, mounted as the
 * canvas node it was drawn into.
 *
 * An existing DOM node rather than JSX because the pixels cannot be
 * re-created: the element they came from no longer exists. `useLayoutEffect`,
 * so the node is in place before the browser paints the first frame of the
 * fade — a passive effect would show one black frame first, which is exactly
 * what this is here to remove.
 */
function FrozenFrame({ canvas }: { canvas: HTMLCanvasElement }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren(canvas);
    return () => host.replaceChildren();
  }, [canvas]);
  return <div className="size-full" ref={hostRef} />;
}

type OutputSceneProps = {
  /** The outgoing half of a transition away from a video: its last frame,
   *  captured as the element was unmounted. Only ever set on a layer whose
   *  own `output.kind` is "video". */
  frozenFrame?: HTMLCanvasElement | null | undefined;
  mode: OutputViewMode;
  /** The still image of this scene could not be loaded. Only ever wired for
   *  the *top* layer (see `OutputView`): an outgoing layer failing on its way
   *  out describes content nobody is looking at any more. */
  onImageError?: ((url: string) => void) | undefined;
  output: ProjectionOutput;
  /** The song's video background plays under this layer (`SongVideoLayer`):
   *  the song scene paints no background of its own. */
  videoBehind?: boolean;
  /** A still standing in for a video that is deliberately not mounted — see
   *  `OutputView`'s `videoStill`. */
  posterUrl: string | null;
};

/**
 * The non-video content of one `ProjectionOutput` — everything a scene layer
 * paints. Split out from `OutputView` so a layer's markup is identical
 * whether it's the sole steady scene or one half of a transition; `black`
 * and `video` themselves render nothing here (black is the layer's own
 * background — see `SceneLayer` — and video is the persistent element
 * `OutputView` renders outside every layer).
 */
function OutputScene({ frozenFrame, mode, onImageError, output, posterUrl, videoBehind = false }: OutputSceneProps) {
  return (
    <>
      {output.kind === "video" && frozenFrame ? <FrozenFrame canvas={frozenFrame} /> : null}

      {/* Not wired to `onImageError`: a video without a thumbnail is not a
          broken video, and the notice on this stage already says why it is
          still. */}
      {output.kind === "video" && !frozenFrame && posterUrl ? (
        <StageImage className="size-full object-contain" src={posterUrl} />
      ) : null}

      {output.kind === "logo" && !output.url ? <LogoScene onImageError={onImageError} output={output} /> : null}

      {(output.kind === "logo" && output.url) || output.kind === "image" ? (
        <StageImage
          className="size-full object-contain"
          onError={() => {
            if (output.url) onImageError?.(output.url);
          }}
          src={output.url ?? ""}
        />
      ) : null}

      {/* No `key` here either — swapping `src` within the same layer (same
          `seq`, see `OutputView`) on slide navigation is what avoids the
          white flash between slides. */}
      {output.kind === "slide" && output.modelUrl ? (
        <ModelSlide onError={() => onImageError?.(output.modelUrl ?? output.url)} text={output.text} url={output.modelUrl} />
      ) : null}
      {output.kind === "slide" && !output.modelUrl ? (
        <StageImage
          className="size-full object-contain"
          decoding={mode === "live" ? "sync" : "async"}
          holdLastGood
          onError={() => onImageError?.(output.url)}
          src={output.url}
        />
      ) : null}

      {/* Its own component, and the only part of a scene that re-renders on
          its own: the countdown ticks inside it, from an absolute mark, so
          nothing above here moves once per second. */}
      {output.kind === "timer" ? <TimerScene onImageError={onImageError} output={output} /> : null}

      {/* Its own component for the same reason the time scene is: a verse is a
          paragraph whose size is MEASURED against the stage rather than
          declared, so it owns a layout effect. Everything it draws comes out
          of the `BibleStyle` inside the output — nothing about a verse is
          hardcoded here any more. */}
      {output.kind === "bible" ? <BibleScene onImageError={onImageError} output={output} /> : null}

      {/* Measures nothing: the song's one size travels in the output. */}
      {output.kind === "song" ? (
        <SongScene content={output} onImageError={onImageError} videoBehind={videoBehind} />
      ) : null}
    </>
  );
}

type SceneLayerProps = {
  frozenFrame?: HTMLCanvasElement | null | undefined;
  held: boolean;
  incomingCovers: boolean;
  mode: OutputViewMode;
  onImageError?: ((url: string) => void) | undefined;
  onLeaveComplete?: (() => void) | undefined;
  posterUrl: string | null;
  output: ProjectionOutput;
  role: LayerRole;
  transition: LayerTransition;
  videoBehind: boolean;
};

/** One stacked scene — `OutputView` mounts up to two at once (the outgoing
 *  and incoming side of a transition) or just one at rest. `opaque` is what
 *  makes "black" and a logo-less LOGO actually look black/blank: those kinds
 *  paint nothing in `OutputScene`, so the layer's own background does it —
 *  except for `video`, which paints nothing here on purpose (see
 *  `OutputScene`) and must stay transparent so the persistent `<video>`
 *  element shows through instead of being hidden behind an opaque box. */
function SceneLayer({
  frozenFrame,
  held,
  incomingCovers,
  mode,
  onImageError,
  onLeaveComplete,
  output,
  posterUrl,
  role,
  transition,
  videoBehind,
}: SceneLayerProps) {
  // A video layer normally paints nothing and must stay transparent so the
  // persistent <video> shows through. One holding a frozen frame is the
  // opposite case: it IS the picture now, and it needs black behind it for the
  // letterboxing `object-contain` leaves.
  // A poster (`videoStill`) is the same case: the layer is the picture.
  // A song over its video background is the same: the video is the picture.
  const opaque = (output.kind !== "video" || frozenFrame != null || posterUrl !== null) && !videoBehind;
  const scene = (errors: typeof onImageError) => (
    <OutputScene
      frozenFrame={frozenFrame}
      mode={mode}
      onImageError={errors}
      output={output}
      posterUrl={posterUrl}
      videoBehind={videoBehind}
    />
  );
  // A slide entering by random bars is drawn once per bar, each bar clipped to
  // itself; the layer stays transparent so the slide leaving shows through
  // the bars still to come.
  const bars = role === "entering" && output.kind === "slide" && output.enter && isRandomBars(transition);
  return (
    <div
      className={cn("absolute inset-0 flex items-center justify-center", opaque && !bars && "bg-black")}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && role === "leaving") onLeaveComplete?.();
      }}
      style={transitionStyle(role, transition, 1, held, incomingCovers)}
    >
      {bars && output.kind === "slide" && output.enter ? (
        <RandomBars
          durationMs={transition.durationMs}
          seed={output.enter.seq}
          vertical={transition.style === "random-bars-vertical"}
        >
          {(first) => scene(first ? onImageError : undefined)}
        </RandomBars>
      ) : (
        scene(onImageError)
      )}
    </div>
  );
}

/**
 * The slide entering by random bars: `RANDOM_BAR_COUNT` strips across the
 * stage, each showing its own slice of the slide and appearing on its own
 * turn (`randomBarDelays`).
 *
 * Each strip is a box the size of its bar with `overflow: hidden`, holding the
 * whole stage offset into place — not a full-stage copy clipped by
 * `clip-path`: sixty full-stage layers at 4K are two gigabytes of GPU memory,
 * sixty strips are one stage. The bars span the stage, letterbox included;
 * the letterbox is black on both sides of the transition, so nothing shows.
 */
function RandomBars({
  children,
  durationMs,
  seed,
  vertical,
}: {
  children: (first: boolean) => ReactNode;
  durationMs: number;
  seed: number;
  vertical: boolean;
}) {
  const delays = randomBarDelays(seed, durationMs);
  const share = 100 / RANDOM_BAR_COUNT;
  return delays.map((delay, bar) => (
    <div
      className="absolute overflow-hidden"
      key={bar}
      style={{
        ...(vertical
          ? { top: 0, bottom: 0, left: `${bar * share}%`, width: `${share}%` }
          : { left: 0, right: 0, top: `${bar * share}%`, height: `${share}%` }),
        // A 1 ms fade at its own moment: hidden until then, shown after.
        animation: `wa-scene-fade-in 1ms linear ${delay}ms both`,
      }}
    >
      <div
        className="absolute flex items-center justify-center bg-black"
        style={
          vertical
            ? { top: 0, bottom: 0, width: `${RANDOM_BAR_COUNT * 100}%`, left: `${-bar * 100}%` }
            : { left: 0, right: 0, height: `${RANDOM_BAR_COUNT * 100}%`, top: `${-bar * 100}%` }
        }
      >
        {children(bar === 0)}
      </div>
    </div>
  ));
}

type OutputNoticeTone = "danger" | "notice";
type OutputNoticeProps = {
  /** Second line, smaller and lighter: what to DO about the first one. Its own
   *  string rather than a line break inside `label`, so the wording and the
   *  layout stay in the places that own them — the dictionary and this
   *  component. */
  detail?: string | undefined;
  label: string;
  tone: OutputNoticeTone;
};

/** `danger` is "what you are looking at is broken"; `notice` is "the stage is
 *  this way on purpose, and here is what to do about it". Two looks rather than
 *  one because a black projector the operator CHOSE and a file that failed to
 *  decode must not look the same from across a dark booth — and the notice is
 *  neutral, not amber (2026-11-04 redesign, P5): it is information, and an
 *  alarm for something optional trains the operator to ignore alarms. */
const noticeToneClass: Record<OutputNoticeTone, string> = {
  danger: "bg-danger/90 text-danger-foreground",
  notice: "bg-card/90 text-foreground",
};

/**
 * The band the LIVE and PREVIEW monitors paint over the stage — when what they
 * are showing failed to load, or when it is deliberately empty and needs the
 * operator's attention. Never painted on the projector itself
 * (`mode === "live"` in `OutputView`) — the congregation must not see the
 * warning, only the operator.
 *
 * Sized in `cqw` like everything else here so it reads the same on a 240px
 * monitor as it would at 4K, and anchored to the bottom so it never covers
 * the middle of the frame — the operator still sees whatever *did* manage to
 * render underneath it.
 */
function OutputNotice({ detail, label, tone }: OutputNoticeProps) {
  return (
    <div
      className={cn(
        // The icon is pinned to the far left of the band while the text stays
        // centred on the STAGE, not on what's left of the band beside the
        // icon. That is why it is positioned rather than a flex sibling, and
        // why the horizontal padding is symmetric and wide enough to clear
        // it: a long notice on a narrow monitor then shrinks away from the
        // icon instead of running under it.
        "absolute inset-x-0 bottom-0 z-[var(--z-raised)] flex items-center justify-center px-[7cqw] py-[1.6cqw] text-center text-[3cqw] leading-tight font-semibold",
        noticeToneClass[tone],
      )}
      role="status"
    >
      <Icon className="absolute top-1/2 left-[2.5cqw] size-[3.5cqw] -translate-y-1/2" name="alert" />
      <span className="flex min-w-0 flex-col gap-[0.4cqw]">
        <span>{label}</span>
        {detail ? <span className="text-[2.2cqw] font-normal opacity-90">{detail}</span> : null}
      </span>
    </div>
  );
}

type OutputViewProps = {
  /** Only PREVIEW's own monitor: its full-screen video sounds at its
   *  `videoUnderlay.volume` (owner, 2026-11-05: «todo como en vivo pero con el
   *  volumen a 0»). Every other non-live view stays muted — an editor's canvas
   *  drawn over the live stage must never play the room's video twice. */
  audible?: boolean;
  className?: string;
  /** Translated one-line notice to paint over the stage when what's showing
   *  failed to load. Passed in rather than built here so this component stays
   *  free of i18n — it also renders inside the projection window, which has
   *  no provider. Omit it (the projector does) and no notice is ever shown. */
  errorLabel?: string;
  /** The projector's own video `mediaStatus` — passed for `mode === "monitor"`
   *  (`LiveVideo`'s drift correction) and by the NDI window, whose copy follows
   *  it; never by the projector itself. */
  liveVideoStatus?: MediaStatus | null;
  /**
   * "live" is the projection window itself: video autoplays and is wired to
   * the media refs, with sound. "preview" is the operator's preview monitor
   * (and an editor's canvas): same pixels, muted unless `audible` — PREVIEW's
   * own monitor, at PREVIEW's volume —, and a video plays there only under the
   * operator's own play button (see `preview-media-bar.tsx`), never
   * automatically. "monitor" is the LIVE confidence monitor — same pixels,
   * muted, and autoplaying in lockstep with the projector (see
   * `liveVideoStatus`).
   */
  mode: OutputViewMode;
  /** Translated one-line notice for a stage that is empty ON PURPOSE and
   *  shouldn't be — today, LOGO with no logo chosen. Passed in the same way
   *  and for the same reason as `errorLabel`, and outranked by it: a file that
   *  failed to load is the more urgent fact. The caller decides when it
   *  applies; this component only paints it. */
  /** Second line under `noticeLabel` — the way out of the state it names.
   *  Ignored without one, and never shown for an error: a failure gets the
   *  one line it has. */
  noticeDetail?: string | undefined;
  noticeLabel?: string | undefined;
  /** One of this view's own elements failed. The projection window forwards
   *  it to main (`projection:reportMediaError`); the monitors don't need to —
   *  a local failure already shows up in this view's own notice. */
  onMediaError?: (error: ProjectionMediaError) => void;
  output: ProjectionOutput;
  /** Urls the *projector* reported as failed. What makes the LIVE monitor's
   *  notice describe the projector rather than its own second, independently
   *  decoding copy of the same file — the monitor may well be able to play
   *  something the projector can't, and vice versa. */
  reportedErrorUrls?: readonly string[];
  /** The projector's report for the live slide's own video — the `SlideVideo`
   *  counterpart of `liveVideoStatus`, and passed under the same rule. */
  slideVideoStatus?: MediaStatus | null;
  /** The live slide's video element, so the projection window can route a
   *  `MediaCommand` to it. Separate from `videoRef` because the two are
   *  different elements with different lifetimes, even though only one of them
   *  is ever mounted at a time. */
  slideVideoRef?: Ref<HTMLVideoElement>;
  videoRef?: Ref<HTMLVideoElement>;
  /**
   * The LIVE monitor with its moving video turned off (Settings → System →
   * Performance): no `<video>` is mounted at all — neither the full-screen one
   * nor a slide's — so the control window decodes nothing. A full-screen video
   * is shown as `posterUrl` instead; a slide's video needs nothing, its slide
   * image already carries its cover frame. `videoUrl` names the video the
   * poster belongs to, so a layer still showing a different video (the
   * outgoing half of a video → video change) never borrows it.
   *
   * Honored only in `mode === "monitor"`: the projector never reads it.
   */
  videoStill?: { posterUrl: string | null; videoUrl: string | null } | undefined;
};

/** One stacked scene, keyed by a local sequence number — NOT by
 *  `output.transition.epoch` directly, so a rapid run of scene changes never
 *  produces key gaps or reuses a stale one. */
type Layer = {
  seq: number;
  output: ProjectionOutput;
  /** Set only on the outgoing half of a transition away from a video — see
   *  `freezeFrame`. */
  frozenFrame?: HTMLCanvasElement | null;
};

/**
 * Draws a video's current frame into a fresh canvas.
 *
 * A canvas node rather than an encoded image: `toDataURL` on a 1080p frame is
 * tens of milliseconds of synchronous work at the exact instant a transition
 * starts, while `drawImage` is a blit. A new canvas each time rather than one
 * reused buffer, because a transition that arrives mid-flight would otherwise
 * repaint the frame the previous one is still fading out.
 *
 * `null` when there is nothing to copy — a video that never reached
 * `HAVE_CURRENT_DATA` (or an engine canvas that never drew) has no pixels, and
 * a blank canvas would fade out as a black rectangle, which is worse than the
 * cut it replaces.
 */
function captureFrame(video: HTMLVideoElement | HTMLCanvasElement): HTMLCanvasElement | null {
  const [width, height] =
    video instanceof HTMLVideoElement
      ? video.readyState < 2
        ? [0, 0]
        : [video.videoWidth, video.videoHeight]
      : [video.width, video.height];
  if (width === 0 || height === 0) return null;
  // Sized to the stage it is shown on, not to the source: a 4K frame copied
  // for a 240px monitor is 33 MB drawn synchronously in the very commit that
  // starts the transition. The still takes the video's place in this same
  // stage, so the video's parent is the box that matters.
  const box = video.parentElement;
  const size = frameCaptureSize(
    width,
    height,
    (box?.clientWidth ?? 0) * window.devicePixelRatio,
    (box?.clientHeight ?? 0) * window.devicePixelRatio,
  );
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
  } catch {
    // Drawing a decoded frame cannot normally fail, but a failure here must
    // never take a live projector down: no frame just means the old cut back.
    return null;
  }
  // Inline, not Tailwind: this node is created outside React's tree, so it
  // must not depend on a class string being picked up by the CSS scanner.
  // Matches the <video> it replaces (`size-full object-contain`).
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.objectFit = "contain";
  canvas.style.display = "block";
  return canvas;
}

/** Drops the outgoing half of a finished transition, leaving one "steady"
 *  layer (`role` is derived from `layers.length`, so this is also what takes
 *  the survivor off its keyframe and back to a plain opacity). Module-level so
 *  both callers — `animationend` and its fallback timer — share one definition
 *  without either becoming an effect dependency. */
function withoutOutgoing(layers: Layer[], seq: number): Layer[] {
  return layers.length > 1 && layers[0]?.seq === seq ? layers.slice(1) : layers;
}

/**
 * Renders a `ProjectionOutput`. The projection window and both confidence
 * monitors (live + preview) all go through this one component, so what the
 * operator sees in a monitor cannot drift from what the congregation sees.
 *
 * Type sizes are in `cqw`, not `vw`: the root is a container, so the exact same
 * markup scales from a 240px monitor to a 4K projector with no per-size
 * variants. Video/image/slide media scale the same way, but by `object-contain`
 * on a `size-full` element rather than by type size: a source smaller than the
 * output (a 360p video, say) is stretched up to fill it — never left at native
 * size — while keeping its aspect ratio, so a monitor never shows content
 * smaller, relative to its box, than the projector shows it.
 *
 * ## Scene transitions
 *
 * `output.transition.epoch` only advances when the control window begins a
 * genuinely new scene (`beginScene()` in `projection.store.ts`) — never for
 * navigating within what's already live (a slide, a verse). That's the
 * signal this component watches: an unchanged epoch always updates the
 * current layer in place (an un-keyed `src`/content swap, same as before
 * transitions existed at all — critical for the slide anti-flash comment
 * above), while a changed epoch retains the previous scene as an "outgoing"
 * layer under a fresh "incoming" one and fades between them per
 * `output.transition.style`/`durationMs`. At most two layers ever exist —
 * a transition that arrives mid-flight drops the older one immediately
 * rather than growing a queue.
 *
 * The persistent `<video>` (kept mounted independent of any layer — see
 * `LiveVideo`) participates in the same fade: covering/uncovering it with
 * BLACK/LOGO is a real transition between "the video" and "an opaque scene",
 * so it needs to know which side of the current transition (if any) it's on
 * — see `videoRole` below. It is always the side that is ENTERING, because
 * the element that exists during a transition is by construction the one
 * belonging to the output that just arrived: the moment `base` stops being a
 * given video, `videoUnderlay` either goes `null` or changes epoch, and the
 * old element unmounts in the same push that starts the new scene (re-keying
 * a playing video is what produces `PIPELINE_ERROR_DECODE` — see
 * `.claude/knowledge/worship-protocol-range-and-video-lifecycle.md`, and it
 * is why there is only ever one).
 *
 * What fades OUT in its place is a still of its last frame, drawn into a
 * canvas as the element is torn down (`captureFrame` / `FrozenFrame`) and
 * mounted on the outgoing layer. One decoder, a real crossfade, and over
 * 300ms indistinguishable from fading the moving picture itself.
 *
 * `mode === "preview"` never animates (`shouldAnimate`): the preview monitor
 * moves with every ↑/↓ and would feel laggy if it did.
 */
export function OutputView({
  audible = false,
  className,
  errorLabel,
  liveVideoStatus,
  mode,
  noticeDetail,
  noticeLabel,
  onMediaError,
  output,
  reportedErrorUrls,
  slideVideoRef,
  slideVideoStatus,
  videoRef,
  videoStill,
}: OutputViewProps) {
  // Warm the neighbouring slides so a change never waits on a decode. Plain
  // Image objects rather than hidden DOM nodes: no layout, no paint, and
  // nothing stray in the render tree. Only the real projector needs this.
  //
  // The current slide's own url leads the list: it is not warmed for its own
  // sake (the visible `<img>` is already fetching it) but so the set below can
  // tell "still wanted" from "abandoned" without a second source of truth.
  const preloadKey =
    mode === "live" && output.kind === "slide" ? [output.modelUrl ?? output.url, ...output.preload].join("|") : "";
  const warmedRef = useRef(new Map<string, HTMLImageElement>());
  useEffect(() => {
    const wanted = preloadKey ? preloadKey.split("|") : [];
    const keep = new Set(wanted);
    const warmed = warmedRef.current;

    // Abandon what this position no longer wants. Assigning `src = ""` is what
    // actually aborts an image fetch that is still in flight — dropping the
    // reference does not, so navigating quickly through a long deck used to
    // leave dozens of downloads running, competing for bandwidth and decode
    // time with the one slide the operator is actually waiting for. An image
    // that already finished is simply forgotten: it is in Chromium's cache
    // (slide urls are served `immutable`), so re-warming it later is free.
    for (const [url, img] of warmed) {
      if (keep.has(url)) continue;
      if (!img.complete) img.src = "";
      warmed.delete(url);
    }

    for (const url of wanted) {
      if (warmed.has(url)) continue;
      // A slide model is warmed by loading it (fonts and pictures included);
      // it is small, so there is nothing worth aborting.
      if (url.endsWith("/model")) {
        void loadSlideModel(url);
        continue;
      }
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      warmed.set(url, img);
    }
  }, [preloadKey]);

  // Unmount: nothing is wanted any more, in flight or not.
  useEffect(() => {
    const warmed = warmedRef.current;
    return () => {
      for (const img of warmed.values()) {
        if (!img.complete) img.src = "";
      }
      warmed.clear();
    };
  }, []);

  const shouldAnimate = mode !== "preview";
  const still = mode === "monitor" ? videoStill : undefined;
  const videoMounted = still === undefined;

  const seqRef = useRef(0);
  /** The frame `LiveVideo` handed over as it unmounted, waiting for the effect
   *  below to hang it on the layer that video is leaving behind. Consumed
   *  (and cleared) on the very next pass, so it can never surface in a later,
   *  unrelated transition. */
  const pendingFrozenFrameRef = useRef<HTMLCanvasElement | null>(null);
  const topRef = useRef<Layer>({ seq: 0, output });
  const lastEpochRef = useRef(output.transition.epoch);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [layers, setLayers] = useState<Layer[]>(() => [topRef.current]);
  const [transition, setTransition] = useState<LayerTransition>(output.transition);
  /** The last slide entry seen (`output.enter.seq`), so a push re-sending the
   *  same slide — a plate, a volume — does not play its way in again. */
  const lastEnterSeqRef = useRef(entryOf(output)?.seq ?? null);

  /**
   * The video hold. A transition INTO a video that has just been mounted waits,
   * at its first keyframe, for that video's first frame: otherwise the fade
   * runs while the element is still opening the file, parsing it and starting
   * its decoder — for 4K, most of the fade — so what fades in is an empty box
   * and the decoder spins up fighting the compositor for the same 300 ms. The
   * previous scene simply stays on screen a little longer, which is the one
   * thing nobody notices.
   *
   * `held` is only the paint side; `holdRef` is what the release needs (whose
   * fallback to arm, for how long) and `readyVideoEpochRef` covers a first
   * frame that arrived before the push that would have held for it.
   */
  const [held, setHeld] = useState(false);
  const holdRef = useRef<{ epoch: number; seq: number; durationMs: number } | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readyVideoEpochRef = useRef<number | null>(null);

  function armLeaveFallback(seq: number, durationMs: number) {
    if (leaveTimerRef.current !== null) clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = setTimeout(() => {
      leaveTimerRef.current = null;
      setLayers((prev) => withoutOutgoing(prev, seq));
    }, durationMs + LEAVE_FALLBACK_MARGIN_MS);
  }

  /** Drops a hold without starting its animation — the scene it was holding
   *  for has been replaced. */
  function cancelHold() {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    holdRef.current = null;
    setHeld(false);
  }

  function releaseHold() {
    const hold = holdRef.current;
    if (!hold) return;
    cancelHold();
    // From the release, not from the push: the animation only starts now.
    armLeaveFallback(hold.seq, hold.durationMs);
  }

  function handleVideoFirstFrame(epoch: number) {
    readyVideoEpochRef.current = epoch;
    // Committed now, in the frame that drew it: a render later the canvas has drawn the next frames out of
    // sight — a cut showed a clip from its third frame.
    if (holdRef.current?.epoch === epoch) flushSync(releaseHold);
  }

  // A LAYOUT effect, so the layers change in the same frame as the push. The
  // videos below read `output` straight from props: on the render that
  // delivers a new scene, the old `<video>` is already gone (or the new one
  // already mounted at full opacity) while `layers` still holds only the old
  // scene, with no frozen frame yet. A passive effect left that render on
  // screen whenever the browser painted before it ran — a black frame leaving
  // a video in 10 of 12 measured transitions.
  useLayoutEffect(() => {
    const sameEpoch = lastEpochRef.current === output.transition.epoch;
    lastEpochRef.current = output.transition.epoch;
    const sameContent = sceneContentKey(topRef.current.output) === sceneContentKey(output);
    // Within a scene, a slide the deck moved forward onto plays its own way
    // in (`enter`); a new scene plays the scene fade, whatever slide it opens.
    const enter = entryOf(output);
    const slideEntered =
      sameEpoch &&
      enter !== null &&
      enter.seq !== lastEnterSeqRef.current &&
      topRef.current.output.kind === output.kind;
    lastEnterSeqRef.current = enter?.seq ?? null;
    const layerTransition: LayerTransition | null = !sameEpoch
      ? output.transition
      : slideEntered
        ? enter
        : null;

    // Taken unconditionally: whichever branch runs, a frame left over from a
    // push that is not going to animate must not be waiting around for one
    // that will.
    const frozenFrame = pendingFrozenFrameRef.current;
    pendingFrozenFrameRef.current = null;

    // Whatever this push is, it replaces the scene an earlier hold was for.
    cancelHold();

    // A new video waits for its first frame with the previous picture on, cut or fade (owner, 2026-11-12: never
    // black in between) — see the video hold above.
    const incomingVideoEpoch = output.kind === "video" ? output.videoUnderlay?.epoch : undefined;
    const holdsForVideo =
      videoMounted &&
      incomingVideoEpoch !== undefined &&
      incomingVideoEpoch !== topRef.current.output.videoUnderlay?.epoch &&
      readyVideoEpochRef.current !== incomingVideoEpoch;

    if (
      !shouldAnimate ||
      sameContent ||
      !layerTransition ||
      (!isAnimatable(layerTransition) && !holdsForVideo)
    ) {
      // Content-only refresh: same layer, same key, no animation. This is
      // what keeps navigating within a live deck/verse, a pause toggle, or
      // an overlay's own `covered` prop an instant, un-keyed swap — exactly
      // like before transitions existed. `sameContent` catches the case a
      // changed epoch alone can't: an action that begins a new scene without
      // the picture actually changing (see `sceneContentKey`).
      const nextTop = { seq: topRef.current.seq, output };
      topRef.current = nextTop;
      // Any in-flight transition is over by definition — this collapses to a
      // single layer, so its fallback has nothing left to drop.
      if (leaveTimerRef.current !== null) {
        clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
      setLayers([nextTop]);
      return;
    }

    // A genuinely new scene: the current top becomes the outgoing layer, a
    // fresh one enters on top of it. Only two layers are ever kept — a
    // transition that arrives mid-flight replaces the pair outright (the
    // older of the two is dropped without waiting for its own animation),
    // rather than growing a queue.
    // The frame only belongs to a layer that WAS the video: the element also
    // unmounts when an overlay's own scene is replaced, and that layer paints
    // its own content.
    const outgoing: Layer = {
      ...topRef.current,
      frozenFrame: topRef.current.output.kind === "video" ? frozenFrame : null,
    };
    seqRef.current += 1;
    const incoming: Layer = { seq: seqRef.current, output };
    topRef.current = incoming;
    setTransition(layerTransition);
    setLayers([outgoing, incoming]);

    // The fallback that makes `animationend` optional. It never arrives if the
    // animation never ran — and an Electron window that is occluded (fully
    // covered by another window, or on a display that went to sleep) has no
    // rendering lifecycle at all, so no animation frames and no `animationend`;
    // see `.claude/knowledge/occluded-electron-window-has-no-rendering-lifecycle.md`.
    // Left alone, `animation-fill-mode: both` pins the incoming layer at its
    // keyframe's *start* — opacity 0 — with the outgoing one still painting at
    // full opacity underneath: the projector simply stops changing, which is
    // the worst symptom this component can produce.
    //
    // A hold defers it: the fallback is armed by `releaseHold`, and the hold's
    // own cap is a `setTimeout` for the same occluded-window reason. A cut
    // held this way is two layers too, and its release is the cut itself.
    if (holdsForVideo) {
      if (leaveTimerRef.current !== null) {
        clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
      holdRef.current = { epoch: incomingVideoEpoch, seq: outgoing.seq, durationMs: layerTransition.durationMs };
      holdTimerRef.current = setTimeout(releaseHold, VIDEO_READY_TIMEOUT_MS);
      setHeld(true);
    } else {
      armLeaveFallback(outgoing.seq, layerTransition.durationMs);
    }
    // The helpers above only touch refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [output, shouldAnimate]);

  // Unmount only — deliberately not the effect above's cleanup, which runs on
  // every single output push and would cancel the fallback for a transition
  // that is still perfectly in flight.
  useEffect(
    () => () => {
      if (leaveTimerRef.current !== null) clearTimeout(leaveTimerRef.current);
      if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current);
    },
    [],
  );

  function handleLeaveComplete(seq: number) {
    if (leaveTimerRef.current !== null) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
    setLayers((prev) => withoutOutgoing(prev, seq));
  }

  // One slot each, holding the url that last failed — never a growing set.
  // A single scene and a single video are on screen at a time, and the notice
  // below only fires when the slot still matches what is showing, so a slot
  // overwritten by a later failure is exactly a slot that stopped mattering.
  const [failedSceneUrl, setFailedSceneUrl] = useState<string | null>(null);
  const [failedVideoUrl, setFailedVideoUrl] = useState<string | null>(null);
  const [failedSlideVideoUrl, setFailedSlideVideoUrl] = useState<string | null>(null);
  const [failedSongVideoUrl, setFailedSongVideoUrl] = useState<string | null>(null);
  const [failedPlateUrl, setFailedPlateUrl] = useState<string | null>(null);
  // ...except when the SAME url comes back working. A USB drive unplugged and
  // plugged in again, or a file relocated, keeps its `worship://asset/<id>`:
  // the projector played it the second time and the LIVE monitor kept the red
  // band of the first, lying to the operator about the room. A new scene is a
  // new attempt, so it starts clean; a failure in it fills the slot again.
  const sceneEpoch = output.transition.epoch;
  useEffect(() => {
    setFailedSceneUrl(null);
    setFailedVideoUrl(null);
    setFailedSlideVideoUrl(null);
    setFailedSongVideoUrl(null);
    setFailedPlateUrl(null);
  }, [sceneEpoch]);

  function handleImageError(url: string) {
    setFailedSceneUrl(url);
    onMediaError?.({ target: { kind: "scene" }, url, code: null });
  }

  /**
   * Keeps the outgoing video's last frame so the layer it leaves behind has
   * real pixels to fade out.
   *
   * The projector keeps exactly ONE `<video>` mounted, deliberately: remounting
   * a playing element is what produced `PIPELINE_ERROR_DECODE (-12909)` (see
   * `.claude/knowledge/worship-protocol-range-and-video-lifecycle.md`). That
   * single element cannot be on both sides of a transition at once, so a
   * video -> anything change had nothing to fade out and cut to black. A still
   * of the last frame costs one decoder, not two, and over 300ms nobody can
   * tell it from the moving picture it replaces.
   */
  function freezeFrame(video: HTMLVideoElement | HTMLCanvasElement) {
    pendingFrozenFrameRef.current = captureFrame(video);
  }

  function handleVideoError(code: number | null) {
    // A video that will never show a frame must not keep the transition
    // waiting for one.
    releaseHold();
    const url = output.videoUnderlay?.url;
    if (!url) return;
    setFailedVideoUrl(url);
    onMediaError?.({ target: { kind: "video" }, url, code });
  }

  function handlePlateImageError(url: string) {
    setFailedPlateUrl(url);
    onMediaError?.({ target: { kind: "plate" }, url, code: null });
  }

  function handleSlideVideoError(code: number | null) {
    const url = output.slideVideo?.url;
    if (!url) return;
    setFailedSlideVideoUrl(url);
    onMediaError?.({ target: { kind: "slideVideo" }, url, code });
  }

  function handleSongVideoError(code: number | null) {
    const url = output.songVideo?.url;
    if (!url) return;
    setFailedSongVideoUrl(url);
    onMediaError?.({ target: { kind: "songVideo" }, url, code });
  }

  /** A failure is only worth showing while the thing that failed is still the
   *  thing on screen — which is what keeps a warning from outliving its
   *  content without any explicit clearing (see `ProjectionMediaError.url`). */
  function hasFailed(url: string | null | undefined): url is string {
    if (!url) return false;
    return (
      failedSceneUrl === url ||
      failedVideoUrl === url ||
      failedSlideVideoUrl === url ||
      failedSongVideoUrl === url ||
      failedPlateUrl === url ||
      (reportedErrorUrls?.includes(url) ?? false)
    );
  }

  // The video wins when both could apply: with BLACK/LOGO over a broken
  // video, "the video won't play" is the fact the operator needs — the
  // overlay itself is fine and is about to come off.
  const videoUnderlayUrl = output.videoUnderlay?.url ?? null;
  const slideVideoUrl = output.slideVideo?.url ?? null;
  const songVideoUrl = output.songVideo?.url ?? null;
  // A timer scene's own url is its background image, when it has one — the
  // only file a generated scene can fail to load.
  const sceneUrl =
    output.kind === "slide"
      ? (output.modelUrl ?? output.url)
      : output.kind === "image"
        ? output.url
      : output.kind === "logo"
        ? (output.url ?? output.backgroundUrl)
      : output.kind === "timer"
        ? output.backgroundUrl
        : null;
  // `mode !== "live"` is belt-and-suspenders on top of the projector simply
  // not passing a label: whatever a future caller does, the congregation
  // never sees this.
  const errorNotice =
    mode !== "live" &&
    errorLabel &&
    (hasFailed(videoUnderlayUrl) ||
      hasFailed(slideVideoUrl) ||
      hasFailed(songVideoUrl) ||
      hasFailed(sceneUrl) ||
      output.plates.some((plate) => hasFailed(plate.imageUrl)))
      ? errorLabel
      : null;
  // Same `mode !== "live"` guard, for the same reason: whatever a future
  // caller passes, the congregation never reads a message off the stage.
  const notice: { detail?: string | undefined; label: string; tone: OutputNoticeTone } | null = errorNotice
    ? { label: errorNotice, tone: "danger" }
    : mode !== "live" && noticeLabel
      ? { detail: noticeDetail, label: noticeLabel, tone: "notice" }
      : null;

  /**
   * Which side of the current transition (if any) the persistent video is on.
   * Only meaningful while two layers are stacked; with a single steady layer
   * nothing competes with the video for the same pixels.
   *
   * Decided by the INCOMING layer, never the outgoing one. The element that
   * exists during a transition is always the one belonging to the output that
   * just arrived — `videoEpoch` advances on every GO LIVE of a video
   * (`lib/actions/playback.ts`), so a video->video swap re-keys it and the
   * mounted element is the new video. Asking about `layers[0]` first meant
   * that in exactly that case both branches matched, the outgoing one won, and
   * the INCOMING video played the fade-OUT: it appeared at full opacity, faded
   * to black over ~270ms and then snapped back to 1. The side that is leaving
   * is a frozen frame on the outgoing layer now (see `captureFrame`), never
   * this element.
   */
  const videoRole: LayerRole =
    layers.length < 2 ? "steady" : layers[1]?.output.kind === "video" ? "entering" : "leaving";

  /** The same question for the slide's own video, answered against the `slide`
   *  kind instead: during a transition it belongs to whichever side is a
   *  slide, and it is the incoming one whenever a slide is arriving. */
  const slideVideoRole: LayerRole =
    layers.length < 2 ? "steady" : layers[1]?.output.kind === "slide" ? "entering" : "leaving";

  const posterFor = (layer: Layer) =>
    still && layer.output.kind === "video" && layer.output.url === still.videoUrl ? still.posterUrl : null;

  /** Whether the scene arriving paints every pixel of the stage, so what it
   *  replaces can hold still under it — see `transitionStyle`. Every scene
   *  layer is opaque but a video one, whose pixels are the `<video>` (opaque
   *  too, see its `bg-black`) or, with no video mounted, a poster that may not
   *  exist. */
  /** Only read when the video is the engine's. */
  const engineFrameKey = output.videoUnderlay
    ? mode === "preview"
      ? previewEngineFrameKey(output.videoUnderlay.url)
      : liveEngineFrameKey("video", output.videoUnderlay.epoch)
    : "";

  /** The song's video background plays here — not in PREVIEW, which never
   *  starts a video on its own, nor where the still stands in, nor once it
   *  failed: then each song layer paints its still instead. */
  const songVideo = output.songVideo ?? null;
  const songVideoMounted =
    songVideo !== null && videoMounted && mode !== "preview" && !hasFailed(songVideo.url);
  const videoBehind = (layer: Layer) => songVideoMounted && layer.output.kind === "song";

  const incoming = layers[1];
  // A song over its video is see-through: what it replaces fades out instead
  // of holding under it, or the video would only appear when that ends.
  const incomingCovers =
    incoming !== undefined &&
    !videoBehind(incoming) &&
    (incoming.output.kind !== "video" || videoMounted || posterFor(incoming) !== null);

  return (
    <div
      className={cn(
        "@container relative size-full overflow-hidden bg-black text-white",
        className,
      )}
    >
      {/* First of all: under every scene layer. Keyed by its epoch, so a new
          song's video is a new element and the same song's slides are not. */}
      {songVideo && songVideoMounted ? (
        <SongVideoLayer
          covered={output.kind !== "song"}
          key={songVideo.epoch}
          onError={handleSongVideoError}
          paced={mode === "live"}
          songVideo={songVideo}
        />
      ) : null}

      {layers.map((layer, i) => (
        <SceneLayer
          key={layer.seq}
          mode={mode}
          // Top layer only: a layer on its way out failing describes content
          // nobody is looking at any more, and would overwrite the slot that
          // holds the incoming layer's own failure.
          onImageError={i === layers.length - 1 ? handleImageError : undefined}
          onLeaveComplete={i === 0 ? () => handleLeaveComplete(layer.seq) : undefined}
          output={layer.output}
          frozenFrame={layer.frozenFrame}
          held={held}
          incomingCovers={incomingCovers}
          posterUrl={posterFor(layer)}
          role={layers.length < 2 ? "steady" : i === 0 ? "leaving" : "entering"}
          transition={transition}
          videoBehind={videoBehind(layer)}
        />
      ))}

      {/* Always the last sibling: painted after every scene layer, and its
          own z-index (via `videoRole`) settles who's on top whenever it's
          actually competing with a layer for the same pixels. */}
      {output.videoUnderlay && videoMounted && isEngineUrl(output.videoUnderlay.url) ? (
        <EngineVideo
          className="absolute inset-0 size-full bg-black object-contain"
          frameKey={engineFrameKey}
          key={engineFrameKey}
          onFirstFrame={() => handleVideoFirstFrame(output.videoUnderlay?.epoch ?? 0)}
          onFreezeFrame={shouldAnimate ? freezeFrame : undefined}
          paced={mode === "live"}
          style={transitionStyle(videoRole, transition, output.kind !== "video" ? 0 : 1, held, incomingCovers)}
        />
      ) : output.videoUnderlay && videoMounted ? (
        <LiveVideo
          audible={mode === "live" || audible}
          covered={output.kind !== "video"}
          epoch={output.videoUnderlay.epoch}
          held={held}
          incomingCovers={incomingCovers}
          key={output.videoUnderlay.epoch}
          liveVideoStatus={liveVideoStatus}
          loop={output.videoUnderlay.loop}
          mode={mode}
          onError={handleVideoError}
          onFirstFrame={handleVideoFirstFrame}
          onFreezeFrame={shouldAnimate ? freezeFrame : undefined}
          paused={output.videoUnderlay.paused}
          role={videoRole}
          startAtSeconds={output.videoUnderlay.startAtSeconds}
          transition={transition}
          url={output.videoUnderlay.url}
          volume={output.videoUnderlay.volume}
          videoRef={videoRef}
        />
      ) : null}

      {/* Over the slide image, under the notice. Mounted for as long as the
          live slide has a video — an overlay only covers it, exactly like the
          full-screen video above. */}
      {output.slideVideo && videoMounted ? (
        <SlideVideoLayer
          covered={output.kind !== "slide"}
          held={held}
          incomingCovers={incomingCovers}
          key={output.slideVideo.epoch}
          mode={mode}
          onError={handleSlideVideoError}
          role={slideVideoRole}
          slideVideo={output.slideVideo}
          status={slideVideoStatus}
          transition={transition}
          videoRef={slideVideoRef}
        />
      ) : null}

      {/* Above every scene layer and both videos, outside all of them — see
          `PlateLayer`. */}
      <PlateLayer onImageError={handlePlateImageError} plates={output.plates} />

      {/* Last of all, above every layer and the video: the operator has to be
          able to read it whatever is (or isn't) painting underneath. */}
      {notice ? <OutputNotice detail={notice.detail} label={notice.label} tone={notice.tone} /> : null}
    </div>
  );
}
