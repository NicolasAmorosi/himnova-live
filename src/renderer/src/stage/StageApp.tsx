import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api";
import { onIpc } from "@renderer/lib/ipc";
import { StageView } from "@renderer/components/shared/stage-view";
import type { StageOutput } from "@shared/types/projection";

/**
 * The stage screen (musicians and preacher): `StageView` of the last `StageOutput`, like the projector a pure
 * function of what the control window decided (`lib/stage-output.ts`). It plays nothing — a video is its poster,
 * a song's video background its still —, `next` included.
 */
export function StageApp() {
  const [stage, setStage] = useState<StageOutput | null>(null);

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

  return (
    <main className="h-screen w-screen">
      <StageView stage={stage} />
    </main>
  );
}
