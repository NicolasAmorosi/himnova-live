import { SLIDES_MIN_ADVANCE_MS } from "@shared/constants";
import { SLIDE_TRANSITION_SPEED_MS, type SlideTransition } from "@shared/types/transition";
import type { AudioRef, PresentationMeta, SlideTiming, VideoRef } from "../pptx-metadata";
import { AUDIO_EXT } from "../pptx-metadata";
import { attr, child, children, descendants, type XmlElement } from "../pptx/xml";
import { openOdp, type OdpPackage } from "./package";
import { length, partOf } from "./style";
import { textOf } from "./xml";

/**
 * Timings, transitions, sounds and clips of an `.odp`, in the shape the
 * `.pptx` path hands the deck service (`readPresentationMeta`): per page, as
 * its drawing-page style and its timing tree say — never guessed. Media is
 * named by its entry in the package; one linked from outside it is left out.
 */
export function readOdpMeta(file: string): PresentationMeta {
  const pkg = openOdp(file);
  const pages = children(pkg.presentation, "draw:page");
  const sizeOf = pageSizeEmu(pkg, pages[0] ?? null);
  const slides: SlideTiming[] = [];
  const audio: AudioRef[] = [];
  const video: VideoRef[] = [];
  const skippedVideoParts: string[] = [];

  pages.forEach((page, i) => {
    const slideIndex = i + 1;
    const props = pkg.sheet.resolve("content", "drawing-page", attr(page, "draw:style-name"));
    const pp = props.page;
    const root = page.children.find((c) => c.name === "anim:par" && attr(c, "presentation:node-type") === "timing-root") ?? null;
    // The transition's own node in the timing tree: the `anim:par` that
    // begins with the page (`smil:begin="<page id>.begin"`).
    const transitionPar = children(root, "anim:par").find((p) => /\.begin$/.test(attr(p, "smil:begin") ?? "")) ?? null;
    const filter = child(transitionPar, "anim:transitionFilter");

    const automatic = pp["presentation:transition-type"] === "automatic";
    const duration = isoDurationMs(pp["presentation:duration"]);
    const autoAdvanceMs = automatic && duration !== null ? Math.max(SLIDES_MIN_ADVANCE_MS, duration) : null;

    // A page sound: in the style, or as the transition node's `anim:audio`.
    const soundEl = props.sound ?? child(transitionPar, "anim:audio");
    const soundPart = partOf(attr(soundEl, "xlink:href"), { pkg });
    if (soundPart) {
      audio.push({
        partName: soundPart,
        startSlideIndex: slideIndex,
        origin: "transition",
        loop: attr(child(transitionPar, "anim:audio"), "smil:repeatCount") === "indefinite",
        volume: null,
        slides: 1,
      });
    }

    for (const frame of descendants(page, "draw:frame")) {
      if (hasAncestor(page, frame, "presentation:notes")) continue;
      const plugin = child(frame, "draw:plugin");
      if (!plugin) continue;
      const href = attr(plugin, "xlink:href");
      const part = partOf(href, { pkg });
      if (!part) {
        if (href) skippedVideoParts.push(`${href} (not in the package)`);
        continue;
      }
      const params = new Map(children(plugin, "draw:param").map((p) => [attr(p, "draw:name") ?? "", attr(p, "draw:value") ?? ""]));
      const loop = params.get("Loop") === "true";
      const volume = params.get("Mute") === "true" ? 0 : volumeOf(params.get("VolumeDB"));
      const ext = part.slice(part.lastIndexOf(".") + 1).toLowerCase();
      const mime = attr(plugin, "draw:mime-type") ?? "";
      if (AUDIO_EXT.has(ext) || mime.startsWith("audio/")) {
        audio.push({ partName: part, startSlideIndex: slideIndex, origin: "embedded", loop, volume, slides: 1 });
        continue;
      }
      const rect = frameRect(frame, sizeOf);
      if (!rect) {
        skippedVideoParts.push(`${part} (no geometry of its own)`);
        continue;
      }
      video.push({ partName: part, slideIndex, rect, loop, volume });
    }

    const title = page.children.find((c) => c.name === "draw:frame" && attr(c, "presentation:class") === "title" && attr(c, "presentation:placeholder") !== "true");
    const notesFrame = descendants(child(page, "presentation:notes"), "draw:frame").find((f) => attr(f, "presentation:class") === "notes");
    const notes = notesFrame ? paragraphsText(notesFrame) : "";
    slides.push({
      slideIndex,
      partName: "content.xml",
      autoAdvanceMs,
      advanceOnClick: true,
      transition: transitionOf(filter, pp),
      hidden: pp["presentation:visibility"] === "hidden",
      title: title ? paragraphsText(title).replace(/\s+/g, " ").trim() || null : null,
      notes: notes || null,
    });
  });

  return { slideCount: slides.length, slideSizeEmu: sizeOf, slides, audio, video, skippedVideoParts };
}

function pageSizeEmu(pkg: OdpPackage, first: XmlElement | null): { cx: number; cy: number } | null {
  const sheet = pkg.sheet;
  const master = sheet.masters.get(attr(first, "draw:master-page-name") ?? "") ?? sheet.masterList[0] ?? null;
  const layout = sheet.pageLayouts.get(attr(master, "style:page-layout-name") ?? "") ?? [...sheet.pageLayouts.values()][0] ?? null;
  const props = child(layout, "style:page-layout-properties");
  const cx = length(attr(props, "fo:page-width"));
  const cy = length(attr(props, "fo:page-height"));
  return cx && cy && cx > 0 && cy > 0 ? { cx: Math.round(cx), cy: Math.round(cy) } : null;
}

function hasAncestor(root: XmlElement, target: XmlElement, name: string): boolean {
  const walk = (el: XmlElement, inside: boolean): boolean | null => {
    if (el === target) return inside;
    for (const c of el.children) {
      const found = walk(c, inside || c.name === name);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(root, false) ?? false;
}

/** Text of a shape, one line per paragraph. */
function paragraphsText(el: XmlElement): string {
  return descendants(el, "text:p")
    .map((p) => textOf(p).replace(/[ \t\r\n]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** `PT1M5.5S`, `PT00H00M05S` → milliseconds. */
function isoDurationMs(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value.trim());
  if (!m) return null;
  const [, d = "0", h = "0", min = "0", s = "0"] = m;
  return Math.round(((Number(d) * 24 + Number(h)) * 3600 + Number(min) * 60 + Number(s)) * 1000);
}

/** `smil:dur` (`2s`, `0.5s`, `1500ms`, `00:00:02`) → milliseconds. */
function smilMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const v = value.trim();
  const clock = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(v);
  if (clock) return Math.round(((Number(clock[1] ?? 0) * 60 + Number(clock[2])) * 60 + Number(clock[3])) * 1000);
  const m = /^(\d+(?:\.\d+)?)(ms|s|min|h)?$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  return Math.round(m[2] === "ms" ? n : m[2] === "min" ? n * 60000 : m[2] === "h" ? n * 3600000 : n * 1000);
}

/**
 * How the page enters, mapped like the OOXML path: a fade is a crossfade, or
 * fades through black when it fades over a colour; random bars are drawn as
 * themselves; any other effect is a crossfade of its own length. The length
 * is the transition node's `smil:dur`, else the style's speed word.
 */
function transitionOf(filter: XmlElement | null, pp: Record<string, string>): SlideTransition | null {
  const type = attr(filter, "smil:type") ?? pp["smil:type"];
  const subtype = attr(filter, "smil:subtype") ?? pp["smil:subtype"];
  const legacy = pp["presentation:transition-style"];
  if (!type && (!legacy || legacy === "none")) return null;
  const speed = pp["presentation:transition-speed"];
  const durationMs =
    smilMs(attr(filter, "smil:dur")) ??
    smilMs(pp["smil:dur"]) ??
    (speed === "slow" ? SLIDE_TRANSITION_SPEED_MS.slow : speed === "fast" ? SLIDE_TRANSITION_SPEED_MS.fast : SLIDE_TRANSITION_SPEED_MS.medium);
  if (durationMs <= 0) return null;
  if (type === "fade") {
    const throughColor = subtype === "fadeOverColor" || subtype === "fadeToColor" || subtype === "fadeFromColor";
    return { style: throughColor ? "fade-through-black" : "crossfade", durationMs };
  }
  if (type === "randomBarWipe") return { style: subtype === "vertical" ? "random-bars-vertical" : "random-bars-horizontal", durationMs };
  return { style: "crossfade", durationMs };
}

function volumeOf(db: string | undefined): number | null {
  if (db === undefined || db === "") return null;
  const v = Number(db);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(1, Math.pow(10, v / 20)));
}

/** A frame's box as fractions of the page; `null` without a size. */
function frameRect(frame: XmlElement, size: { cx: number; cy: number } | null): VideoRef["rect"] | null {
  if (!size) return null;
  const w = length(attr(frame, "svg:width"));
  const h = length(attr(frame, "svg:height"));
  if (!w || !h) return null;
  const x = length(attr(frame, "svg:x")) ?? 0;
  const y = length(attr(frame, "svg:y")) ?? 0;
  return { x: x / size.cx, y: y / size.cy, width: w / size.cx, height: h / size.cy };
}
