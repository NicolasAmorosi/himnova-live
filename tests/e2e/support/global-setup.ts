import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { FIXTURES_DIR, FIXTURE_VERSION, ffmpegBinary, findSoffice } from "./paths";
import { buildPdf } from "./pdf";
import { buildLegacyPpt } from "../../fixtures/legacy-ppt";

/**
 * Generates every file the suite projects, once, with the FFmpeg the app
 * itself ships — so the suite needs nothing checked in and runs the same on
 * the church's Windows PC as on a Mac. Regenerated only when
 * `FIXTURE_VERSION` changes.
 *
 * The hymn `.pptx` needs LibreOffice: it is exported from a flat ODF with a
 * visible transition, because LibreOffice only writes `advTm` when a slide has
 * one (`.claude/knowledge/libreoffice-pptx-export-drops-advtm-without-a-transition-effect.md`).
 * Without LibreOffice the deck tests that need it skip; the PDF ones still run.
 * A `.pptx` is drawn from its model, never converted, so what a conversion does
 * (its queue, cancelling it) is tested on two `.odp` exported the same way.
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
  if (!fs.existsSync(ffmpeg)) throw new Error(`No bundled FFmpeg at ${ffmpeg} — run \`npm run fetch:ffmpeg\``);

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
  // first and a speaker icon PowerPoint hides — read with no LibreOffice at
  // all (`ppt-binary.ts`). The second slide fades in slowly and the third
  // enters by vertical random bars, both as the file says.
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

  const soffice = findSoffice();
  if (soffice) {
    const toDeck = (name: string, fodpXml: string, format = "pptx") => {
      const fodp = out(`${name}.fodp`);
      fs.writeFileSync(fodp, fodpXml);
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), "worship-e2e-soffice-"));
      try {
        execFileSync(soffice, [
          `-env:UserInstallation=${pathToFileURL(profile).href}`,
          ...["--headless", "--convert-to", format, "--outdir", FIXTURES_DIR, fodp],
        ]);
      } finally {
        fs.rmSync(profile, { recursive: true, force: true });
        fs.rmSync(fodp, { force: true });
      }
    };
    toDeck("hymn", hymnFodp(3, 2));
    // The same hymn with a WMA as its music: the deck's soundtrack, which only
    // the media engine plays, and whose clock the slides follow («synced»).
    embedDeckMusic(out("hymn.pptx"), out("song.wma"), out("hymn-wma.pptx"));
    toDeck("converted", hymnFodp(3, 2), "odp");
    toDeck("queued", hymnFodp(4, 2), "odp");

    // A WMV embedded in a slide — what PowerPoint 2007 decks carry and Chromium
    // cannot play (`media/deck-clips.ts` converts it in place). LibreOffice only
    // EXPORTS a video as an external link, so the clip is embedded afterwards
    // the way PowerPoint stores one: a part under `ppt/media/`, an internal
    // relationship, and its content type.
    const wmv = out("slide-clip.wmv");
    run(...picture("640x360", 4), "-c:v", "wmv2", wmv);
    toDeck("clipdeck", clipDeckFodp(wmv));
    embedExternalVideo(out("clipdeck.pptx"), wmv);
    fs.rmSync(wmv, { force: true });
  }

  fs.writeFileSync(stamp, String(FIXTURE_VERSION));
}

/** Rewrites every external link to `videoPath` in a `.pptx` into an embedded
 *  `ppt/media/` part. */
function embedExternalVideo(pptxPath: string, videoPath: string): void {
  const files = unzipSync(fs.readFileSync(pptxPath));
  const external = pathToFileURL(videoPath).href;
  files["ppt/media/media1.wmv"] = fs.readFileSync(videoPath);
  for (const name of Object.keys(files)) {
    if (!name.startsWith("ppt/slides/_rels/")) continue;
    const xml = strFromU8(files[name]!)
      .replaceAll(`Target="${external}" TargetMode="External"`, 'Target="../media/media1.wmv"');
    files[name] = strToU8(xml);
  }
  const types = strFromU8(files["[Content_Types].xml"]!);
  if (!types.includes('Extension="wmv"')) {
    files["[Content_Types].xml"] = strToU8(
      types.replace("<Default ", '<Default Extension="wmv" ContentType="video/x-ms-wmv"/><Default '),
    );
  }
  fs.writeFileSync(pptxPath, zipSync(files));
}

/** `pptxPath` with `musicPath` on its first slide as a sound that plays across
 *  every slide (`numSld`), which is how PowerPoint stores a deck's music. */
function embedDeckMusic(pptxPath: string, musicPath: string, outPath: string): void {
  const files = unzipSync(fs.readFileSync(pptxPath));
  files["ppt/media/music1.wma"] = fs.readFileSync(musicPath);
  const pic =
    '<p:pic><p:nvPicPr><p:cNvPr id="99" name="Music"/><p:cNvPicPr/><p:nvPr><a:audioFile r:link="rIdMusic"/></p:nvPr></p:nvPicPr><p:blipFill/><p:spPr/></p:pic>';
  const timing =
    '<p:timing><p:tnLst><p:par><p:cTn id="1"><p:childTnLst><p:audio><p:cMediaNode numSld="999"><p:cTn id="2"/><p:tgtEl><p:spTgt spid="99"/></p:tgtEl></p:cMediaNode></p:audio></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>';
  const slide = strFromU8(files["ppt/slides/slide1.xml"]!);
  files["ppt/slides/slide1.xml"] = strToU8(slide.replace("</p:spTree>", `${pic}</p:spTree>`).replace("</p:sld>", `${timing}</p:sld>`));
  const rels = strFromU8(files["ppt/slides/_rels/slide1.xml.rels"]!);
  files["ppt/slides/_rels/slide1.xml.rels"] = strToU8(
    rels.replace(
      "</Relationships>",
      '<Relationship Id="rIdMusic" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio" Target="../media/music1.wma"/></Relationships>',
    ),
  );
  const types = strFromU8(files["[Content_Types].xml"]!);
  files["[Content_Types].xml"] = strToU8(types.replace("<Default ", '<Default Extension="wma" ContentType="audio/x-ms-wma"/><Default '));
  fs.writeFileSync(outPath, zipSync(files));
}

/** One slide holding a video frame that points at `videoPath`. */
function clipDeckFodp(videoPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.presentation">
 <office:automatic-styles>
  <style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="15.75cm" style:print-orientation="landscape"/></style:page-layout>
 </office:automatic-styles>
 <office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles>
 <office:body><office:presentation>
   <draw:page draw:name="page1" draw:master-page-name="Default">
    <draw:frame svg:x="4cm" svg:y="2cm" svg:width="20cm" svg:height="11.25cm"><draw:plugin xlink:href="${pathToFileURL(videoPath).href}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad" draw:mime-type="application/vnd.sun.star.media"/></draw:frame>
   </draw:page>
 </office:presentation></office:body>
</office:document>`;
}

/** `slides` pages that each advance after `seconds`, with a fade so the
 *  `.pptx` export keeps the timing. */
function hymnFodp(slides: number, seconds: number): string {
  const pages = Array.from(
    { length: slides },
    (_, i) => `
   <draw:page draw:name="page${i + 1}" draw:style-name="dp1" draw:master-page-name="Default">
    <draw:frame svg:x="2cm" svg:y="5cm" svg:width="24cm" svg:height="6cm"><draw:text-box><text:p text:style-name="P1">Estrofa ${i + 1}</text:p></draw:text-box></draw:frame>
   </draw:page>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:smil="urn:oasis:names:tc:opendocument:xmlns:smil-compatible:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.presentation">
 <office:styles/>
 <office:automatic-styles>
  <style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="15.75cm" style:print-orientation="landscape"/></style:page-layout>
  <style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties presentation:transition-type="automatic" presentation:duration="PT00H00M0${seconds}S" presentation:transition-speed="fast" smil:type="fade" smil:subtype="crossfade"/></style:style>
  <style:style style:name="P1" style:family="paragraph"><style:text-properties fo:font-size="44pt"/></style:style>
 </office:automatic-styles>
 <office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles>
 <office:body><office:presentation>${pages}
 </office:presentation></office:body>
</office:document>`;
}
