import { useEffect } from "react";

/**
 * Every `<audio>`/`<video>` of this window plays through `sinkId` (Chromium's `setSinkId`, "" the system's default):
 * the ones on screen now, and each one that starts loading later (`loadstart` does not bubble, but it is seen on its
 * way down). The window decides nothing: the projector is given LIVE's output in its `ProjectionOutput`, the control
 * window PREVIEW's (`effects/audio-route.ts`). The NDI® and stage windows are muted and never call this.
 */
export function useAudioSink(sinkId: string): void {
  useEffect(() => {
    const apply = (target: EventTarget | null) => {
      if (!(target instanceof HTMLMediaElement) || target.sinkId === sinkId) return;
      target.setSinkId(sinkId).catch((error: unknown) => console.warn(`[audio] could not play through ${sinkId || "the default"}`, error));
    };
    for (const element of document.querySelectorAll("audio, video")) apply(element);
    const onLoad = (event: Event) => apply(event.target);
    document.addEventListener("loadstart", onLoad, true);
    return () => document.removeEventListener("loadstart", onLoad, true);
  }, [sinkId]);
}
