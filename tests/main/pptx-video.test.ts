/**
 * Reading a video embedded in a `.pptx`, and refusing to read one we cannot
 * place.
 *
 * The bytes are the easy half — `extractVideoParts` is the audio extractor
 * with a different extension set. What this file pins down is everything that
 * decides WHERE the clip ends up, because a video positioned wrong is not a
 * cosmetic defect: it is a clip pasted over the middle of the sermon, live.
 *
 * So: the rect is exact against `p:sldSz`, a shape with no geometry of its own
 * is refused rather than guessed at, an external (linked) file is not mistaken
 * for an internal part, and a slide carrying both narration and a clip gives
 * the clip its OWN level instead of the narration's.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { zipSync, strToU8, type ZippableFile } from "fflate";
import { extractVideoParts, readPresentationMeta } from "../../src/main/slides/pptx-metadata";

/** 16:9 at PowerPoint's own EMU scale — the size the fixture's rects are
 *  measured against. */
const SLIDE_CX = 12_192_000;
const SLIDE_CY = 6_858_000;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="mp4" ContentType="video/mp4"/>
  <Default Extension="mp3" ContentType="audio/mpeg"/>
</Types>`;

function presentationXml(slideCount: number): string {
  const ids = Array.from(
    { length: slideCount },
    (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>${ids}</p:sldIdLst>
  <p:sldSz cx="${SLIDE_CX}" cy="${SLIDE_CY}"/>
</p:presentation>`;
}

function presentationRels(slideCount: number): string {
  const rels = Array.from(
    { length: slideCount },
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}

type VideoPic = {
  /** `p:cNvPr/@id` — what a `p:cMediaNode` names when it targets this shape. */
  shapeId: number;
  relId: string;
  /** Left as-is for the "inherits its geometry from the layout" case. */
  xfrm?: { x: number; y: number; cx: number; cy: number } | undefined;
};

function videoPicXml({ shapeId, relId, xfrm }: VideoPic): string {
  const geometry = xfrm
    ? `<a:xfrm><a:off x="${xfrm.x}" y="${xfrm.y}"/><a:ext cx="${xfrm.cx}" cy="${xfrm.cy}"/></a:xfrm>`
    : "";
  return `<p:pic>
    <p:nvPicPr>
      <p:cNvPr id="${shapeId}" name="Clip"/>
      <p:nvPr>
        <a:videoFile r:link="${relId}"/>
        <p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="${relId}"/></p:ext></p:extLst>
      </p:nvPr>
    </p:nvPicPr>
    <p:spPr>${geometry}</p:spPr>
  </p:pic>`;
}

function audioPicXml(shapeId: number, relId: string): string {
  return `<p:pic>
    <p:nvPicPr>
      <p:cNvPr id="${shapeId}" name="Narración"/>
      <p:nvPr><a:audioFile r:link="${relId}"/></p:nvPr>
    </p:nvPicPr>
    <p:spPr/>
  </p:pic>`;
}

/** One `p:cMediaNode` aimed at a specific shape, the way PowerPoint writes it. */
function mediaNodeXml(shapeId: number, vol: number, loop: boolean): string {
  return `<p:cMediaNode vol="${vol}" loop="${loop ? "1" : "0"}">
    <p:cTn id="${shapeId + 100}"/>
    <p:tgtEl><p:spTgt spid="${shapeId}"/></p:tgtEl>
  </p:cMediaNode>`;
}

function slideXml(shapes: string, timing: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld name="Slide"><p:spTree>${shapes}</p:spTree></p:cSld>
  ${timing ? `<p:timing><p:tnLst>${timing}</p:tnLst></p:timing>` : ""}
</p:sld>`;
}

function relsXml(entries: { id: string; type: string; target: string; external?: boolean }[]): string {
  const rels = entries
    .map(
      (rel) =>
        `<Relationship Id="${rel.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${rel.type}" Target="${rel.target}"${rel.external ? ' TargetMode="External"' : ""}/>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}

let dir: string;

/** Writes a `.pptx` whose slide parts are exactly what the caller passed. */
function writeDeck(name: string, slides: { xml: string; rels: string }[], media: Record<string, ZippableFile>): string {
  const files: Record<string, ZippableFile> = {
    "[Content_Types].xml": strToU8(CONTENT_TYPES),
    "ppt/presentation.xml": strToU8(presentationXml(slides.length)),
    "ppt/_rels/presentation.xml.rels": strToU8(presentationRels(slides.length)),
    ...media,
  };
  slides.forEach((slide, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(slide.xml);
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = strToU8(slide.rels);
  });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, zipSync(files));
  return filePath;
}

/** Not a real clip — nothing here decodes it. Distinctive bytes so the
 *  extraction assertions are about THIS part and not about a zero-filled
 *  buffer that any bug could produce. */
const MP4_BYTES = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-pptx-video-"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a video embedded in a slide", () => {
  test("its rect is exact against the slide size, not approximated", () => {
    // 25%-75% on both axes — the same geometry the 2026-09-20 investigation
    // measured on a PowerPoint-authored fixture.
    const file = writeDeck(
      "rect.pptx",
      [
        {
          xml: slideXml(videoPicXml({ shapeId: 4, relId: "rId1", xfrm: { x: 3_048_000, y: 1_714_500, cx: 6_096_000, cy: 3_429_000 } }), ""),
          rels: relsXml([{ id: "rId1", type: "video", target: "../media/media1.mp4" }]),
        },
      ],
      { "ppt/media/media1.mp4": MP4_BYTES },
    );

    const meta = readPresentationMeta(file);
    expect(meta.video).toHaveLength(1);
    expect(meta.video[0]).toMatchObject({
      partName: "ppt/media/media1.mp4",
      slideIndex: 1,
      rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    });
    expect(meta.skippedVideoParts).toHaveLength(0);
  });

  test("it is reported on the slide it is actually on", () => {
    const empty = { xml: slideXml("", ""), rels: relsXml([]) };
    const withVideo = {
      xml: slideXml(videoPicXml({ shapeId: 4, relId: "rId1", xfrm: { x: 0, y: 0, cx: SLIDE_CX, cy: SLIDE_CY } }), ""),
      rels: relsXml([{ id: "rId1", type: "video", target: "../media/media1.mp4" }]),
    };
    const file = writeDeck("second-slide.pptx", [empty, withVideo, empty], {
      "ppt/media/media1.mp4": MP4_BYTES,
    });

    const meta = readPresentationMeta(file);
    expect(meta.video).toHaveLength(1);
    expect(meta.video[0]?.slideIndex).toBe(2);
    expect(meta.video[0]?.rect).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  test("its bytes come out under a generated name, never the part's own", () => {
    const file = writeDeck(
      "extract.pptx",
      [
        {
          xml: slideXml(videoPicXml({ shapeId: 4, relId: "rId1", xfrm: { x: 0, y: 0, cx: SLIDE_CX, cy: SLIDE_CY } }), ""),
          rels: relsXml([{ id: "rId1", type: "video", target: "../media/media1.mp4" }]),
        },
      ],
      { "ppt/media/media1.mp4": MP4_BYTES },
    );

    const destDir = path.join(dir, "out");
    const extracted = extractVideoParts(file, readPresentationMeta(file).video, destDir);

    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toMatchObject({ file: "1.mp4", ext: "mp4", bytes: MP4_BYTES.length, playable: true });
    expect(fs.readFileSync(path.join(destDir, "1.mp4"))).toEqual(Buffer.from(MP4_BYTES));
  });

  test("a format Chromium cannot decode is extracted but marked unplayable", () => {
    const file = writeDeck(
      "wmv.pptx",
      [
        {
          xml: slideXml(videoPicXml({ shapeId: 4, relId: "rId1", xfrm: { x: 0, y: 0, cx: SLIDE_CX, cy: SLIDE_CY } }), ""),
          rels: relsXml([{ id: "rId1", type: "video", target: "../media/media1.wmv" }]),
        },
      ],
      { "ppt/media/media1.wmv": MP4_BYTES },
    );

    const extracted = extractVideoParts(file, readPresentationMeta(file).video, path.join(dir, "out-wmv"));
    expect(extracted[0]).toMatchObject({ ext: "wmv", playable: false });
  });

  // 2026-11-15 audit, R20: every clip of a deck used to be read whole, all of them at once, before the first was
  // written (~2.2 times the media in memory; a stored 1 GB video read whole).
  test("a stored clip is copied by blocks, never read whole, and a clip on two slides comes out twice", () => {
    const clip = new Uint8Array(5 * 1024 * 1024).map((_, i) => (i * 31) & 0xff);
    const slide = {
      xml: slideXml(videoPicXml({ shapeId: 4, relId: "rId1", xfrm: { x: 0, y: 0, cx: SLIDE_CX, cy: SLIDE_CY } }), ""),
      rels: relsXml([{ id: "rId1", type: "video", target: "../media/media1.mp4" }]),
    };
    const file = writeDeck("stored.pptx", [slide, slide], { "ppt/media/media1.mp4": [clip, { level: 0 }] });
    const refs = readPresentationMeta(file).video;
    const destDir = path.join(dir, "out-stored");

    const spy = vi.spyOn(fs, "readSync");
    let extracted: ReturnType<typeof extractVideoParts>;
    let reads: number[];
    try {
      extracted = extractVideoParts(file, refs, destDir);
      // `readSync(fd, buffer, offset, length, position)`: the length of every read.
      reads = spy.mock.calls.map((call) => Number((call as unknown[])[3]));
    } finally {
      spy.mockRestore();
    }

    expect(reads.length).toBeGreaterThan(0);
    expect(Math.max(...reads)).toBeLessThanOrEqual(1024 * 1024);
    expect(extracted.map(({ file, bytes }) => [file, bytes])).toEqual([["1.mp4", clip.length], ["2.mp4", clip.length]]);
    for (const out of ["1.mp4", "2.mp4"]) expect(fs.readFileSync(path.join(destDir, out)).equals(Buffer.from(clip))).toBe(true);
  });
});

describe("a video we cannot place is refused, never guessed at", () => {
  test("a shape with no geometry of its own is skipped", () => {
    // It inherits a layout placeholder's rect, which this parser does not
    // resolve. The rasterized slide still shows the poster frame in the right
    // place; a default would put a moving picture somewhere it is not.
    const file = writeDeck(
      "no-xfrm.pptx",
      [
        {
          xml: slideXml(videoPicXml({ shapeId: 4, relId: "rId1" }), ""),
          rels: relsXml([{ id: "rId1", type: "video", target: "../media/media1.mp4" }]),
        },
      ],
      { "ppt/media/media1.mp4": MP4_BYTES },
    );

    const meta = readPresentationMeta(file);
    expect(meta.video).toHaveLength(0);
    expect(meta.skippedVideoParts).toHaveLength(1);
    expect(meta.skippedVideoParts[0]).toContain("media1.mp4");
  });

  test("an external file is not mistaken for a part inside the archive", () => {
    // The trap: `path.posix.join("ppt/slides", "C:\\clips\\intro.mp4")` yields
    // a plausible-looking part name that names nothing. Harmless while the
    // value was only logged; not harmless once something reads it.
    const file = writeDeck(
      "linked.pptx",
      [
        {
          xml: slideXml(videoPicXml({ shapeId: 4, relId: "rId1", xfrm: { x: 0, y: 0, cx: SLIDE_CX, cy: SLIDE_CY } }), ""),
          rels: relsXml([
            { id: "rId1", type: "video", target: "file:///C:/clips/intro.mp4", external: true },
          ]),
        },
      ],
      {},
    );

    const meta = readPresentationMeta(file);
    expect(meta.video).toHaveLength(0);
    expect(meta.skippedVideoParts).toHaveLength(1);
    expect(meta.skippedVideoParts[0]).toContain("external");
  });
});

describe("a slide carrying both narration and a clip", () => {
  test("the clip gets its own level and loop, not the narration's", () => {
    const shapes =
      audioPicXml(3, "rId1") +
      videoPicXml({ shapeId: 4, relId: "rId2", xfrm: { x: 0, y: 0, cx: SLIDE_CX, cy: SLIDE_CY } });
    const timing = mediaNodeXml(3, 20_000, true) + mediaNodeXml(4, 80_000, false);
    const file = writeDeck(
      "mixed.pptx",
      [
        {
          xml: slideXml(shapes, timing),
          rels: relsXml([
            { id: "rId1", type: "audio", target: "../media/media1.mp3" },
            { id: "rId2", type: "video", target: "../media/media2.mp4" },
          ]),
        },
      ],
      { "ppt/media/media1.mp3": MP4_BYTES, "ppt/media/media2.mp4": MP4_BYTES },
    );

    const meta = readPresentationMeta(file);
    expect(meta.video).toHaveLength(1);
    // 80000 thousandths of a percent, and NOT the narration's 20% or its loop.
    expect(meta.video[0]).toMatchObject({ volume: 0.8, loop: false });
  });

  test("a single media node with no target still applies to the clip", () => {
    // The pre-existing slide-wide aggregate, which is exactly right when there
    // is only one thing to be about.
    const file = writeDeck(
      "untargeted.pptx",
      [
        {
          xml: slideXml(
            videoPicXml({ shapeId: 4, relId: "rId1", xfrm: { x: 0, y: 0, cx: SLIDE_CX, cy: SLIDE_CY } }),
            `<p:cMediaNode vol="50000" loop="1"><p:cTn id="9"/></p:cMediaNode>`,
          ),
          rels: relsXml([{ id: "rId1", type: "video", target: "../media/media1.mp4" }]),
        },
      ],
      { "ppt/media/media1.mp4": MP4_BYTES },
    );

    expect(readPresentationMeta(file).video[0]).toMatchObject({ volume: 0.5, loop: true });
  });
});
