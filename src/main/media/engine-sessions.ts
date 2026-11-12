import type { BrowserWindow, WebContents } from "electron";
import { engineAssetIdOfUrl, engineClipOfUrl, linkedAudioAssetIdOfUrl, liveEngineFrameKey, previewEngineFrameKey } from "@shared/urls";
import type { MediaCommand, MediaTarget, PreviewEngineVideo } from "@shared/types/projection";
import { getMediaRepo, getSlidesRepo } from "../services/repos";
import { broadcast, controlWindows } from "../services/broadcast";
import { projectionState } from "../services/projection-state";
import { takeEngine, type EngineEvents, type MediaEngine } from "./media-engine";
import {
  applyToSession,
  keepsSession,
  liveEngineAudio,
  liveEngineSlideVideo,
  liveEngineSongVideo,
  liveEngineState,
  liveMediaStatus,
  watchStall,
  type LiveEngineState,
  type StallWatch,
} from "./live-engine-state";

/**
 * The media engine's sessions: the live video, the live slide's clip, each live audio track, and the
 * PREVIEW monitor's video.
 * Plan `2026-10-25-reproduccion-instantanea`, §6 «Contrato del motor para el paso 1».
 *
 * The live ones follow the last `ProjectionOutput` and `AudioTrackPush[]`, the very values
 * `projectionState` replays into a rebuilt projector, so main keeps no record of its own of what is live
 * (`.claude/knowledge/main-cannot-know-what-is-live-under-an-overlay.md`). A new epoch is a new file in
 * a new engine; the same one only pauses, resumes or changes its level. The session does not live in
 * the projection window, so rebuilding that window neither restarts the video nor needs its position
 * frozen first.
 *
 * An engine that dies takes only its own session, and stays dead: the operator is told, as with a
 * file the projector cannot open, and decides. GO LIVE again is a new epoch, so a new engine (owner,
 * 2026-10-30).
 */

type Session = {
  engine: MediaEngine | null;
  url: string;
  epoch: number;
  paused: boolean;
  volume: number;
  loop: boolean;
  stall?: StallWatch | null;
  /** Kept paused, whatever the output says, until these windows mount the canvas its frames go to. */
  hold?: { waiting: Set<number>; timer: NodeJS.Timeout };
};

type VideoTarget = "video" | "slideVideo" | "songVideo";

/** The full-screen video and the live slide's clip: never both live, but two elements, as they are
 *  in the projector (`OutputView`). The song's video background is a third, and silent. */
const videos: Record<VideoTarget, Session | null> = { video: null, slideVideo: null, songVideo: null };
/** By `trackId`. Audio has no picture, so no window is shown its frames. */
const audio = new Map<string, Session>();
let preview: Session | null = null;
/** What PREVIEW last asked for, and from which window: GO LIVE takes its engine and starts it another. */
let previewAsked: { video: PreviewEngineVideo; contents: WebContents } | null = null;

/** The longest a live video taken from PREVIEW waits paused for the projector and the NDI window to mount its
 *  canvas. A cap and not a promise, like the projector's own hold: a window that never asks (hidden, occluded)
 *  must not keep the room silent. */
const SHOWN_CAP_MS = 1000;

/** `session.engine` playing `session.url`, or none when the url names no file — then `events.error`
 *  says so, like the engine itself would. */
function start(
  session: Session,
  opts: { startAtSeconds: number; audio: boolean },
  frameKey: string,
  events: EngineEvents,
): void {
  const assetId = engineAssetIdOfUrl(session.url);
  const clip = engineClipOfUrl(session.url);
  // A deck's linked music: PREVIEW's, and the live one when Chromium cannot play it (a `.wma`).
  const linked = linkedAudioAssetIdOfUrl(session.url);
  const file =
    assetId !== null
      ? getMediaRepo().getPathById(assetId)
      : clip?.kind === "audio"
        ? getSlidesRepo().getAudioPath(clip.id)
        : clip?.kind === "video"
          ? getSlidesRepo().getVideoPath(clip.id)
          : linked !== null
            ? getMediaRepo().linkedAudioPathById(linked)
            : null;
  if (!file) {
    events.error?.({ code: "engine-open", detail: `no file for ${session.url}` });
    return;
  }
  session.engine = takeEngine();
  session.engine.load(
    { file, startAtSeconds: opts.startAtSeconds, paused: session.paused, volume: session.volume, loop: session.loop, audio: opts.audio },
    frameKey,
    events,
  );
}

/** The live sessions' `media-status` and `media-error`, as the projector's own elements report them. */
function liveEvents(session: Session, target: MediaTarget, isCurrent: () => boolean): EngineEvents {
  return {
    ...pictureExpected(target.kind !== "audio", session, target, isCurrent),
    status: (status) => {
      // A report the previous engine had already written when it was told to quit: it would move the
      // next deck's slide to its own position (2026-11-10 review, agent1-07).
      if (!isCurrent()) return;
      const { next, nudge } = watchStall(session.stall ?? null, status, session.paused, Date.now());
      session.stall = next;
      if (nudge && isCurrent()) {
        console.warn(`[engine] live ${target.kind} should play but stays at ${status.time}s, ${nudge}: ${session.url}`);
        if (nudge === "resume") session.engine?.setPaused(false);
        else session.engine?.seek(status.time);
      }
      broadcast("media-status", liveMediaStatus(target, session.epoch, status));
    },
    error: (error) => {
      if (!isCurrent()) return;
      console.warn("[engine] live", target.kind, error.code, error.detail);
      broadcast("media-error", { target, url: session.url, code: null });
    },
  };
}

/** A video whose picture the engine cannot decode (a codec FFmpeg lacks, a damaged video track) played
 *  its sound over black with no word to anyone: the «sound over black» the engine exists to end
 *  (2026-11-10 review, agent1-06). Said like any file the projector cannot play. */
function pictureExpected(
  expected: boolean,
  session: Session,
  target: MediaTarget | { kind: "songVideo" },
  isCurrent: () => boolean,
): Pick<EngineEvents, "loaded"> {
  if (!expected) return {};
  return {
    loaded: (info) => {
      if (info.hasVideo || !isCurrent()) return;
      console.warn("[engine] live", target.kind, "has no picture it can decode:", session.url);
      broadcast("media-error", { target, url: session.url, code: null });
    },
  };
}

function syncAudio(projectorOpen: boolean): void {
  const want = new Map(liveEngineAudio(projectionState.getSnapshot().audioTracks, projectorOpen).map((t) => [t.trackId, t]));
  for (const [trackId, session] of audio) {
    if (keepsSession(session, want.get(trackId) ?? null)) continue;
    session.engine?.quit();
    audio.delete(trackId);
  }
  for (const track of want.values()) {
    const existing = audio.get(track.trackId);
    if (existing) {
      applyToSession(existing, track);
      continue;
    }
    const session: Session = { engine: null, url: track.url, epoch: track.epoch, paused: track.paused, volume: track.volume, loop: track.loop };
    audio.set(track.trackId, session);
    const target = { kind: "audio", trackId: track.trackId } as const;
    start(session, { startAtSeconds: track.startAtSeconds, audio: true }, "", liveEvents(session, target, () => audio.get(track.trackId) === session));
  }
}

function syncVideo(target: VideoTarget, want: LiveEngineState | null, windows: (BrowserWindow | null)[]): void {
  let session = videos[target];
  if (session && !keepsSession(session, want)) {
    session.engine?.quit();
    session = videos[target] = null;
  }
  if (!want) return;

  if (!session) {
    const fresh: Session = { engine: null, url: want.url, epoch: want.epoch, paused: want.paused, volume: want.volume, loop: want.loop };
    session = videos[target] = fresh;
    const isCurrent = () => videos[target] === fresh;
    // A background reports no position (nothing in the control window follows it), only a failure;
    // and its audio is never even decoded, like PREVIEW's.
    const events: EngineEvents =
      target === "songVideo"
        ? {
            ...pictureExpected(true, fresh, { kind: "songVideo" }, isCurrent),
            error: (error) => {
              if (!isCurrent()) return;
              console.warn("[engine] live songVideo", error.code, error.detail);
              broadcast("media-error", { target: { kind: "songVideo" }, url: fresh.url, code: null });
            },
          }
        : liveEvents(fresh, { kind: target }, isCurrent);
    const frameKey = liveEngineFrameKey(target, want.epoch);
    const taken = target === "video" ? takePreviewEngine(want.url, want.startAtSeconds) : null;
    if (taken) {
      // What that engine was last told, so only the differences are sent.
      Object.assign(fresh, { engine: taken.engine, paused: taken.paused, volume: taken.volume, loop: taken.loop });
      taken.engine.retarget(frameKey, events);
      if (!want.paused) holdUntilShown(fresh);
    } else {
      start(fresh, { startAtSeconds: want.startAtSeconds, audio: target !== "songVideo" }, frameKey, events);
    }
  }
  applyToSession(session, session.hold ? { ...want, paused: true } : want);
  // The projector, and the control window's LIVE monitor: one decode, the same frame on both.
  for (const win of windows) if (win) session.engine?.show(win.webContents);
}

/** Called whenever the output, the audio tracks or the projector window change. */
export function syncLiveEngine(): void {
  const projector = projectionState.getWindow();
  const { output } = projectionState.getSnapshot();
  // The NDI output draws the projector's picture, its videos included.
  const windows = [projector, ...projectionState.getMirrors(), ...controlWindows()];
  syncAudio(projector !== null);
  syncVideo("video", liveEngineState(output, projector !== null), windows);
  syncVideo("slideVideo", liveEngineSlideVideo(output, projector !== null), windows);
  syncVideo("songVideo", liveEngineSongVideo(output, projector !== null), windows);
}

/** A seek from the media panel, when its target is one of the engine's. `restart` is a seek to 0 as
 *  well: whether it plays is the declarative `paused`, never a command's (`restartDeck` sets both). */
export function commandLiveEngine(command: MediaCommand): boolean {
  const { target } = command;
  const session = target.kind === "audio" ? audio.get(target.trackId) : videos[target.kind];
  if (!session) return false;
  session.engine?.seek(command.action === "seek" ? command.timeSeconds : 0);
  return true;
}

/**
 * GO LIVE on the video PREVIEW shows: its engine, which already opened the file, drew its first frame and has its
 * sound ready where the operator left it (owner, 2026-11-12). On a Windows PC a cold start was 0.8–1.2 s to the first
 * frame over NDI. PREVIEW starts another, paused at the same point — a moment without picture only the operator
 * sees. None when that engine failed or is gone: then the live one opens the file itself, as before.
 */
function takePreviewEngine(url: string, atSeconds: number): (Session & { engine: MediaEngine }) | null {
  const session = preview;
  const asked = previewAsked;
  if (!session?.engine?.usable || session.url !== url || !asked?.video.picture) return null;
  preview = null;
  // Where the live one starts: «Al terminar» sends the next row from 0:00, which PREVIEW may hold elsewhere. Within
  // half a second it is PREVIEW's own point, a status or two behind the engine (~4 a second while it plays).
  if (Math.abs(session.engine.position - atSeconds) > 0.5) session.engine.seek(atSeconds);
  // Paused: GO LIVE stops PREVIEW's playback (`stopPreviewPlayback`), whichever of the two messages lands first.
  setPreviewVideo({ ...asked.video, paused: true, startAtSeconds: atSeconds }, asked.contents);
  return { ...session, engine: session.engine };
}

/** The room must not hear a video before it sees it: an engine taken from PREVIEW is already open, so it would
 *  sound the instant it is told to play, before the projector and the NDI window have even mounted its canvas. */
function holdUntilShown(session: Session): void {
  const waiting = new Set([projectionState.getWindow(), ...projectionState.getMirrors()].flatMap((win) => (win ? [win.webContents.id] : [])));
  if (!waiting.size) return;
  const timer = setTimeout(() => {
    if (videos.video === session) console.warn(`[engine] live video played after ${SHOWN_CAP_MS} ms unseen: ${session.url}`);
    releaseHold(session);
  }, SHOWN_CAP_MS);
  session.hold = { waiting, timer };
}

function releaseHold(session: Session): void {
  if (!session.hold) return;
  clearTimeout(session.hold.timer);
  delete session.hold;
  if (videos.video !== session) return;
  syncLiveEngine();
  // Paused meanwhile (NEGRO, the operator): the frame its windows asked for, which the hold did not draw.
  if (session.paused) session.engine?.redraw();
}

export function setPreviewVideo(video: PreviewEngineVideo | null, contents: WebContents): void {
  previewAsked = video ? { video, contents } : null;
  if (preview && preview.url !== video?.url) {
    preview.engine?.quit();
    preview = null;
  }
  if (!video) return;
  if (preview) {
    applyToSession(preview, { paused: video.paused, volume: video.volume });
    return;
  }
  // Audio decoded at PREVIEW's own volume, 0 to start (owner, 2026-11-05: «todo
  // como en vivo pero con el volumen a 0; si le suben el volumen se escucha»).
  const session: Session = { engine: null, url: video.url, epoch: 0, paused: video.paused, volume: video.volume, loop: false };
  preview = session;
  start(session, { startAtSeconds: video.startAtSeconds, audio: true }, video.picture ? previewEngineFrameKey(video.url) : "", {
    status: (status) =>
      broadcast("preview-video-status", {
        url: session.url,
        currentTimeSeconds: status.time,
        durationSeconds: status.duration,
        paused: status.paused,
        ended: status.ended,
      }),
    error: (error) => {
      if (preview !== session) return;
      console.warn("[engine] preview", error.code, error.detail);
      broadcast("preview-video-error", { url: session.url });
    },
  });
  if (video.picture) session.engine?.show(contents);
}

export function seekPreviewVideo(seconds: number): void {
  preview?.engine?.seek(seconds);
}

/** `projection:wantVideoFrame`: a canvas for these frames just mounted in `sender`. */
export function redrawEngineFrame(key: string, sender: WebContents): void {
  for (const target of ["video", "slideVideo", "songVideo"] as const) {
    const session = videos[target];
    if (!session || key !== liveEngineFrameKey(target, session.epoch)) continue;
    // Held, playing is what draws it — for every window.
    if (!session.hold) session.engine?.redraw();
    else if (session.hold.waiting.delete(sender.id) && !session.hold.waiting.size) releaseHold(session);
  }
  if (preview && key === previewEngineFrameKey(preview.url)) preview.engine?.redraw();
}
