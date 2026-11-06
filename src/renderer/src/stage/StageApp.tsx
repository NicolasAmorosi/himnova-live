import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api";
import { onIpc } from "@renderer/lib/ipc";
import { OutputView } from "@renderer/components/shared/output-view";
import type { ProjectionOutput, StageOutput } from "@shared/types/projection";

/** Hours and minutes, in the system's own format, kept to the second. */
function useTime(): string {
  const format = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const [time, setTime] = useState(format);
  useEffect(() => {
    const timer = setInterval(() => setTime(format()), 1000);
    return () => clearInterval(timer);
  }, []);
  return time;
}

/** A 16:9 frame drawn by the projector's own renderer, as a muted monitor. */
function Frame({ output, videoStill }: { output: ProjectionOutput | null; videoStill?: StageOutput["videoStill"] | undefined }) {
  return (
    <div className="w-full overflow-hidden rounded-md border border-white/25 bg-black">
      <div className="aspect-video w-full">
        {output ? <OutputView mode="monitor" output={output} videoStill={videoStill} /> : null}
      </div>
    </div>
  );
}

/**
 * The musicians' screen: what is live (large), what comes next and the time.
 * A pure function of the last `StageOutput`, like the projector: the control
 * window decides everything (`lib/stage-output.ts`). It plays nothing — a
 * video is its poster, a song's video background its still —, `next` included.
 */
export function StageApp() {
  const [stage, setStage] = useState<StageOutput | null>(null);
  const time = useTime();

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
    <main className="grid h-screen w-screen grid-cols-[3fr_2fr] items-center gap-[2vw] bg-black p-[2vw] text-white">
      <Frame output={stage?.current ?? null} videoStill={stage?.videoStill} />
      <aside className="flex min-w-0 flex-col gap-[1.5vw]">
        <div className="flex items-center justify-between gap-[1vw]">
          <time className="text-[7vw] leading-none font-semibold tabular-nums">{time}</time>
          {stage?.notice ? (
            <span className="rounded-md bg-on-air px-[1vw] py-[0.4vw] text-[1.8vw] font-bold">{stage.notice}</span>
          ) : null}
        </div>
        <p className="text-[1.6vw] font-medium tracking-wide text-white/60 uppercase">{stage?.nextLabel}</p>
        <Frame output={stage?.next ?? null} videoStill={stage?.videoStill} />
      </aside>
    </main>
  );
}
