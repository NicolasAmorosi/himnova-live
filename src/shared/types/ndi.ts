/** The projector's picture as an NDI® source on the network (Settings ▸ Projection), sent by the media
 *  engine in its NDI mode (`native/engine/ndi.cpp`) from an offscreen copy of the projection
 *  (`main/ndi/ndi-output.ts`). Video only. The NDI runtime is the user's own: nothing of NDI ships. */

export const NDI_RESOLUTIONS = ["720p", "1080p"] as const;
export type NdiResolution = (typeof NDI_RESOLUTIONS)[number];
export const NDI_FRAME_RATES = [30, 60] as const;
export type NdiFrameRate = (typeof NDI_FRAME_RATES)[number];
/** Receivers show «COMPUTER (name)»; a long one is cut off in OBS's list anyway. */
export const NDI_NAME_MAX_LENGTH = 60;

export const NDI_SIZES: Record<NdiResolution, { width: number; height: number }> = {
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
};

/** Where the user gets the free runtime: the NDI SDK licence asks for a link to ndi.video next to every
 *  place NDI is used or chosen. */
export const NDI_RUNTIME_URL = "https://ndi.video/tools/";
/** The notice the NDI SDK licence asks for near NDI's first use and in «About». A legal line, kept in its
 *  own words in every language, like the GPL's identifier. */
export const NDI_TRADEMARK = "NDI® is a registered trademark of Vizrt NDI AB.";

/** `ndi-send`: the SDK refused to start a source · `ndi-gpu`: a frame could not be read from the GPU ·
 *  `ndi-exit`: the engine died (it is started again) · `ndi-engine-missing`: a build without the engine. */
export const NDI_ERROR_CODES = ["ndi-send", "ndi-gpu", "ndi-exit", "ndi-engine-missing"] as const;
export type NdiErrorCode = (typeof NDI_ERROR_CODES)[number];

/** What Settings shows next to the switch. */
export type NdiOutputStatus =
  | { state: "off" }
  | { state: "starting" }
  | { state: "sending"; receivers: number }
  | { state: "runtime-missing" }
  | { state: "error"; code: NdiErrorCode };
