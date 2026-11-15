import type { Handlers } from "../register";
import { IpcError } from "@shared/ipc/result";
import { matchAudioOutputs, setAudioRoute } from "../../media/audio-route";

const MAX_NAME = 512;
/** A name that goes to the engine on a line of its own. */
const isName = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_NAME && !/[\r\n]/.test(v);

function invalid(message: string): IpcError {
  return new IpcError({ code: "INVALID_ARGUMENT", message });
}

export const audioRouteHandlers: Pick<Handlers, "audioRoute:matchOutputs" | "audioRoute:set"> = {
  "audioRoute:matchOutputs": (req) => {
    if (!Array.isArray(req?.outputs) || req.outputs.length > 16 || !req.outputs.every((o) => isName(o?.deviceId) && isName(o?.label))) {
      throw invalid("Invalid outputs.");
    }
    return matchAudioOutputs(req.outputs);
  },
  "audioRoute:set": (req) => {
    if ((req?.preview !== null && !isName(req?.preview)) || typeof req?.previewApart !== "boolean") throw invalid("Invalid route.");
    setAudioRoute({ preview: req.preview, previewApart: req.previewApart });
  },
};
