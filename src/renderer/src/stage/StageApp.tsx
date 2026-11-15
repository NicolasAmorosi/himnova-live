import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api";
import { onIpc } from "@renderer/lib/ipc";
import { StageView, type StageMedia } from "@renderer/components/shared/stage-view";
import { ProjectorCopy } from "@renderer/components/shared/projector-copy";
import type { StageOutput } from "@shared/types/projection";

const NO_MEDIA: StageMedia = { video: null, slideVideo: null };

/**
 * The stage screen (musicians and preacher): `StageView` of the last `StageOutput`, like the projector a pure
 * function of what the control window decided (`lib/stage-output.ts`). With Settings ▸ Screens' «videos on the
 * stage» on (the default) it plays what is live, silent, in step with the projector's own reports: main counts this
 * window among the projector's copies then (`stage-window.ts`), which is what brings it those reports and the
 * engine's frames. Off, a video is its poster. As «Proyector» it is a copy of the projector (`ProjectorCopy`).
 */
export function StageApp() {
  const [stage, setStage] = useState<StageOutput | null>(null);
  const [media, setMedia] = useState(NO_MEDIA);

  useEffect(() => {
    let pushed = false;
    const off = onIpc("stage-content", (next) => {
      pushed = true;
      setStage(next);
    });
    // A push that arrived while this was in flight is newer than the snapshot.
    void api.stage.getSnapshot().then((snapshot) => {
      if (!pushed && snapshot) setStage(snapshot);
    });
    return off;
  }, []);

  useEffect(
    () =>
      onIpc("media-status", (status) => {
        if (status.target.kind === "video") setMedia((m) => ({ ...m, video: status }));
        else if (status.target.kind === "slideVideo") setMedia((m) => ({ ...m, slideVideo: status }));
      }),
    [],
  );

  return (
    <main className="h-screen w-screen">
      <StageView copy={<ProjectorCopy />} media={media} stage={stage} />
    </main>
  );
}
