import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { SlideModel } from "@shared/types/slide-model";
import { decodeEmbeddedFont } from "./pptx/embedded-font";
import { parsePresetDefinitions } from "./pptx/geometry";
import { metafileToSvg } from "./pptx/metafile";
import { readPptxDeck, type PptxDeck, type PptxResources } from "./pptx/reader";
import { parseTableStyles } from "./pptx/table-style";
import {
  containerKind,
  extractAudioParts,
  extractVideoParts,
  readPresentationMeta,
  type AudioRef,
  type ContainerKind,
  type ExtractedAudio,
  type ExtractedVideo,
  type PresentationMeta,
  type VideoRef,
} from "./pptx-metadata";
import { parseMsoShapes } from "./ppt/escher";
import { readPptModelDeck } from "./ppt/model-reader";
import { readBinaryPart } from "./ppt/parts";
import type { PptResources } from "./ppt/reader";
import { readOdpModel } from "./odp/entry";
import { readBinaryDeck, sniffUnreadableDeck, type UnreadableDeckReason } from "./ppt-binary";
import { readZipEntries } from "./zip-reader";

/**
 * The deck readers, off the main thread: a `.pptx`, a legacy `.ppt`/`.pps` the
 * picture reader refused, and an `.odp`, each into a `SlideModel` per slide.
 * Another thread of this same module serves the hymnal (`pptx-deck.ts`): what a
 * file is, the picture reader (`ppt-binary.ts`, ~1 ms a deck) and why a deck
 * won't open, so main no longer sniffs or reads a deck's file to open it (a share
 * that stopped answering held main 21 s on Windows; 2026-11-22 audit, RM1). A third one serves a model deck's
 * pictures, metafiles and fonts (`readDeckPart`). Reading a `.pptx` parses every slide's XML
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

/** A legacy deck read as pictures, or why not (`readBinaryDeck`). */
export type NativeRead = ReturnType<typeof readBinaryDeck>;

export type PptxRequest =
  | { id: number; file: string }
  | { id: number; extract: PptxExtract }
  /** What `sniff` is by its bytes, and read as pictures too when `native` and it is a legacy binary. */
  | { id: number; sniff: string; native: boolean }
  | { id: number; unreadable: string }
  | { id: number; deckPart: { file: string; kind: "part" | "font"; part: string } };
export type PptxReply =
  | { id: number; read: PptxRead }
  | { id: number; clips: PptxClips }
  | { id: number; kind: ContainerKind; native: NativeRead | undefined }
  | { id: number; reason: UnreadableDeckReason }
  | { id: number; deckPart: DeckPart }
  | { id: number; error: string }
  /** Still reading `id`: one per slide, which restarts the queue's timer (`deck-queue.ts`). */
  | { id: number; alive: true };

type Resources = PptxResources & PptResources;
let resources: Resources | null = null;

/** The request in hand, and the beat the readers send once per slide: a deck is stopped only after the queue's
 *  limit without one, so a long deck on a slow PC is read to the end (2026-11-15 audit, S4, review). */
let reading = 0;
const beat = (): void => parentPort?.postMessage({ id: reading, alive: true } satisfies PptxReply);

/** By what the bytes are, never by the extension. */
function readModel(file: string, loaded: Resources): { deck: PptxDeck; meta: PresentationMeta | null } {
  switch (containerKind(file)) {
    case "ooxml": {
      const deck = readPptxDeck(file, loaded);
      // The timings parse every slide again.
      beat();
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
export function slideLayers(model: SlideModel, room = MAX_SLIDE_LAYERS): string {
  try {
    const json = JSON.stringify(model);
    if (json.length <= Math.min(room, MAX_SLIDE_LAYERS)) return json;
  } catch {
    // RangeError: longer than a string can be.
  }
  return JSON.stringify({ ...model, elements: [], damaged: true } satisfies SlideModel);
}

/** A whole deck's models, as JSON, past which the slides left are kept empty and damaged too. */
export const MAX_DECK_LAYERS = 128 * 1024 * 1024;

/** Every slide's `slideLayers`, against one running total: the cap per slide still let a deck of a hundred slides
 *  of 15 MB each hand main 1.5 GB (2026-11-15 audit, S5, review). The budget is a parameter for the test. */
export function deckLayers(models: SlideModel[], budget = MAX_DECK_LAYERS): string[] {
  let room = budget;
  return models.map((model) => {
    const layers = slideLayers(model, room);
    room -= layers.length;
    return layers;
  });
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
    onSlide: beat,
  };
  const { deck, meta } = readModel(file, resources);
  beat();
  const layers = deckLayers(deck.slides.map((slide) => slide.model));
  return {
    width: deck.width,
    height: deck.height,
    slides: deck.slides.map((slide, at) => ({ hidden: slide.hidden, layers: layers[at]! })),
    meta,
  };
}

const PART_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg", gif: "image/gif", bmp: "image/bmp",
  svg: "image/svg+xml", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff", ico: "image/x-icon",
};

/** A part as served: its bytes and type, or why not (404 not in the file, 415 won't convert). */
export type DeckPart = { body: Uint8Array<ArrayBuffer>; type: string } | 404 | 415;

/**
 * A part of a model deck's package as `worship://deck/<id>/part|font/` serves it, read and converted from
 * `sourcePath`: a picture as is, a metafile (EMF/WMF, which Chromium can't decode) as the SVG `metafileToSvg`
 * makes of it, a font as the TrueType `decodeEmbeddedFont` rebuilds. Here, not on main: an EMF of 156 bytes
 * held main a minute and then took the app down, and a real one of 24 MB is a turn of 200 ms (2026-11-22
 * audit, SE1). The body is its own buffer, so it crosses to main moved, not copied.
 */
export function readDeckPart(sourcePath: string, kind: "part" | "font", part: string): DeckPart {
  // A legacy binary's parts are ranges of its OLE streams (`ppt/parts.ts`);
  // a `.pptx`'s and an `.odp`'s, zip entries.
  const raw =
    containerKind(sourcePath) === "binary"
      ? (readBinaryPart(sourcePath, part) ?? undefined)
      : readZipEntries(sourcePath, (name) => name === part)[part];
  if (!raw) return 404;
  const ext = part.slice(part.lastIndexOf(".") + 1).toLowerCase();
  let body: Uint8Array | string | null = raw;
  let type = PART_TYPES[ext] ?? "application/octet-stream";
  if (kind === "font") {
    body = decodeEmbeddedFont(raw);
    type = "font/ttf";
  } else if (ext === "emf" || ext === "wmf" || ext === "emz" || ext === "wmz") {
    body = metafileToSvg(raw, ext.startsWith("w") ? "wmf" : "emf");
    type = "image/svg+xml";
  }
  if (body === null) return 415;
  return { body: typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body), type };
}

parentPort?.on("message", (request: PptxRequest) => {
  const { id } = request;
  reading = id;
  let reply: PptxReply;
  try {
    if ("extract" in request) {
      const { audio, audioDir, file, video, videoDir } = request.extract;
      reply = {
        id,
        clips: { audio: extractAudioParts(file, audio, audioDir, beat), video: extractVideoParts(file, video, videoDir, beat) },
      };
    } else if ("sniff" in request) {
      const kind = containerKind(request.sniff);
      reply = { id, kind, native: request.native && kind === "binary" ? readBinaryDeck(request.sniff) : undefined };
    } else if ("unreadable" in request) {
      reply = { id, reason: sniffUnreadableDeck(request.unreadable) };
    } else if ("deckPart" in request) {
      const { file, kind, part } = request.deckPart;
      reply = { id, deckPart: readDeckPart(file, kind, part) };
    } else {
      reply = { id, read: read(request.file) };
    }
  } catch (error) {
    reply = { id, error: String(error) };
  }
  const moved = "deckPart" in reply && typeof reply.deckPart === "object" ? [reply.deckPart.body.buffer] : [];
  parentPort?.postMessage(reply, moved);
});
