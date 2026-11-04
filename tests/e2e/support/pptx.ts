import { strToU8, zipSync } from "fflate";

/**
 * A `.pptx` written part by part, the way PowerPoint stores one — so the suite
 * and the screenshots need no office suite to make their decks. Only what a
 * fixture needs: a background, one text box, an auto-advance with a fade, and
 * raw XML for whatever else a slide carries (a clip, a sound).
 */

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
export const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";

/** 28 × 15.75 cm: the 16:9 page every generated deck has. */
export const SLIDE_SIZE = { cx: 10_080_000, cy: 5_670_000 };
/** EMU per centimetre. */
export const CM = 360_000;

const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  wmv: "video/x-ms-wmv",
  wma: "audio/x-ms-wma",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
};

export type PptxParagraph = {
  /** `\n` is a line break inside the paragraph. */
  text: string;
  /** Points. */
  size: number;
  color?: string;
  font?: string;
  italic?: boolean;
  align?: "l" | "ctr";
  /** Percent of single spacing. */
  lineSpacing?: number;
  /** Points before the paragraph. */
  spaceBefore?: number;
};

export type PptxSlideSpec = {
  /** `#rrggbb`. */
  background?: string;
  text?: { paragraphs: PptxParagraph[]; box: [x: number, y: number, w: number, h: number]; anchor?: "t" | "ctr" };
  /** Advances by itself after this long, with a fade. */
  advanceMs?: number;
  /** More of the slide's shape tree, and its relationships, as XML. */
  shapes?: string;
  rels?: string;
  /** `<p:timing>` — what plays a sound or a clip. */
  timing?: string;
};

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hex = (color: string) => color.replace(/^#/, "").toUpperCase();
const solid = (color: string) => `<a:solidFill><a:srgbClr val="${hex(color)}"/></a:solidFill>`;

function paragraph(p: PptxParagraph): string {
  const rPr = `<a:rPr lang="es-AR" sz="${p.size * 100}"${p.italic ? ' i="1"' : ""}>${p.color ? solid(p.color) : ""}${p.font ? `<a:latin typeface="${escape(p.font)}"/>` : ""}</a:rPr>`;
  const pPr =
    `<a:pPr algn="${p.align ?? "ctr"}">` +
    (p.lineSpacing ? `<a:lnSpc><a:spcPct val="${p.lineSpacing * 1000}"/></a:lnSpc>` : "") +
    (p.spaceBefore ? `<a:spcBef><a:spcPts val="${p.spaceBefore * 100}"/></a:spcBef>` : "") +
    "</a:pPr>";
  const runs = p.text.split("\n").map((line) => `<a:r>${rPr}<a:t>${escape(line)}</a:t></a:r>`);
  return `<a:p>${pPr}${runs.join(`<a:br>${rPr}</a:br>`)}</a:p>`;
}

function slideXml(slide: PptxSlideSpec): string {
  const bg = slide.background ? `<p:bg><p:bgPr>${solid(slide.background)}<a:effectLst/></p:bgPr></p:bg>` : "";
  const text = slide.text
    ? `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="${slide.text.box[0]}" y="${slide.text.box[1]}"/><a:ext cx="${slide.text.box[2]}" cy="${slide.text.box[3]}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
      `<p:txBody><a:bodyPr wrap="square" anchor="${slide.text.anchor ?? "ctr"}"/><a:lstStyle/>${slide.text.paragraphs.map(paragraph).join("")}</p:txBody></p:sp>`
    : "";
  const transition = slide.advanceMs === undefined ? "" : `<p:transition spd="fast" advTm="${slide.advanceMs}"><p:fade/></p:transition>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld ${NS}><p:cSld>${bg}<p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${text}${slide.shapes ?? ""}` +
    `</p:spTree></p:cSld>${transition}${slide.timing ?? ""}</p:sld>`
  );
}

/** The deck, zipped. `parts` are package parts beside the slides
 *  (`ppt/media/…`), typed by their extension. */
export function buildPptx(slides: readonly PptxSlideSpec[], parts: Record<string, Uint8Array> = {}): Uint8Array {
  const extensions = new Set(Object.keys(parts).map((name) => name.split(".").pop() ?? ""));
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        [...extensions].map((ext) => `<Default Extension="${ext}" ContentType="${MEDIA_TYPES[ext] ?? "application/octet-stream"}"/>`).join("") +
        `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
        slides
          .map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)
          .join("") +
        `</Types>`,
    ),
    "_rels/.rels": strToU8(`<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`),
    "ppt/presentation.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation ${NS}><p:sldIdLst>` +
        slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("") +
        `</p:sldIdLst><p:sldSz cx="${SLIDE_SIZE.cx}" cy="${SLIDE_SIZE.cy}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      `<Relationships xmlns="${PKG}">` +
        slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join("") +
        `</Relationships>`,
    ),
    ...parts,
  };
  slides.forEach((slide, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(slideXml(slide));
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = strToU8(`<Relationships xmlns="${PKG}">${slide.rels ?? ""}</Relationships>`);
  });
  return zipSync(files);
}
