import { shell } from "electron";
import { NDI_RUNTIME_URLS } from "@shared/types/ndi";
import type { Handlers } from "../register";
import { ndiOutputStatus } from "../../ndi/ndi-output";

export const ndiHandlers: Pick<Handlers, "ndi:getStatus" | "ndi:openRuntimePage"> = {
  "ndi:getStatus": () => ndiOutputStatus(),
  "ndi:openRuntimePage": () =>
    shell.openExternal(process.platform === "win32" || process.platform === "darwin" ? NDI_RUNTIME_URLS[process.platform] : NDI_RUNTIME_URLS.linux),
};
