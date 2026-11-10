import type { BrowserWindow, WebContents } from "electron";
import { engineAssetIdOfUrl, engineClipOfUrl, linkedAudioAssetIdOfUrl, liveEngineFrameKey, previewEngineFrameKey } from "@shared/urls";
import type { MediaCommand, MediaTarget, PreviewEngineVideo } from "@shared/types/projection";
import { getMediaRepo, getSlidesRepo } from "../services/repos";
import { broadcast, controlWindows } from "../services/broadcast";
import { projectionState } from "../services/projection-state";
import { takeEngine, type EngineEvents, type MediaEngine } from "./media-engine";
import {
  liveEngineAudio,
  liveEngineSlideVideo,
  liveEngineSongVideo,
  liveEngineState,
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
};

type VideoTarget = "video" | "slideVideo" | "songVideo";

/** The full-screen video and the live slide's clip: never both live, but two elements, as they are
 *  in the projector (`OutputView`). The song's video background is a third, and silent. */
const videos: Record<VideoTarget, Session | null> = { video: null, slideVideo: null, songVideo: null };
/** By `trackId`. Audio has no picture, so no window is shown its frames. */
const audio = new Map<string, Session>();
let preview: Session | null = null;

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
    status: (status) => {
      const { next, nudge } = watchStall(session.stall ?? null, status, session.paused, Date.now());
      session.stall = next;
      if (nudge && isCurrent()) {
        console.warn(`[engine] live ${target.kind} should play but stays at ${status.time}s, ${nudge}: ${session.url}`);
        if (nudge === "resume") session.engine?.setPaused(false);
        else session.engine?.seek(status.time);
      }
      broadcast("media-status", {
        target,
        epoch: session.epoch,
        currentTimeSeconds: status.time,
        durationSeconds: status.duration,
        paused: status.paused,
        ended: status.ended,
      });
    },
    error: (error) => {
      if (!isCurrent()) return;
      console.warn("[engine] live", target.kind, error.code, error.detail);
      broadcast("media-error", { target, url: session.url, code: null });
    },
  };
}

/** A live session already playing its file: only what can change without a new epoch. */
function apply(session: Session, want: { paused: boolean; volume: number; loop?: boolean }): void {
  if (want.paused !== session.paused) session.engine?.setPaused(want.paused);
  if (want.volume !== session.volume) session.engine?.setVolume(want.volume);
  if (want.loop !== undefined && want.loop !== session.loop) session.engine?.setLoop(want.loop);
  session.paused = want.paused;
  session.volume = want.volume;
  session.loop = want.loop ?? session.loop;
}

function syncAudio(projectorOpen: boolean): void {
  const want = new Map(liveEngineAudio(projectionState.getSnapshot().audioTracks, projectorOpen).map((t) => [t.trackId, t]));
  for (const [trackId, session] of audio) {
    const track = want.get(trackId);
    if (track && track.epoch === session.epoch && track.url === session.url) continue;
    session.engine?.quit();
    audio.delete(trackId);
  }
  for (const track of want.values()) {
    const existing = audio.get(track.trackId);
    if (existing) {
      apply(existing, track);
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
  if (session && (!want || want.epoch !== session.epoch || want.url !== session.url)) {
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
            error: (error) => {
              if (!isCurrent()) return;
              console.warn("[engine] live songVideo", error.code, error.detail);
              broadcast("media-error", { target: { kind: "songVideo" }, url: fresh.url, code: null });
            },
          }
        : liveEvents(fresh, { kind: target }, isCurrent);
    start(fresh, { startAtSeconds: want.startAtSeconds, audio: target !== "songVideo" }, liveEngineFrameKey(target, want.epoch), events);
  } else {
    apply(session, want);
  }
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

export function setPreviewVideo(video: PreviewEngineVideo | null, contents: WebContents): void {
  if (preview && preview.url !== video?.url) {
    preview.engine?.quit();
    preview = null;
  }
  if (!video) return;
  if (preview) {
    apply(preview, { paused: video.paused, volume: video.volume });
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

/** `projection:wantVideoFrame`: a canvas for these frames just mounted. */
export function redrawEngineFrame(key: string): void {
  for (const target of ["video", "slideVideo", "songVideo"] as const) {
    const session = videos[target];
    if (session && key === liveEngineFrameKey(target, session.epoch)) session.engine?.redraw();
  }
  if (preview && key === previewEngineFrameKey(preview.url)) preview.engine?.redraw();
}
