import { shell } from "electron";
import { NDI_RUNTIME_URL } from "@shared/types/ndi";
import type { Handlers } from "../register";
import { ndiOutputStatus } from "../../ndi/ndi-output";

export const ndiHandlers: Pick<Handlers, "ndi:getStatus" | "ndi:openRuntimePage"> = {
  "ndi:getStatus": () => ndiOutputStatus(),
  "ndi:openRuntimePage": () => shell.openExternal(NDI_RUNTIME_URL),
};
