import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { FIXTURES_DIR, FIXTURE_VERSION, ffmpegBinary } from "./paths";
import { buildPdf } from "./pdf";
import { CM, REL, buildPptx } from "./pptx";
import { buildLegacyPpt } from "../../fixtures/legacy-ppt";

/**
 * Generates every file the suite projects, once, with the FFmpeg the app
 * itself ships and decks written in code (`pptx.ts`, `pdf.ts`,
 * `tests/fixtures/legacy-ppt.ts`) — so the suite needs nothing checked in and
 * nothing else installed, and runs the same on the church's Windows PC as on a
 * Mac. Regenerated only when `FIXTURE_VERSION` changes.
 */
export default function globalSetup(): void {
  const stamp = path.join(FIXTURES_DIR, ".version");
  // The stamp alone is not proof: the OS purges files in its temp folder it
  // thinks are stale (macOS does after a few days) and can leave the stamp
  // behind, and then every test fails on a missing fixture as if the app broke.
  const intact = fs.existsSync(path.join(FIXTURES_DIR, "clip.mp4"));
  if (intact && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === String(FIXTURE_VERSION)) return;

  fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  const ffmpeg = ffmpegBinary();
  if (!fs.existsSync(ffmpeg)) throw new Error(`No bundled FFmpeg at ${ffmpeg} — run \`npm run fetch:binaries\``);

  const out = (name: string) => path.join(FIXTURES_DIR, name);
  const run = (...args: string[]) => execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  const picture = (size: string, seconds: number) => ["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=25:duration=${seconds}`];
  const tone = (seconds: number) => ["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`];

  // Plays as it is.
  run(...picture("640x360", 8), ...tone(8), "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", out("clip.mp4"));
  // Converted, quickly.
  run(...picture("640x360", 6), ...tone(6), "-shortest", "-c:v", "mpeg4", "-vtag", "xvid", "-c:a", "libmp3lame", out("clip-xvid.avi"));
  // Converted, slowly enough to be watched converting: a full re-encode of
  // 1080p, at the low priority and half the cores a real conversion gets,
  // takes several seconds even on a fast machine.
  run(...picture("1920x1080", 30), ...tone(30), "-shortest", "-c:v", "mpeg4", "-q:v", "6", "-c:a", "libmp3lame", out("long-xvid.avi"));
  // The silent case: opens in Chromium and plays sound over a black picture.
  run(...picture("640x360", 6), ...tone(6), "-shortest", "-c:v", "mpeg4", "-c:a", "aac", out("sound-over-black.mp4"));
  run(...tone(8), "-c:a", "libmp3lame", out("song.mp3"));
  // Long enough to cover it with NEGRO and close the projector before it ends.
  run(...tone(30), "-c:a", "wmav2", out("song.wma"));
  run("-f", "lavfi", "-i", "testsrc2=size=1280x720", "-frames:v", "1", out("photo.png"));

  fs.writeFileSync(out("deck.pdf"), buildPdf(["#1f4e9c", "#c0392b", "#27ae60"]));

  // A legacy hymn as the real ones are: a JPEG per slide, a logo over the
  // first and a speaker icon PowerPoint hides — read straight from the file
  // (`ppt-binary.ts`). The second slide fades in slowly and the third enters
  // by vertical random bars, both as the file says.
  const frame = (source: string, name: string) => {
    run("-f", "lavfi", "-i", source, "-frames:v", "1", out(name));
    const bytes = fs.readFileSync(out(name));
    fs.rmSync(out(name));
    return bytes;
  };
  const slides = ["#1f4e9c", "#c0392b", "#27ae60"].map((colour, i) => frame(`color=c=${colour}:size=800x600`, `s${i}.jpg`));
  fs.writeFileSync(
    out("legacy-hymn.pps"),
    buildLegacyPpt({
      pictures: [
        ...slides.map((bytes) => ({ type: "jpeg" as const, bytes })),
        { type: "png", bytes: frame("color=c=white:size=60x54", "logo.png") },
      ],
      slides: [
        { shapes: [{ rect: [0, 0, 5760, 4320], pib: 1 }, { rect: [3748, 5057, 5411, 4072], pib: 4 }] },
        { effectType: 23, speed: 0, shapes: [{ rect: [0, 0, 5760, 4320], pib: 2 }] },
        { effectType: 8, effectDirection: 1, speed: 2, shapes: [{ rect: [0, 0, 5760, 4320], pib: 3 }] },
      ],
    }),
  );

  // The hymn as a `.pptx`: three verses that advance by themselves after two
  // seconds each, with a fade — written part by part, no office suite needed.
  const verses = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      text: { paragraphs: [{ text: `Estrofa ${i + 1}`, size: 44 }], box: [2 * CM, 5 * CM, 24 * CM, 6 * CM] as [number, number, number, number] },
      advanceMs: 2000,
    }));
  fs.writeFileSync(out("hymn.pptx"), buildPptx(verses(3)));

  // The same hymn with a WMA as its music: a sound on slide 1 that plays across
  // every slide (`numSld`), which is how PowerPoint stores a deck's music. Only
  // the media engine plays it, and the slides follow its clock («synced»).
  const [first, ...rest] = verses(3);
  fs.writeFileSync(
    out("hymn-wma.pptx"),
    buildPptx(
      [
        {
          ...first!,
          shapes:
            '<p:pic><p:nvPicPr><p:cNvPr id="99" name="Music"/><p:cNvPicPr/><p:nvPr><a:audioFile r:link="rIdMusic"/></p:nvPr></p:nvPicPr><p:blipFill/><p:spPr/></p:pic>',
          rels: `<Relationship Id="rIdMusic" Type="${REL}/audio" Target="../media/music1.wma"/>`,
          timing:
            '<p:timing><p:tnLst><p:par><p:cTn id="1"><p:childTnLst><p:audio><p:cMediaNode numSld="999"><p:cTn id="2"/><p:tgtEl><p:spTgt spid="99"/></p:tgtEl></p:cMediaNode></p:audio></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>',
        },
        ...rest,
      ],
      { "ppt/media/music1.wma": fs.readFileSync(out("song.wma")) },
    ),
  );

  // A WMV embedded in a slide — what PowerPoint 2007 decks carry and Chromium
  // cannot play (the media engine does): a part under `ppt/media/`, a `video`
  // relationship addressed as a link, its rect, and the poster frame the
  // slide draws under it.
  run(...picture("640x360", 4), "-c:v", "wmv2", out("slide-clip.wmv"));
  run(...picture("640x360", 1), "-frames:v", "1", out("slide-clip.png"));
  fs.writeFileSync(
    out("clipdeck.pptx"),
    buildPptx(
      [
        {
          shapes:
            '<p:pic><p:nvPicPr><p:cNvPr id="3" name="Clip"/><p:cNvPicPr/><p:nvPr><a:videoFile r:link="rIdVideo"/></p:nvPr></p:nvPicPr>' +
            '<p:blipFill><a:blip r:embed="rIdPoster"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
            `<p:spPr><a:xfrm><a:off x="${4 * CM}" y="${2 * CM}"/><a:ext cx="${20 * CM}" cy="${11.25 * CM}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
          rels:
            `<Relationship Id="rIdVideo" Type="${REL}/video" Target="../media/media1.wmv"/>` +
            `<Relationship Id="rIdPoster" Type="${REL}/image" Target="../media/poster.png"/>`,
        },
      ],
      { "ppt/media/media1.wmv": fs.readFileSync(out("slide-clip.wmv")), "ppt/media/poster.png": fs.readFileSync(out("slide-clip.png")) },
    ),
  );
  for (const name of ["slide-clip.wmv", "slide-clip.png"]) fs.rmSync(out(name), { force: true });

  // A PDF long enough that converting it, as builds before 2026-11-03 did,
  // took seconds: it has to open at once, its pages drawn when asked for.
  const pages = (count: number) => Array.from({ length: count }, (_, i) => `#${((i * 2_654_435) % 0xffffff).toString(16).padStart(6, "0")}`);
  fs.writeFileSync(out("long.pdf"), buildPdf(pages(160)));

  // The same hymn as a legacy binary with text — which the picture reader
  // refuses, so `ppt/model-reader.ts` draws it — and as an `.odp` (`odp/`).
  fs.writeFileSync(
    out("legacy-text.ppt"),
    buildLegacyPpt({
      slides: [1, 2, 3].map((n) => ({
        slideTimeMs: 2000,
        infoFlags: 0x0400,
        shapes: [{ type: 1, rect: [1440, 576, 5184, 2880] as [number, number, number, number], text: `Estrofa ${n}` }],
      })),
    }),
  );
  fs.writeFileSync(out("hymn.odp"), buildOdp(3, 2));

  fs.writeFileSync(stamp, String(FIXTURE_VERSION));
}

/** `slides` pages that each advance after `seconds`, with a fade: an
 *  OpenDocument presentation, zipped the way the format asks. */
function buildOdp(slides: number, seconds: number): Uint8Array {
  const ns =
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" ' +
    'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
    'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:smil="urn:oasis:names:tc:opendocument:xmlns:smil-compatible:1.0" ' +
    'xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" office:version="1.3"';
  const pages = Array.from(
    { length: slides },
    (_, i) =>
      `<draw:page draw:name="page${i + 1}" draw:style-name="dp1" draw:master-page-name="Default">` +
      `<draw:frame svg:x="2cm" svg:y="5cm" svg:width="24cm" svg:height="6cm"><draw:text-box><text:p text:style-name="P1">Estrofa ${i + 1}</text:p></draw:text-box></draw:frame></draw:page>`,
  ).join("");
  const xml = (body: string) => strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`);
  return zipSync({
    // First and stored, as the format requires.
    mimetype: [strToU8("application/vnd.oasis.opendocument.presentation"), { level: 0 }],
    "META-INF/manifest.xml": xml(
      `<manifest:manifest ${ns}><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.presentation"/>` +
        `<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
    ),
    "styles.xml": xml(
      `<office:document-styles ${ns}><office:styles/><office:automatic-styles>` +
        `<style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="15.75cm" style:print-orientation="landscape"/></style:page-layout>` +
        `</office:automatic-styles><office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles></office:document-styles>`,
    ),
    "content.xml": xml(
      `<office:document-content ${ns}><office:automatic-styles>` +
        `<style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties presentation:transition-type="automatic" presentation:duration="PT00H00M0${seconds}S" presentation:transition-speed="fast" smil:type="fade" smil:subtype="crossfade"/></style:style>` +
        `<style:style style:name="P1" style:family="paragraph"><style:text-properties fo:font-size="44pt"/></style:style>` +
        `</office:automatic-styles><office:body><office:presentation>${pages}</office:presentation></office:body></office:document-content>`,
    ),
  });
}
