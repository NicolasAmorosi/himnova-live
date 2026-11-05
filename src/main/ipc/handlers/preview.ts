import type { Handlers } from "../register";
import { IpcError } from "@shared/ipc/result";
import { engineAssetIdOfUrl, engineClipOfUrl, linkedAudioAssetIdOfUrl } from "@shared/urls";
import { seekPreviewVideo, setPreviewVideo } from "../../media/engine-sessions";

function invalid(message: string): IpcError {
  return new IpcError({ code: "INVALID_ARGUMENT", message });
}

export const previewHandlers: Pick<Handlers, "preview:setVideo" | "preview:seekVideo"> = {
  "preview:setVideo": (req, ev) => {
    if (
      req !== null &&
      (typeof req?.url !== "string" ||
        // A library file, or a deck's own music (embedded or linked) — never a path.
        (engineAssetIdOfUrl(req.url) === null &&
          engineClipOfUrl(req.url) === null &&
          linkedAudioAssetIdOfUrl(req.url) === null) ||
        typeof req.paused !== "boolean" ||
        !Number.isFinite(req.startAtSeconds) ||
        typeof req.volume !== "number" ||
        !(req.volume >= 0 && req.volume <= 1) ||
        typeof req.picture !== "boolean")
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
