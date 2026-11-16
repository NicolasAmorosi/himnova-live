/**
 * How a `.pptx` slide enters, read from its own `p:transition` — the same
 * `SlideTransition` a legacy binary gives, so a hymn and an announcements deck
 * move the same way on the projector.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { strToU8, zipSync } from "fflate";
import { readPresentationMeta } from "../../src/main/slides/pptx-metadata";

const NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"';

let dir: string;

/** One slide per entry, the entry written after `p:cSld`. With `sound`, each slide also carries a sound
 *  (`p:pic` id 4) for a `p:timing` in the entry to play. */
function writeDeck(transitions: string[], sound = false): string {
  const files: Record<string, Uint8Array> = {
    "ppt/presentation.xml": strToU8(
      `<p:presentation ${NS}><p:sldIdLst>${transitions
        .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
        .join("")}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${transitions
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
        )
        .join("")}</Relationships>`,
    ),
  };
  const pic = `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Audio"/><p:cNvPicPr/><p:nvPr><a:audioFile r:link="rId2"/></p:nvPr></p:nvPicPr><p:blipFill/><p:spPr/></p:pic>`;
  transitions.forEach((transition, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(
      `<p:sld ${NS}><p:cSld><p:spTree>${sound ? pic : ""}</p:spTree></p:cSld>${transition}</p:sld>`,
    );
    if (sound) {
      files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = strToU8(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio" Target="../media/sound${i + 1}.mp3"/></Relationships>`,
      );
    }
  });
  const file = path.join(dir, `deck-${transitions.length}-${Math.random().toString(36).slice(2)}.pptx`);
  fs.writeFileSync(file, zipSync(files));
  return file;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-pptx-transition-"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("each slide's transition, as PowerPoint and LibreOffice write it", () => {
  const meta = readPresentationMeta(
    writeDeck([
      // What LibreOffice exports for the hymnal's «Fade Smoothly», fast by default.
      `<p:transition advTm="10000"><p:fade/></p:transition>`,
      `<p:transition spd="slow"><p:fade thruBlk="1"/></p:transition>`,
      `<p:transition spd="med"><p:randomBar dir="vert"/></p:transition>`,
      `<p:transition><p:randomBar/></p:transition>`,
      // PowerPoint 2010+: the real one under mc:Choice, with its exact length.
      `<mc:AlternateContent><mc:Choice Requires="p14"><p:transition spd="slow" p14:dur="1250"><p14:vortex/></p:transition></mc:Choice><mc:Fallback><p:transition spd="slow"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>`,
      `<p:transition><p:cut/></p:transition>`,
      `<p:transition advTm="5000"/>`,
      "",
    ]),
  );
  expect(meta.slides.map((slide) => slide.transition)).toEqual([
    { style: "crossfade", durationMs: 500 },
    { style: "fade-through-black", durationMs: 1000 },
    { style: "random-bars-vertical", durationMs: 750 },
    { style: "random-bars-horizontal", durationMs: 500 },
    // Drawn as a crossfade of its own length — the owner's call for anything
    // we do not draw as itself.
    { style: "crossfade", durationMs: 1250 },
    null,
    null,
    null,
  ]);
});

// 2026-11-15 audit, A31: PowerPoint wraps the timing too when an animation needs 2010 or later, and two wrappers at
// the slide root came back as an array, which was read as none: the slide lost its `advTm` and its sound's settings.
test("a slide with its transition and its timing each wrapped keeps both", () => {
  const timing = `<p:timing><p:tnLst><p:par><p:cTn id="1"><p:childTnLst><p:audio><p:cMediaNode vol="80000" numSld="3"><p:cTn id="2" repeatCount="indefinite"/><p:tgtEl><p:spTgt spid="4"/></p:tgtEl></p:cMediaNode></p:audio></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;
  const meta = readPresentationMeta(
    writeDeck(
      [
        `<mc:AlternateContent><mc:Choice Requires="p14"><p:transition spd="slow" p14:dur="1250" advClick="0" advTm="7000"><p14:vortex/></p:transition></mc:Choice><mc:Fallback><p:transition spd="slow" advClick="0" advTm="7000"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>` +
          `<mc:AlternateContent><mc:Choice Requires="p14">${timing}</mc:Choice><mc:Fallback>${timing}</mc:Fallback></mc:AlternateContent>`,
        "",
        "",
      ],
      true,
    ),
  );
  expect(meta.slides[0]).toMatchObject({ autoAdvanceMs: 7000, advanceOnClick: false, transition: { style: "crossfade", durationMs: 1250 } });
  expect(meta.audio[0]).toMatchObject({ startSlideIndex: 1, slides: 3, loop: true });
});
