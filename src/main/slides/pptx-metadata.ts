import fs from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { SLIDES_MIN_ADVANCE_MS } from "@shared/constants";
import type { SlideRect } from "@shared/types/deck";
import { SLIDE_TRANSITION_SPEED_MS, type SlideTransition } from "@shared/types/transition";
import { readBinaryPart } from "./ppt/parts";
import { readZipEntries } from "./zip-reader";

export type ContainerKind = "ooxml" | "binary" | "odf" | "pdf" | "unknown";

export type SlideTiming = {
  /** 1-based, in presentation order. */
  slideIndex: number;
  partName: string;
  autoAdvanceMs: number | null;
  advanceOnClick: boolean;
  transition: SlideTransition | null;
  hidden: boolean;
  title: string | null;
  notes: string | null;
};

export type AudioRef = {
  partName: string;
  /** 1-based, in PRESENTATION order, hidden slides included — like
   *  `VideoRef.slideIndex`, mapped onto the deck's slides by the caller. */
  startSlideIndex: number;
  origin: "embedded" | "transition";
  loop: boolean;
  volume: number | null;
  /** How many slides it plays across, its own included: PowerPoint's «stop
   *  playing after N slides» (`p:cMediaNode/@numSld`), 1 when the file doesn't
   *  say — «on this slide». «Play across slides» writes 999. */
  slides: number;
};

/** A video `p:pic` we can actually use: its bytes are inside this archive and
 *  it says where on the slide it goes. */
export type VideoRef = {
  partName: string;
  /** 1-based, in PRESENTATION order — the same numbering `SlideTiming` uses,
   *  hidden slides included. Mapping it onto rendered pages is the caller's
   *  job (`deck-service.ts`), because only the caller knows how many pages
   *  came out. */
  slideIndex: number;
  /** Fractions of the slide box, 0..1. */
  rect: SlideRect;
  loop: boolean;
  /** 0..1, or null when the file doesn't say. */
  volume: number | null;
};

export type PresentationMeta = {
  slideCount: number;
  slideSizeEmu: { cx: number; cy: number } | null;
  slides: SlideTiming[];
  audio: AudioRef[];
  video: VideoRef[];
  /** Video parts found but NOT usable — an external/linked file whose bytes
   *  were never in the archive, or a `p:pic` with no geometry of its own
   *  (it inherits a layout placeholder's, which this parser does not resolve;
   *  guessing would put the video somewhere it is not). Recorded rather than
   *  dropped so the log can say how often the unusable cases actually occur. */
  skippedVideoParts: string[];
};

export type ExtractedAudio = AudioRef & {
  file: string;
  ext: string;
  bytes: number;
  playable: boolean;
};

export type ExtractedVideo = VideoRef & {
  file: string;
  ext: string;
  bytes: number;
  playable: boolean;
};

/** Chromium can't decode these, so mark them unplayable rather than silently
 *  producing an <audio> element that never makes a sound — until
 *  `media/deck-clips.ts` converts the WMA (MIDI stays unplayable). */
const UNPLAYABLE_AUDIO_EXT = new Set(["wma", "mid", "midi"]);
/** Also used by `linked-audio.ts` to recognize a sibling/hinted audio file —
 *  the same "is this audio" question, just asked about a file on disk instead
 *  of a zip entry. */
export const AUDIO_EXT = new Set([
  "mp3",
  "m4a",
  "aac",
  "wav",
  "ogg",
  "oga",
  "opus",
  "wma",
  "mid",
  "midi",
]);
const VIDEO_EXT = new Set([
  ...["mp4", "m4v", "mov", "wmv", "avi", "mkv", "webm"],
  ...["mpg", "mpeg", "m2v", "vob", "asf", "flv", "3gp", "ogv", "ts"],
]);
/** What Chromium will probably decode. The rest are extracted and marked
 *  unplayable rather than mounted as a `<video>` that shows nothing: the slide
 *  underneath already draws the clip's poster frame, so a deck with a `.wmv`
 *  in it still looks right while `media/deck-clips.ts` hands it to the media
 *  engine — which it decides by reading the streams, so this flag is only the
 *  starting guess. Same treatment `UNPLAYABLE_AUDIO_EXT` gives a `.wma`. */
const PLAYABLE_VIDEO_EXT = new Set(["mp4", "m4v", "mov", "webm"]);

/** Repeated elements that must stay arrays even when a deck happens to have
 *  exactly one of them — otherwise a one-slide deck parses as an object and
 *  every downstream `.map` silently sees nothing. */
const ALWAYS_ARRAY = ["p:sldIdLst.p:sldId", "Relationships.Relationship", "p:spTree.p:pic"];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: false,
  parseAttributeValue: false,
  isArray: (_name, jpath) => {
    const p = String(jpath);
    return ALWAYS_ARRAY.some((suffix) => p.endsWith(suffix));
  },
});

type XmlNode = Record<string, unknown>;

function asNode(value: unknown): XmlNode | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as XmlNode)
    : undefined;
}

function asNodes(value: unknown): XmlNode[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.filter((v): v is XmlNode => asNode(v) !== undefined);
  const node = asNode(value);
  return node ? [node] : [];
}

function attr(node: XmlNode | undefined, name: string): string | undefined {
  const value = node?.[name];
  return typeof value === "string" ? value : undefined;
}

export function containerKind(filePath: string): ContainerKind {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    // OLE2 compound file (legacy .ppt/.pps)
    if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
      return "binary";
    }
    // "%PDF" — the one deck that is rasterized rather than read into a model.
    // Sniffed rather than taken from the extension for the same reason the
    // others are: the extension is what the library filters on, the magic is
    // what the readers trust.
    if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) {
      return "pdf";
    }
    if (head[0] === 0x50 && head[1] === 0x4b) {
      // A zip: OOXML or ODF. Distinguish by extension, cheap and reliable here.
      return path.extname(filePath).toLowerCase() === ".odp" ? "odf" : "ooxml";
    }
    return "unknown";
  } catch {
    return "unknown";
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Reads only the entries we actually parse, straight out of the archive by
 *  offset — see `zip-reader.ts`. Filtering an `unzipSync` over the whole file
 *  (what this used to do) skipped the inflate but still paid for a
 *  `readFileSync` of every media byte in the deck, synchronously, on the
 *  thread that serves the projection window. */
function readEntries(filePath: string, wanted: (name: string) => boolean): Record<string, Uint8Array> {
  return readZipEntries(filePath, wanted);
}

/** A deck's media parts by name: zip entries of a `.pptx` or `.odp`, or the
 *  ranges of a legacy binary's streams its reader names (`ppt/parts.ts`). */
function readParts(filePath: string, names: Set<string>): Record<string, Uint8Array> {
  if (containerKind(filePath) !== "binary") return readEntries(filePath, (name) => names.has(name));
  const out: Record<string, Uint8Array> = {};
  for (const name of names) {
    const bytes = readBinaryPart(filePath, name);
    if (bytes) out[name] = bytes;
  }
  return out;
}

function decode(entry: Uint8Array | undefined): string | null {
  if (!entry) return null;
  return Buffer.from(entry).toString("utf8");
}

type Rels = Map<string, string>;

/**
 * Relationship targets are relative to the part's own directory.
 *
 * Every entry in the returned map is a part INSIDE this archive. A rel marked
 * `TargetMode="External"` points at the filesystem — typically an absolute
 * Windows path from whichever machine authored the deck — and joining that
 * onto `baseDir` produces a plausible-looking part name that names nothing:
 * `ppt/slides/C:/Users/.../clip.mp4`. That was harmless while the value was
 * only ever logged, and stops being harmless the moment anything tries to
 * read the entry. The file it names is long gone from any machine the deck
 * reaches anyway, so an external rel is no rel at all here.
 */
function parseRels(xml: string | null, baseDir: string): Rels {
  const map: Rels = new Map();
  if (!xml) return map;
  const doc = asNode(parser.parse(xml));
  const root = asNode(doc?.["Relationships"]);
  for (const rel of asNodes(root?.["Relationship"])) {
    const id = attr(rel, "@Id");
    const target = attr(rel, "@Target");
    if (!id || !target) continue;
    if (attr(rel, "@TargetMode") === "External") continue;
    if (/^https?:/i.test(target)) continue;
    map.set(id, path.posix.normalize(path.posix.join(baseDir, target)));
  }
  return map;
}

/**
 * PowerPoint 2010+ wraps the transition in
 * `mc:AlternateContent/mc:Choice[@Requires="p14"]`, keeping a legacy copy in
 * `mc:Fallback`. A bare `p:transition` also occurs. Checking only the bare
 * element is the single most common way to silently read no timings at all.
 */
function findTransition(slide: XmlNode): XmlNode | undefined {
  const alt = asNode(slide["mc:AlternateContent"]);
  const fromChoice = asNode(asNode(alt?.["mc:Choice"])?.["p:transition"]);
  if (fromChoice) return fromChoice;

  const fromFallback = asNode(asNode(alt?.["mc:Fallback"])?.["p:transition"]);
  if (fromFallback) return fromFallback;

  return asNode(slide["p:transition"]);
}

/** Children of `p:transition` that are not the effect itself. */
const TRANSITION_EXTRAS = new Set(["p:sndAc", "p:extLst"]);

/** How the slide enters, from its `p:transition`: `p:fade` (through black
 *  with `thruBlk`) and `p:randomBar` are drawn as themselves, a cut is no
 *  transition, and any other effect is a crossfade of its own length
 *  (`SlideTransition`). The length is `p14:dur` when PowerPoint wrote one,
 *  else the `spd` word — `fast` when absent, the schema's default. */
function ooxmlTransition(transition: XmlNode | undefined): SlideTransition | null {
  if (!transition) return null;
  const effect = Object.keys(transition).find(
    (key) => !key.startsWith("@") && !key.startsWith("#") && !TRANSITION_EXTRAS.has(key),
  );
  if (!effect || effect === "p:cut") return null;

  const durAttr = attr(transition, "@p14:dur") ?? attr(transition, "@dur");
  const speed = attr(transition, "@spd");
  const durationMs =
    durAttr !== undefined && Number.isFinite(Number(durAttr)) && Number(durAttr) > 0
      ? Number(durAttr)
      : speed === "slow"
        ? SLIDE_TRANSITION_SPEED_MS.slow
        : speed === "med"
          ? SLIDE_TRANSITION_SPEED_MS.medium
          : SLIDE_TRANSITION_SPEED_MS.fast;

  const options = asNode(transition[effect]);
  if (effect === "p:fade") {
    const thruBlk = attr(options, "@thruBlk");
    return { style: thruBlk === "1" || thruBlk === "true" ? "fade-through-black" : "crossfade", durationMs };
  }
  if (effect === "p:randomBar") {
    return { style: attr(options, "@dir") === "vert" ? "random-bars-vertical" : "random-bars-horizontal", durationMs };
  }
  return { style: "crossfade", durationMs };
}

function collectText(node: unknown, out: string[]): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return;
  }
  if (typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "a:t") {
      if (typeof value === "string") out.push(value);
      else if (Array.isArray(value)) for (const v of value) if (typeof v === "string") out.push(v);
    } else if (typeof value === "object") {
      collectText(value, out);
    }
  }
}

function isIndefinite(node: XmlNode): boolean {
  return attr(asNode(node["p:cTn"]), "@repeatCount") === "indefinite";
}

/** Walks p:timing looking for media nodes, which is where loop/volume live. */
function collectMediaNodes(node: unknown, out: XmlNode[]): void {
  if (node === null || node === undefined || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) collectMediaNodes(child, out);
    return;
  }
  for (const [key, value] of Object.entries(node as XmlNode)) {
    if (key === "p:cMediaNode") {
      out.push(...asNodes(value));
    } else if (typeof value === "object") {
      collectMediaNodes(value, out);
    }
  }
}

/** Which shape a media node is about: `p:cMediaNode/p:tgtEl/p:spTgt/@spid`,
 *  matching a `p:pic`'s own `p:cNvPr/@id`. Undefined for a node that doesn't
 *  say. */
function mediaNodeTargetId(node: XmlNode): string | undefined {
  return attr(asNode(asNode(node["p:tgtEl"])?.["p:spTgt"]), "@spid");
}

function mediaNodeLoops(node: XmlNode): boolean {
  const loop = attr(node, "@loop");
  return loop === "1" || loop === "true" || isIndefinite(node);
}

export type AudioPlacement = {
  /** 1-based, among the slides the deck shows. */
  startSlideIndex: number;
  /** The last slide it plays on, or `null`: to the end of the deck. */
  stopSlideIndex: number | null;
  /** `deck` iff it plays to the end — the music `DeckDTO.soundtrack` can be. */
  scope: "deck" | "slide";
};

/**
 * Where a sound plays among the deck's slides, `visible` being the OOXML index
 * of each slide the deck shows, in order — the hidden ones skipped, as the
 * show skips them, and the `numSld` count with them. `null` for a sound on a
 * hidden slide, which PowerPoint never plays. `visible === null` (the slides
 * and the file don't line up) keeps it as every sound was before its place
 * was read: the deck's music, from the first slide.
 */
export function placeAudio(ref: AudioRef, visible: readonly number[] | null): AudioPlacement | null {
  if (!visible) return { startSlideIndex: 1, stopSlideIndex: null, scope: "deck" };
  const start = visible.indexOf(ref.startSlideIndex) + 1;
  if (start === 0) return null;
  const stop = start + ref.slides - 1;
  return stop >= visible.length
    ? { startSlideIndex: start, stopSlideIndex: null, scope: "deck" }
    : { startSlideIndex: start, stopSlideIndex: stop, scope: "slide" };
}

/** `@numSld`: how many slides the media plays across, 1 when absent. */
function mediaNodeSlides(node: XmlNode): number {
  const raw = Number(attr(node, "@numSld"));
  return Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

/** `@vol` is in thousandths of a percent (80000 = 80%). */
function mediaNodeVolume(node: XmlNode): number | null {
  const raw = attr(node, "@vol");
  return raw !== undefined && Number.isFinite(Number(raw)) ? Number(raw) / 100000 : null;
}

/**
 * A `p:pic`'s own rectangle, as fractions of the slide.
 *
 * `null` when the shape carries no `a:xfrm` of its own: it then inherits the
 * geometry of a layout placeholder, which this parser does not resolve. A
 * default (the whole slide, say) would be a guess that puts a video somewhere
 * it demonstrably is not — and the rasterized slide already shows the poster
 * frame in the right place, so being absent costs a still picture while being
 * wrong costs a video pasted over the middle of the sermon.
 */
function picRect(pic: XmlNode, slideSizeEmu: { cx: number; cy: number } | null): SlideRect | null {
  if (!slideSizeEmu || slideSizeEmu.cx <= 0 || slideSizeEmu.cy <= 0) return null;
  const xfrm = asNode(asNode(pic["p:spPr"])?.["a:xfrm"]);
  const off = asNode(xfrm?.["a:off"]);
  const ext = asNode(xfrm?.["a:ext"]);
  const x = Number(attr(off, "@x"));
  const y = Number(attr(off, "@y"));
  const cx = Number(attr(ext, "@cx"));
  const cy = Number(attr(ext, "@cy"));
  if (![x, y, cx, cy].every((value) => Number.isFinite(value))) return null;
  if (cx <= 0 || cy <= 0) return null;
  return {
    x: x / slideSizeEmu.cx,
    y: y / slideSizeEmu.cy,
    width: cx / slideSizeEmu.cx,
    height: cy / slideSizeEmu.cy,
  };
}

/**
 * The `r:embed` of the `p14:media` element PowerPoint 2010+ puts in a `p:pic`'s
 * `p:extLst`, alongside the legacy `a:videoFile`. A fallback for a file that
 * carries the extension but no usable `a:videoFile` rel — searched by walking
 * the shape rather than by path, because the extension sits under an
 * `mc:AlternateContent`/`p:extLst` nesting that varies by producer.
 */
function p14MediaRelId(node: unknown): string | undefined {
  if (node === null || node === undefined || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = p14MediaRelId(child);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(node as XmlNode)) {
    if (key === "p14:media") {
      const rid = asNodes(value)
        .map((media) => attr(media, "@r:embed") ?? attr(media, "@r:link"))
        .find((id) => id !== undefined);
      if (rid) return rid;
    } else if (typeof value === "object") {
      const found = p14MediaRelId(value);
      if (found) return found;
    }
  }
  return undefined;
}

export function readPresentationMeta(filePath: string): PresentationMeta {
  const entries = readEntries(
    filePath,
    (name) =>
      name === "ppt/presentation.xml" ||
      name === "ppt/_rels/presentation.xml.rels" ||
      (name.startsWith("ppt/slides/") && name.endsWith(".xml")) ||
      (name.startsWith("ppt/slides/_rels/") && name.endsWith(".rels")) ||
      (name.startsWith("ppt/notesSlides/") && name.endsWith(".xml")),
  );

  const presentationXml = decode(entries["ppt/presentation.xml"]);
  if (!presentationXml) {
    throw new Error("ppt/presentation.xml missing — not a presentation");
  }

  const presentation = asNode(parser.parse(presentationXml));
  const root = asNode(presentation?.["p:presentation"]);

  const sldSz = asNode(root?.["p:sldSz"]);
  const cx = attr(sldSz, "@cx");
  const cy = attr(sldSz, "@cy");
  const slideSizeEmu = cx && cy ? { cx: Number(cx), cy: Number(cy) } : null;

  const presentationRels = parseRels(decode(entries["ppt/_rels/presentation.xml.rels"]), "ppt");

  // p:sldIdLst is the PRESENTATION order. slide1.xml/slide2.xml is the creation
  // order and diverges the moment someone reorders — using it would desync
  // every timing from its slide.
  const sldIds = asNodes(asNode(root?.["p:sldIdLst"])?.["p:sldId"]);

  const slides: SlideTiming[] = [];
  const audio: AudioRef[] = [];
  const video: VideoRef[] = [];
  const skippedVideoParts: string[] = [];

  sldIds.forEach((sldId, position) => {
    const rId = attr(sldId, "@r:id");
    const partName = rId ? presentationRels.get(rId) : undefined;
    if (!partName) return;

    const slideXml = decode(entries[partName]);
    if (!slideXml) return;

    const slideIndex = position + 1;
    const sld = asNode(asNode(parser.parse(slideXml))?.["p:sld"]) ?? {};

    const slideDir = path.posix.dirname(partName);
    const relsName = path.posix.join(slideDir, "_rels", `${path.posix.basename(partName)}.rels`);
    const slideRels = parseRels(decode(entries[relsName]), slideDir);

    // @show absent or "1" = visible. Recorded, not dropped: the timings are
    // aligned with the slides drawn, which leave hidden ones out, and indices
    // drift if they are not counted.
    const showAttr = attr(sld, "@show");
    const hidden = showAttr === "0" || showAttr === "false";

    const transition = findTransition(sld);
    const advTm = attr(transition, "@advTm");
    const rawAdvance = advTm !== undefined ? Number(advTm) : NaN;
    const autoAdvanceMs = Number.isFinite(rawAdvance)
      ? Math.max(SLIDES_MIN_ADVANCE_MS, rawAdvance)
      : null;

    const advClick = attr(transition, "@advClick");
    const advanceOnClick = !(advClick === "0" || advClick === "false");


    const cSld = asNode(sld["p:cSld"]);
    const title = attr(cSld, "@name") ?? null;

    // Speaker notes: cheap to grab and genuinely useful to an operator.
    let notes: string | null = null;
    for (const target of slideRels.values()) {
      if (!target.startsWith("ppt/notesSlides/")) continue;
      const notesXml = decode(entries[target]);
      if (!notesXml) continue;
      const chunks: string[] = [];
      collectText(parser.parse(notesXml), chunks);
      const joined = chunks.join(" ").trim();
      if (joined) notes = joined;
      break;
    }

    // Media playback semantics live in p:timing.
    const mediaNodes: XmlNode[] = [];
    collectMediaNodes(sld["p:timing"], mediaNodes);
    // Slide-wide aggregate: whatever ANY media node on this slide says — the
    // fallback for a shape no node names.
    const anyLoop = mediaNodes.some(mediaNodeLoops);
    const volume = mediaNodes.map(mediaNodeVolume).find((v) => v !== null) ?? null;
    /** The node that is actually about one shape. Video asks by id rather than
     *  taking the slide-wide aggregate above: a slide with narration AND a clip
     *  has two media nodes, and handing the video the narration's level is a
     *  silent clip (or a loud one) with nothing to point at. Falls back to the
     *  aggregate when nothing declares a target, which is the single-media
     *  case the aggregate was always right about. */
    const mediaNodeFor = (shapeId: string | undefined): XmlNode | undefined =>
      shapeId === undefined
        ? undefined
        : mediaNodes.find((node) => mediaNodeTargetId(node) === shapeId);

    // Slide-placed audio (p:pic with an a:audioFile) and transition sounds.
    const spTree = asNode(cSld?.["p:spTree"]);
    for (const pic of asNodes(spTree?.["p:pic"])) {
      const nvPr = asNode(asNode(pic["p:nvPicPr"])?.["p:nvPr"]);
      const audioFile = asNode(nvPr?.["a:audioFile"]);
      const videoFile = asNode(nvPr?.["a:videoFile"]);

      if (videoFile) {
        // `@r:link` first, and it is NOT the external case: PowerPoint files an
        // embedded media part under a `video` relationship addressed as a link,
        // and puts a second `media` relationship in a `p14:media` extension.
        // A genuinely external target never reaches here at all — `parseRels`
        // drops it, so `slideRels.get` simply misses.
        const rid =
          attr(videoFile, "@r:link") ?? attr(videoFile, "@r:embed") ?? p14MediaRelId(pic);
        const target = rid ? slideRels.get(rid) : undefined;
        if (!target) {
          if (rid) skippedVideoParts.push(`${partName}#${rid} (external)`);
          continue;
        }
        const rect = picRect(pic, slideSizeEmu);
        if (!rect) {
          skippedVideoParts.push(`${target} (no geometry of its own)`);
          continue;
        }
        const node = mediaNodeFor(attr(asNode(asNode(pic["p:nvPicPr"])?.["p:cNvPr"]), "@id"));
        video.push({
          partName: target,
          slideIndex,
          rect,
          loop: node ? mediaNodeLoops(node) : anyLoop,
          volume: node ? mediaNodeVolume(node) : volume,
        });
        continue;
      }
      if (!audioFile) continue;

      const rid = attr(audioFile, "@r:link") ?? attr(audioFile, "@r:embed");
      const target = rid ? slideRels.get(rid) : undefined;
      if (!target) continue;

      // Asked by id, as for video: a slide with two sounds has two nodes.
      const node = mediaNodeFor(attr(asNode(asNode(pic["p:nvPicPr"])?.["p:cNvPr"]), "@id"));
      audio.push({
        partName: target,
        startSlideIndex: slideIndex,
        origin: "embedded",
        loop: node ? mediaNodeLoops(node) : anyLoop,
        volume: node ? mediaNodeVolume(node) : volume,
        slides: node ? mediaNodeSlides(node) : 1,
      });
    }

    const stSnd = asNode(asNode(transition?.["p:sndAc"])?.["p:stSnd"]);
    const snd = asNode(stSnd?.["p:snd"]);
    if (snd) {
      const rid = attr(snd, "@r:embed") ?? attr(snd, "@r:link");
      const target = rid ? slideRels.get(rid) : undefined;
      if (target) {
        audio.push({
          partName: target,
          startSlideIndex: slideIndex,
          origin: "transition",
          loop: attr(stSnd, "@loop") === "1",
          volume: null,
          slides: 1,
        });
      }
    }

    slides.push({
      slideIndex,
      partName,
      autoAdvanceMs,
      advanceOnClick,
      transition: ooxmlTransition(transition),
      hidden,
      title,
      notes,
    });
  });

  return { slideCount: slides.length, slideSizeEmu, slides, audio, video, skippedVideoParts };
}

/**
 * Writes each referenced media part into `destDir`. Output filenames are
 * generated (`1.mp3`, `2.wav`, …) and NEVER derived from the zip entry name —
 * a hostile or merely odd .pptx can carry `../` in a part name.
 */
export function extractAudioParts(
  filePath: string,
  refs: AudioRef[],
  destDir: string,
): ExtractedAudio[] {
  if (refs.length === 0) return [];

  const entries = readParts(filePath, new Set(refs.map((ref) => ref.partName)));

  fs.mkdirSync(destDir, { recursive: true });

  const extracted: ExtractedAudio[] = [];
  const seen = new Map<string, ExtractedAudio>();

  refs.forEach((ref, index) => {
    const data = entries[ref.partName];
    if (!data) return;

    // The same media part can be referenced by several slides; write it once.
    const already = seen.get(ref.partName);
    if (already) {
      extracted.push({ ...ref, file: already.file, ext: already.ext, bytes: already.bytes, playable: already.playable });
      return;
    }

    const rawExt = path.posix.extname(ref.partName).replace(/^\./, "").toLowerCase();
    if (VIDEO_EXT.has(rawExt)) return;
    const ext = AUDIO_EXT.has(rawExt) ? rawExt : "bin";
    const file = `${index + 1}.${ext}`;

    fs.writeFileSync(path.join(destDir, file), data);

    const record: ExtractedAudio = {
      ...ref,
      file,
      ext,
      bytes: data.byteLength,
      playable: ext !== "bin" && !UNPLAYABLE_AUDIO_EXT.has(ext),
    };
    seen.set(ref.partName, record);
    extracted.push(record);
  });

  return extracted;
}

/**
 * Writes each referenced video part into `destDir`, exactly like
 * `extractAudioParts` and with the same non-negotiable rule: output filenames
 * are GENERATED, never derived from the zip entry name, because a hostile or
 * merely odd `.pptx` can carry `../` in a part name.
 *
 * A sibling of that function rather than a shared generic one: the two agree
 * on the bookkeeping and on nothing else. Audio dedupes a part shared by
 * several slides into one file with one row per slide; a video belongs to one
 * slide, so the same clip on two slides is two independent elements with two
 * independent positions, and collapsing them would make pausing one pause the
 * other.
 */
export function extractVideoParts(
  filePath: string,
  refs: VideoRef[],
  destDir: string,
): ExtractedVideo[] {
  if (refs.length === 0) return [];

  const entries = readParts(filePath, new Set(refs.map((ref) => ref.partName)));

  fs.mkdirSync(destDir, { recursive: true });

  const extracted: ExtractedVideo[] = [];

  refs.forEach((ref, index) => {
    const data = entries[ref.partName];
    if (!data) return;

    const rawExt = path.posix.extname(ref.partName).replace(/^\./, "").toLowerCase();
    const ext = VIDEO_EXT.has(rawExt) ? rawExt : "bin";
    const file = `${index + 1}.${ext}`;

    fs.writeFileSync(path.join(destDir, file), data);

    extracted.push({
      ...ref,
      file,
      ext,
      bytes: data.byteLength,
      playable: PLAYABLE_VIDEO_EXT.has(ext),
    });
  });

  return extracted;
}
