import { useEffect } from "react";
import { api } from "@renderer/lib/api";

/**
 * Every `<audio>`/`<video>` of this window plays through `sinkId` (Chromium's `setSinkId`, "" the system's default):
 * the ones on screen now, and each one that starts loading later (`loadstart` does not bubble, but it is seen on its
 * way down). The window decides nothing: the projector is given LIVE's output in its `ProjectionOutput`, the control
 * window PREVIEW's (`effects/audio-route.ts`). A failure leaves the element where it was while the engine moved, so it
 * is reported (`audioRoute:sinkFailed`) and the control window sends that bus to the default whole. The NDI® and stage
 * windows are muted and never call this.
 */
export function useAudioSink(sinkId: string): void {
  useEffect(() => {
    let current = true;
    const apply = (target: EventTarget | null) => {
      if (!(target instanceof HTMLMediaElement) || target.sinkId === sinkId) return;
      target.setSinkId(sinkId).catch((error: unknown) => {
        console.warn(`[audio] could not play through ${sinkId || "the default"}`, error);
        // Only for the output still asked for, and never for the default: there is nowhere else to go.
        if (current && sinkId !== "") void api.audioRoute.sinkFailed(sinkId);
      });
    };
    for (const element of document.querySelectorAll("audio, video")) apply(element);
    const onLoad = (event: Event) => apply(event.target);
    document.addEventListener("loadstart", onLoad, true);
    return () => {
      current = false;
      document.removeEventListener("loadstart", onLoad, true);
    };
  }, [sinkId]);
}
