import type { AudioOut, AudioRoute } from "@shared/types/audio";
import { setNdiAudioRoute } from "../ndi/ndi-output";
import { AUDIO_DEVICE_PROTO, matchEngineDevice } from "./engine-protocol";
import { setEngineAudioDevices } from "./engine-sessions";
import { engineAvailable, engineProtocol, listAudioDevices } from "./media-engine";

/**
 * Where the engine's sound goes, as the control window resolved it (`effects/audio-route.ts`): main applies it and
 * decides nothing. LIVE's output comes in each `ProjectionOutput` (`audioOut`), PREVIEW's and whether it plays apart
 * in `audioRoute:set`. The NDI® sound is captured from LIVE's output only (D6).
 */
let live: string | null = null;
let route: AudioRoute = { preview: null, previewApart: false };
let logged = "";

/** LIVE's engine output, from every output main forwards: only a change moves anything. */
export function applyLiveAudioOut(out: AudioOut | undefined): void {
  const name = out?.engineDevice;
  // The output is the renderer's: a name that cannot go on a line of the engine's plays on the default.
  const next = typeof name === "string" && !/[\r\n]/.test(name) ? name : null;
  if (next === live) return;
  live = next;
  apply();
}

/** Always applied, even unchanged: the NDI sender re-arms a capture that failed when told its route again. */
export function setAudioRoute(next: AudioRoute): void {
  route = next;
  apply();
}

function apply(): void {
  setEngineAudioDevices({ live, preview: route.preview });
  setNdiAudioRoute({ device: live, previewApart: route.previewApart });
  const line = `LIVE ${live ?? "default"}, PREVIEW ${route.preview ?? "default"}${route.previewApart ? " (apart)" : ""}`;
  if (line !== logged) console.info(`[audio] engine output: ${line}`);
  logged = line;
}

/** `matchEngineDevice` for each output, against the engine's own list; null when it cannot choose one. */
export async function matchAudioOutputs(outputs: readonly { deviceId: string; label: string }[]): Promise<(string | null)[] | null> {
  let list = await listAudioDevices();
  // A spare replaced before it answered (the app's card found at launch) leaves no answer: asked once more, unless
  // the engine already said it is too old to choose.
  if (list === null && engineAvailable() && (engineProtocol() ?? AUDIO_DEVICE_PROTO) >= AUDIO_DEVICE_PROTO) list = await listAudioDevices();
  return list && outputs.map((output) => matchEngineDevice(output, list));
}
