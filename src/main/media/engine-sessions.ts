import type { BrowserWindow, WebContents } from "electron";
import { engineAssetIdOfUrl, engineClipOfUrl, linkedAudioAssetIdOfUrl, liveEngineFrameKey, previewEngineFrameKey } from "@shared/urls";
import type { MediaCommand, MediaTarget, PreviewEngineVideo } from "@shared/types/projection";
import { getMediaRepo, getSlidesRepo } from "../services/repos";
import { broadcast, controlWindows } from "../services/broadcast";
import { projectionState } from "../services/projection-state";
import { takeEngine, type EngineError, type EngineEvents, type MediaEngine } from "./media-engine";
import { engineFailedOn } from "./engine-assets";
import { clipEngineFailed } from "./deck-clips";
import { heardAt, reportLevel } from "./audio-levels";
import { liveMusicFile } from "../protocol/worship-protocol";
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
 *
 * The live ones follow the last `ProjectionOutput` and `AudioTrackPush[]`, the very values
 * `projectionState` replays into a rebuilt projector, so main keeps no record of its own of what is live
 * (`.claude/knowledge/main-cannot-know-what-is-live-under-an-overlay.md`). A new epoch is a new file in
 * a new engine; the same one only pauses, resumes or changes its level. The session does not live in
 * the projection window, so rebuilding that window neither restarts the video nor needs its position
 * frozen first.
 *
 * An engine that dies takes only its own session, and is not started again (owner, 2026-10-30). A file Chromium plays
 * goes on in Chromium from where it was, and the operator is told once a session (owner, 2026-11-17:
 * `fellBackToChromium`); any other is the operator's to decide, as with a file the projector cannot open, and GO LIVE
 * again is a new epoch, so a new engine.
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
  hold?: { waiting: Set<number>; timer: NodeJS.Timeout; since: number; target: VideoTarget; why: string };
};

type VideoTarget = "video" | "slideVideo" | "songVideo";

/** The full-screen video and the live slide's clip: never both live, but two elements, as they are
 *  in the projector (`OutputView`). The song's video background is a third, and silent. */
const videos: Record<VideoTarget, Session | null> = { video: null, slideVideo: null, songVideo: null };
/** By `trackId`. Audio has no picture, so no window is shown its frames. */
const audio = new Map<string, Session>();
let preview: Session | null = null;
/** Where each bus sounds (mpv's `audio-device` names, `EngineDevice.name`): null is the system's default, and then
 *  nothing is sent, as before there was a choice. */
const devices: { live: string | null; preview: string | null } = { live: null, preview: null };
/** What the control window was last told of each output (`audio-out`, by mpv name): every session on a bus says the
 *  same thing, so it is said once. A route that changes forgets it: an output chosen again that still fails is said again. */
const audioOutSaid = new Map<string, boolean>();
/** What PREVIEW last asked for, and from which window: GO LIVE takes its engine and starts it another. */
let previewAsked: { video: PreviewEngineVideo; contents: WebContents } | null = null;

/** The longest a live video taken from PREVIEW waits paused for the projector and the NDI window to mount its
 *  canvas. A cap and not a promise, like the projector's own hold: a window that never asks (hidden, occluded)
 *  must not keep the room silent. */
const SHOWN_CAP_MS = 1000;

/** The projector window `projection:open` is syncing into, while it does: what it finds paused for the projector's
 *  absence waits for this window to show it (`syncLiveEngineIntoNewProjector`). */
let newProjector: number | null = null;

/** `session.engine` playing `session.url`, or none when the url names no file — then `events.error`
 *  says so, like the engine itself would. */
function start(
  session: Session,
  opts: { startAtSeconds: number; audio: boolean; device: string | null },
  frameKey: string,
  events: EngineEvents,
): void {
  const assetId = engineAssetIdOfUrl(session.url);
  const clip = engineClipOfUrl(session.url);
  // A deck's linked music: PREVIEW's, and the live one when Chromium cannot play it (a `.wma`).
  const linked = linkedAudioAssetIdOfUrl(session.url);
  const file =
    assetId !== null
      ? getMediaRepo().getPathById(getMediaRepo().survivingId(assetId))
      : clip?.kind === "audio"
        ? getSlidesRepo().getAudioPath(clip.id)
        : clip?.kind === "video"
          ? getSlidesRepo().getVideoPath(clip.id)
          : linked !== null
            ? getMediaRepo().linkedAudioPathById(getMediaRepo().survivingId(linked))
            : null;
  if (!file) {
    events.error?.({ code: "engine-open", detail: `no file for ${session.url}` });
    return;
  }
  session.engine = takeEngine();
  session.engine.load(
    {
      // The music of the deck on air, from its copy once its own file is gone (`liveMusicFile`, 2026-11-22 audit, RV-4).
      file: linked !== null ? liveMusicFile(file) : file,
      startAtSeconds: opts.startAtSeconds,
      paused: session.paused,
      volume: session.volume,
      loop: session.loop,
      audio: opts.audio,
      ...(opts.device !== null && opts.audio ? { device: opts.device } : {}),
    },
    frameKey,
    events,
  );
}

/** An engine session lost its output or could not open it (`ok: false`), or has it back: the control window routes
 *  that bus to the default whole and says so (`effects/audio-route.ts`). */
function audioOut(isCurrent: () => boolean): NonNullable<EngineEvents["audioOut"]> {
  return ({ device, ok }) => {
    if (!isCurrent() || audioOutSaid.get(device) === ok) return;
    audioOutSaid.set(device, ok);
    console.info(`[engine] audio-out ${device}: ${ok ? "ok" : "lost"}`);
    broadcast("audio-out", { device, ok });
  };
}

/** The engine itself failed under `url` (it exited, or its GPU did: not a file it could not open), and Chromium plays
 *  that file: it goes back to Chromium for the session, and the renderer moves what is live onto it at the same
 *  position (`engineFailedOn`). True when it did: then no failure is said, only the move, once a session. */
function fellBackToChromium(url: string, error: EngineError): boolean {
  if (error.code !== "engine-exit" && error.code !== "engine-gpu") return false;
  const clip = engineClipOfUrl(url);
  const assetId = engineAssetIdOfUrl(url);
  if (clip ? !clipEngineFailed(clip.kind, clip.id) : assetId === null || !engineFailedOn(assetId)) return false;
  broadcast("engine-fallback", undefined);
  return true;
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
      if (!fellBackToChromium(session.url, error)) broadcast("media-error", { target, url: session.url, code: null });
    },
    // The engine measures before its volume; the room hears it through the session's (item × LIVE's fader).
    level: (peak) => {
      if (isCurrent()) reportLevel(session, "live", heardAt(peak, session.volume));
    },
    audioOut: audioOut(isCurrent),
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
    start(session, { startAtSeconds: track.startAtSeconds, audio: true, device: devices.live }, "", liveEvents(session, target, () => audio.get(track.trackId) === session));
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
              if (fellBackToChromium(fresh.url, error)) return;
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
      // From PREVIEW's output to the room's while it is held paused for its windows: the room never hears it elsewhere.
      // mpv reopens its output only when sound flows; a seek where it stands has it reopened before the hold ends:
      // sound 8 ms after play on Windows, 12 on Linux, 222–228 on a Mac, instead of 244–556 (2026-11-15).
      if (devices.preview !== devices.live) {
        taken.engine.setDevice(devices.live ?? "auto");
        taken.engine.seek(want.startAtSeconds);
      }
      if (!want.paused) holdUntilShown(fresh, target, "its windows");
    } else {
      start(fresh, { startAtSeconds: want.startAtSeconds, audio: target !== "songVideo", device: devices.live }, frameKey, events);
    }
  } else if (newProjector !== null && session.paused && !want.paused && !session.hold && target !== "songVideo") {
    // Paused while there was no projector, and still open: told to play now, it sounded ~0.25 s before the new
    // window could show it, longer on a slow PC (audit A19). It waits for that window alone: the NDI one and the LIVE
    // monitor kept their canvas and ask for nothing, so waiting on them would always run to the cap.
    holdUntilShown(session, target, "the new projector", [newProjector]);
  }
  applyToSession(session, session.hold ? { ...want, paused: true } : want);
  // The projector, its copies and the control window's LIVE monitor: one decode, the same frame on all.
  session.engine?.showOnly(windows.flatMap((win) => (win ? [win.webContents] : [])));
}

/** `projection:open` made `win`: the sync that lets what the closed projector paused play again, into it. */
export function syncLiveEngineIntoNewProjector(win: BrowserWindow): void {
  newProjector = win.webContents.id;
  try {
    syncLiveEngine();
  } finally {
    newProjector = null;
  }
}

/** Called whenever the output, the audio tracks or the projector window change. */
export function syncLiveEngine(): void {
  const projector = projectionState.getWindow();
  const { output } = projectionState.getSnapshot();
  // The NDI output and the stage screen (while it plays videos) draw the projector's videos too.
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
 *  sound the instant it is told to play, before the projector and the NDI window have even mounted its canvas. The
 *  same for one the closed projector paused, when a new projector opens (`syncLiveEngineIntoNewProjector`). */
function holdUntilShown(
  session: Session,
  target: VideoTarget,
  why: string,
  windows: number[] = projectionState.getWatched().map((win) => win.webContents.id),
): void {
  const waiting = new Set(windows);
  if (!waiting.size) return;
  const timer = setTimeout(() => {
    if (isLive(session)) console.warn(`[engine] live ${target} played after ${SHOWN_CAP_MS} ms unseen: ${session.url}`);
    releaseHold(session);
  }, SHOWN_CAP_MS);
  session.hold = { waiting, timer, since: Date.now(), target, why };
}

const isLive = (session: Session): boolean => Object.values(videos).includes(session);

function releaseHold(session: Session): void {
  const hold = session.hold;
  if (!hold) return;
  clearTimeout(hold.timer);
  delete session.hold;
  if (!isLive(session)) return;
  if (!hold.waiting.size) console.info(`[engine] live ${hold.target} held ${Date.now() - hold.since} ms until ${hold.why} showed it`);
  syncLiveEngine();
  // Paused meanwhile (NEGRO, the operator): the frame its windows asked for, which the hold did not draw.
  if (session.paused) session.engine?.redraw();
}

/** The control window closed (macOS keeps the app): nothing of PREVIEW's plays on with no window to show it. */
export function stopPreviewEngine(): void {
  previewAsked = null;
  preview?.engine?.quit();
  preview = null;
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
  start(session, { startAtSeconds: video.startAtSeconds, audio: true, device: devices.preview }, video.picture ? previewEngineFrameKey(video.url) : "", {
    status: (status) => {
      // A report a quit engine had already written: after A, B, A its url is the current PREVIEW's, and its time
      // and pause would pass for the new engine's (2026-11-15 audit, A34).
      if (preview !== session) return;
      broadcast("preview-video-status", {
        url: session.url,
        currentTimeSeconds: status.time,
        durationSeconds: status.duration,
        paused: status.paused,
        ended: status.ended,
      });
    },
    error: (error) => {
      if (preview !== session) return;
      console.warn("[engine] preview", error.code, error.detail);
      if (!fellBackToChromium(session.url, error)) broadcast("preview-video-error", { url: session.url });
    },
    level: (peak) => {
      if (preview === session) reportLevel(session, "preview", heardAt(peak, session.volume));
    },
    audioOut: audioOut(() => preview === session),
  });
  if (video.picture) session.engine?.show(contents);
}

/** Moves each bus to its output (mpv names, null the system's default): the sessions playing now and every one
 *  after. The song's video background is silent and stays put. */
export function setEngineAudioDevices(next: { live: string | null; preview: string | null }): void {
  if (next.live !== devices.live || next.preview !== devices.preview) audioOutSaid.clear();
  if (next.live !== devices.live) {
    devices.live = next.live;
    for (const session of [videos.video, videos.slideVideo, ...audio.values()]) moveSession(session, next.live);
  }
  if (next.preview !== devices.preview) {
    devices.preview = next.preview;
    moveSession(preview, next.preview);
  }
}

/** mpv reopens a moved output only when sound flows, so a paused session would sound 244–556 ms late on play: sought
 *  where it stands (`redraw`, a paused engine only), it reopens the output now, as `takePreviewEngine`'s handover does. */
function moveSession(session: Session | null | undefined, device: string | null): void {
  session?.engine?.setDevice(device ?? "auto");
  if (session?.paused) session.engine?.redraw();
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
