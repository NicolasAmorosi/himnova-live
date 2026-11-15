import type { AudioRoute, EngineOutputNames } from "@shared/types/audio";
import { setNdiAudioRoute } from "../ndi/ndi-output";
import { AUDIO_DEVICE_PROTO, matchEngineDevice } from "./engine-protocol";
import { setEngineAudioDevices } from "./engine-sessions";
import { engineAvailable, engineProtocol, listAudioDevices } from "./media-engine";

/**
 * Where the engine's sound goes, as the control window resolved it (`effects/audio-route.ts`): main applies it and
 * decides nothing. Both buses come in one `audioRoute:set`, so the sessions and the NDI® capture (LIVE's output only,
 * D6) never see one bus moved and the other not yet.
 */
let logged = "";
/** E2E only: every output the engine could use is answered with a name it has not («coreaudio/NOPE»), so what refuses
 *  it is the engine's own `audio-out` (`audio-outputs.spec.ts`). No computer has an output both sides name alike that
 *  mpv then cannot open. */
const UNOPENABLE = process.argv.includes("--unopenable-engine-outputs");

/** Always applied, even unchanged: the NDI sender re-arms a capture that failed when told its route again. */
export function setAudioRoute(route: AudioRoute): void {
  setEngineAudioDevices({ live: route.live, preview: route.preview });
  setNdiAudioRoute({ device: route.live, previewApart: route.previewApart });
  const line = `LIVE ${route.live ?? "default"}, PREVIEW ${route.preview ?? "default"}${route.previewApart ? " (apart)" : ""}`;
  if (line !== logged) console.info(`[audio] engine output: ${line}`);
  logged = line;
}

/** `matchEngineDevice` for each output, against the engine's own list. An engine that cannot choose ("none") is told
 *  apart from one that has not answered ("pending": a spare still starting, stopped, or replaced before it answered),
 *  which the control window asks again: taking one for the other would split a bus across two devices. */
export async function matchAudioOutputs(
  outputs: readonly { deviceId: string; label: string }[],
): Promise<EngineOutputNames> {
  const canChoose = () => engineAvailable() && (engineProtocol() ?? AUDIO_DEVICE_PROTO) >= AUDIO_DEVICE_PROTO;
  let list = await listAudioDevices();
  // A spare replaced before it answered (the app's card found at launch) leaves no answer: asked once more.
  if (list === null && canChoose()) list = await listAudioDevices();
  if (list) {
    return outputs.map((output) => {
      const name = matchEngineDevice(output, list);
      return UNOPENABLE && name !== null && name !== "auto" ? name.replace(/\/.*/s, "/NOPE") : name;
    });
  }
  return canChoose() ? "pending" : "none";
}
