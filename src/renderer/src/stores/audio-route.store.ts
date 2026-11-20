import { create } from "zustand";
import { DEFAULT_ROUTE, type AudioBusRoute, type AudioOutputs } from "@renderer/lib/hooks/use-audio-outputs";

type AudioRouteState = {
  live: AudioBusRoute;
  preview: AudioBusRoute;
  /** Both buses end up in the same device (D6). */
  shared: boolean;
  /** The outputs the route was resolved from, which the pickers list: read once per `devicechange`, here, and never a
   *  different list in the menu (2026-11-15 audit, X18). Empty until Chromium answers. */
  outputs: AudioOutputs;
};

/** Where each bus really plays, as `effects/audio-route.ts` last resolved it: the strips read their warnings here, and
 *  the output pickers their list. */
export const useAudioRouteStore = create<AudioRouteState>(() => ({
  live: DEFAULT_ROUTE,
  preview: DEFAULT_ROUTE,
  shared: true,
  outputs: { devices: [], defaultDeviceId: null, defaultGroupId: null },
}));
