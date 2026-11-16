import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { SlideModel } from "@shared/types/slide-model";
import { parsePresetDefinitions } from "./pptx/geometry";
import { readPptxDeck, type PptxDeck, type PptxResources } from "./pptx/reader";
import { parseTableStyles } from "./pptx/table-style";
import {
  containerKind,
  extractAudioParts,
  extractVideoParts,
  readPresentationMeta,
  type AudioRef,
  type ExtractedAudio,
  type ExtractedVideo,
  type PresentationMeta,
  type VideoRef,
} from "./pptx-metadata";
import { parseMsoShapes } from "./ppt/escher";
import { readPptModelDeck } from "./ppt/model-reader";
import type { PptResources } from "./ppt/reader";
import { readOdpModel } from "./odp/entry";

/**
 * The deck readers, off the main thread: a `.pptx`, a legacy `.ppt`/`.pps` the
 * picture reader (`ppt-binary.ts`, on main: ~1 ms) refused, and an `.odp`, each
 * into a `SlideModel` per slide. Reading a `.pptx` parses every slide's XML
 * twice (the model, then the timings and media), and a template whose map
 * slide is 22 MB of shapes took 11 s — on the thread that answers every IPC
 * call and serves `worship://`. Here it costs main nothing but the copy of the
 * result, which is why the layers come back as the JSON `deck_slides` stores.
 */
export type PptxRead = {
  width: number;
  height: number;
  slides: { hidden: boolean; layers: string }[];
  /** `null` when the timings and media couldn't be read: the slides still are. */
  meta: PresentationMeta | null;
};

/** The sound and video a deck embeds, copied out into its cache folder — here too, not on main: a
 *  350 MB clip held main for 0.25–0.6 s, and every frame of a media-engine video on air crosses main,
 *  so the projector froze (2026-11-10 review, agent6-01). */
export type PptxExtract = { file: string; audio: AudioRef[]; audioDir: string; video: VideoRef[]; videoDir: string };
export type PptxClips = { audio: ExtractedAudio[]; video: ExtractedVideo[] };

export type PptxRequest = { id: number; file: string; extract?: undefined } | { id: number; extract: PptxExtract };
export type PptxReply =
  | { id: number; read: PptxRead }
  | { id: number; clips: PptxClips }
  | { id: number; error: string };

type Resources = PptxResources & PptResources;
let resources: Resources | null = null;

/** By what the bytes are, never by the extension. */
function readModel(file: string, loaded: Resources): { deck: PptxDeck; meta: PresentationMeta | null } {
  switch (containerKind(file)) {
    case "ooxml": {
      const deck = readPptxDeck(file, loaded);
      let meta: PresentationMeta | null = null;
      try {
        meta = readPresentationMeta(file);
      } catch {
        // The model is what's drawn; a deck without timings still projects.
      }
      return { deck, meta };
    }
    case "binary":
      return readPptModelDeck(file, loaded);
    case "odf":
      return readOdpModel(file, loaded);
    default:
      throw new Error("not a presentation");
  }
}

/** A slide's model past this, as JSON, is kept as an empty, damaged slide. A real chart at Excel 2007's limit
 *  (32 000 points) is ~5.8 MB. */
export const MAX_SLIDE_LAYERS = 16 * 1024 * 1024;

/**
 * The JSON `deck_slides.layers` stores. A few KB of file can ask for hundreds of MB of model (a chart's `ptCount`,
 * an arc's sweep): that string crossed to main, was written to SQLite at once and parsed by every window
 * (2026-11-15 audit, S5). Past the cap, or past what a string can hold, the slide keeps its size and background,
 * and the control window says it is damaged.
 */
export function slideLayers(model: SlideModel): string {
  try {
    const json = JSON.stringify(model);
    if (json.length <= MAX_SLIDE_LAYERS) return json;
  } catch {
    // RangeError: longer than a string can be.
  }
  return JSON.stringify({ ...model, elements: [], damaged: true } satisfies SlideModel);
}

function read(file: string): PptxRead {
  // Loaded on the first deck, not at startup: most sessions never open one. `workerData` read here, not when the
  // module loads, so a test can import `slideLayers`.
  const { ooxmlDir } = workerData as { ooxmlDir: string };
  resources ??= {
    presets: parsePresetDefinitions(fs.readFileSync(path.join(ooxmlDir, "presetShapeDefinitions.xml"), "utf8")),
    tableStyles: parseTableStyles(fs.readFileSync(path.join(ooxmlDir, "tableStyles.xml"), "utf8")),
    // Office's built-in shapes, for a legacy deck (`ppt/escher.ts`).
    msoShapes: parseMsoShapes(fs.readFileSync(path.join(ooxmlDir, "mso-shapes.json"), "utf8")),
  };
  const { deck, meta } = readModel(file, resources);
  return {
    width: deck.width,
    height: deck.height,
    slides: deck.slides.map((slide) => ({ hidden: slide.hidden, layers: slideLayers(slide.model) })),
    meta,
  };
}

parentPort?.on("message", (request: PptxRequest) => {
  const { id } = request;
  let reply: PptxReply;
  try {
    if (request.extract) {
      const { audio, audioDir, file, video, videoDir } = request.extract;
      reply = { id, clips: { audio: extractAudioParts(file, audio, audioDir), video: extractVideoParts(file, video, videoDir) } };
    } else {
      reply = { id, read: read(request.file) };
    }
  } catch (error) {
    reply = { id, error: String(error) };
  }
  parentPort?.postMessage(reply);
});
