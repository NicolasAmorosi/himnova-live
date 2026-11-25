import type { Handlers } from "../register";
import { IpcError } from "@shared/ipc/result";
import { broadcast } from "../../services/broadcast";
import { matchAudioOutputs, setAudioRoute } from "../../media/audio-route";
import { systemDefaultOutputLabel } from "../../media/system-default-output";

const MAX_NAME = 512;
/** A name that goes to the engine on a line of its own. */
const isName = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_NAME && !/[\r\n]/.test(v);
const isDevice = (v: unknown): v is string | null => v === null || isName(v);

function invalid(message: string): IpcError {
  return new IpcError({ code: "INVALID_ARGUMENT", message });
}

type AudioRouteChannel = "audioRoute:matchOutputs" | "audioRoute:set" | "audioRoute:sinkFailed" | "audioRoute:systemDefault";

export const audioRouteHandlers: Pick<Handlers, AudioRouteChannel> = {
  "audioRoute:matchOutputs": (req) => {
    if (!Array.isArray(req?.outputs) || req.outputs.length > 16 || !req.outputs.every((o) => isName(o?.deviceId) && isName(o?.label))) {
      throw invalid("Invalid outputs.");
    }
    return matchAudioOutputs(req.outputs);
  },
  "audioRoute:set": (req) => {
    if (!isDevice(req?.live) || !isDevice(req?.preview) || typeof req?.previewApart !== "boolean") {
      throw invalid("Invalid route.");
    }
    setAudioRoute({ live: req.live, preview: req.preview, previewApart: req.previewApart });
  },
  // The window describes its own elements; the control window decides (`effects/audio-route.ts`).
  "audioRoute:sinkFailed": (req) => {
    if (!isName(req?.sinkId)) throw invalid("Invalid output.");
    broadcast("audio-sink-failed", { sinkId: req.sinkId });
  },
  "audioRoute:systemDefault": async () => ({ label: await systemDefaultOutputLabel() }),
};
