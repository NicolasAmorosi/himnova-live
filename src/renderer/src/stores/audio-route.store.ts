import { create } from "zustand";
import { DEFAULT_ROUTE, type AudioBusRoute } from "@renderer/lib/hooks/use-audio-outputs";

type AudioRouteState = {
  live: AudioBusRoute;
  preview: AudioBusRoute;
  /** Both buses end up in the same device (D6). */
  shared: boolean;
};

/** Where each bus really plays, as `effects/audio-route.ts` last resolved it: the strips read their warnings here. */
export const useAudioRouteStore = create<AudioRouteState>(() => ({ live: DEFAULT_ROUTE, preview: DEFAULT_ROUTE, shared: true }));
