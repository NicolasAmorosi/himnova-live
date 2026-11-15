import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@renderer/lib/api";
import { onIpc } from "@renderer/lib/ipc";
import { OutputView } from "@renderer/components/shared/output-view";
import { INSTANT_TRANSITION, type MediaStatus, type ProjectionOutput } from "@shared/types/projection";

const PLACEHOLDER: ProjectionOutput = { kind: "black", videoUnderlay: null, slideVideo: null, plates: [], transition: INSTANT_TRANSITION };

/**
 * What main last sent the projector (`display-content`). A window is shown before its page has loaded, so a push
 * can land before the listener exists — a silent drop: main's snapshot, pulled once mounted, closes that race, and a
 * push that arrived meanwhile is newer than it. The snapshot's last video reports seed a copy mounted while the
 * projector is paused, which sends none. `real` flips once real data replaces the placeholder: keyed on it,
 * `OutputView`'s «the very first scene never fades» applies to that, not to a fade out of the placeholder.
 */
function useProjectorOutput(onStatuses: (statuses: MediaStatus[]) => void): { output: ProjectionOutput; real: boolean } {
  const [state, setState] = useState({ output: PLACEHOLDER, real: false });
  useEffect(() => {
    let sawPush = false;
    const off = onIpc("display-content", (output) => {
      sawPush = true;
      setState({ output, real: true });
    });
    void api.projection.getSnapshot().then(({ output, mediaStatus }) => {
      if (!sawPush && output) setState({ output, real: true });
      onStatuses(mediaStatus);
    });
    return off;
  }, [onStatuses]);
  return state;
}

/**
 * A copy of the projector: the NDI® output's offscreen window (`main/ndi/ndi-output.ts`) and the stage screen as
 * «Proyector». The same pixels, from the same pushes (main counts it among `projectionState`'s mirrors), but not the
 * projector: it reports nothing (the panel would see every video twice), mounts no audio track and its window is
 * muted (the room hears the projector), and its Chromium videos follow the projector's own reports
 * (`follow-projector.ts`). The engine's videos reach it as they reach every mirror.
 */
export function ProjectorCopy() {
  const [video, setVideo] = useState<MediaStatus | null>(null);
  const [slideVideo, setSlideVideo] = useState<MediaStatus | null>(null);
  // A report that arrived meanwhile is newer than the snapshot's.
  const seed = useCallback((statuses: MediaStatus[]) => {
    for (const status of statuses) {
      if (status.target.kind === "video") setVideo((current) => current ?? status);
      else if (status.target.kind === "slideVideo") setSlideVideo((current) => current ?? status);
    }
  }, []);
  const { output, real } = useProjectorOutput(seed);
  const videoRef = useRef<HTMLVideoElement>(null);
  const slideVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(
    () =>
      onIpc("media-status", (status) => {
        if (status.target.kind === "video") setVideo(status);
        else if (status.target.kind === "slideVideo") setSlideVideo(status);
      }),
    [],
  );

  // The projector's seeks, applied at once rather than waiting for its next report.
  useEffect(
    () =>
      onIpc("media-command", (command) => {
        const { kind } = command.target;
        const element = kind === "video" ? videoRef.current : kind === "slideVideo" ? slideVideoRef.current : null;
        if (!element) return;
        if (command.action === "seek") {
          element.currentTime = command.timeSeconds;
        } else {
          element.currentTime = 0;
          void element.play();
        }
      }),
    [],
  );

  return (
    <OutputView
      key={real ? "live" : "placeholder"}
      liveVideoStatus={video}
      mode="live"
      output={output}
      slideVideoRef={slideVideoRef}
      slideVideoStatus={slideVideo}
      videoRef={videoRef}
    />
  );
}
