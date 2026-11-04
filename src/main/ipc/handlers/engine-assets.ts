import type { Handlers } from "../register";
import { IpcError } from "@shared/ipc/result";
import { listEngineAssets, probedDuration, setDecoderSupport } from "../../media/engine-assets";

export const engineAssetsHandlers: Pick<Handlers, "engine:assets" | "engine:reportDecoders" | "engine:duration"> = {
  "engine:assets": () => listEngineAssets(),
  "engine:reportDecoders": (req) => {
    if (typeof req?.hevc !== "boolean" || typeof req.hevcMain10 !== "boolean") {
      throw new IpcError({ code: "INVALID_ARGUMENT", message: "Invalid decoder support." });
    }
    setDecoderSupport({ hevc: req.hevc, hevcMain10: req.hevcMain10 });
  },
  "engine:duration": (req) => {
    if (!Number.isInteger(req?.id)) throw new IpcError({ code: "INVALID_ARGUMENT", message: "Invalid id." });
    return probedDuration(req.id);
  },
};
