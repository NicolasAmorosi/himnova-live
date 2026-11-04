import type { Handlers } from "../register";
import { IpcError } from "@shared/ipc/result";
import { engineAssetIdOfUrl } from "@shared/urls";
import { seekPreviewVideo, setPreviewVideo } from "../../media/engine-sessions";

function invalid(message: string): IpcError {
  return new IpcError({ code: "INVALID_ARGUMENT", message });
}

export const previewHandlers: Pick<Handlers, "preview:setVideo" | "preview:seekVideo"> = {
  "preview:setVideo": (req, ev) => {
    if (
      req !== null &&
      (typeof req?.url !== "string" ||
        engineAssetIdOfUrl(req.url) === null ||
        typeof req.paused !== "boolean" ||
        !Number.isFinite(req.startAtSeconds))
    ) {
      throw invalid("Invalid preview video.");
    }
    setPreviewVideo(req, ev.sender);
  },
  "preview:seekVideo": (req) => {
    if (!Number.isFinite(req?.seconds)) throw invalid("Invalid position.");
    seekPreviewVideo(req.seconds);
  },
};
