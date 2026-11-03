// The LEGACY build, deliberately: pdf.js's modern bundle uses JS built-ins
// (e.g. Uint8Array.prototype.toHex) that Electron 36's Chromium doesn't have
// yet, and it fails at runtime with an unhelpful "n.toHex is not a function".
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

/**
 * Offscreen slide rasterizer. This window has no UI and no domain logic: main
 * hands it a `worship://raster/<jobId>` URL, it renders every PDF page to a
 * canvas at the requested width and hands the encoded bytes back one page at a
 * time. Main does all the file writing.
 *
 * It lives in the renderer (not a Node worker) because rasterizing needs a real
 * Canvas2D and Chromium already has one — see src/main/slides/rasterizer.ts for
 * why the native-canvas alternative was rejected.
 */
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type StartMessage = {
  jobId: string;
  url: string;
  targetWidth: number;
  thumbWidth: number;
  format: "webp" | "png";
  quality: number;
};

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function encode(
  canvas: HTMLCanvasElement,
  format: "webp" | "png",
  quality: number,
): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, `image/${format}`, quality),
  );
  if (!blob) throw new Error("Couldn't encode the slide image");
  return new Uint8Array(await blob.arrayBuffer());
}

function drawScaled(source: HTMLCanvasElement, targetWidth: number): HTMLCanvasElement {
  const ratio = targetWidth / source.width;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * ratio));
  canvas.height = Math.max(1, Math.round(source.height * ratio));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't create the thumbnail's 2D context");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function run(message: StartMessage): Promise<void> {
  const { jobId, url, targetWidth, thumbWidth, format, quality } = message;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't read the PDF (${response.status})`);
  const data = new Uint8Array(await response.arrayBuffer());

  const loadingTask = pdfjs.getDocument({
    data,
    // Was `false`, on the reasoning that every PDF reaching here embedded its
    // fonts. A PDF the operator imported does not have to, and a non-embedded
    // standard font (Helvetica, Times, Courier — the base 14) then renders
    // NOTHING: pdf.js reports
    // `UnknownErrorException: Ensure that the standardFontDataUrl API
    // parameter is provided` and drops the glyphs. Measured against a
    // hand-built PDF with non-embedded Helvetica: `false` warns and loses the
    // text, `true` resolves it from the OS with no warning at all. Chromium is
    // the one part of the stack guaranteed to have those faces, so letting it
    // answer is both the smaller change and the one with no build step.
    //
    // It changes nothing for a deck we converted ourselves — an embedded font
    // is always used from its embedded data, whatever this says. If a PDF ever
    // turns up whose missing font is NOT one of the base 14, the deterministic
    // fix is shipping `pdfjs-dist/standard_fonts/` (816 KB) and pointing
    // `standardFontDataUrl` at it; that also needs `connect-src` in
    // rasterizer.html widened, which is why it is not the default here.
    useSystemFonts: true,
  });
  const doc = await loadingTask.promise;

  try {
    const total = doc.numPages;

    for (let index = 1; index <= total; index += 1) {
      const page = await doc.getPage(index);
      try {
        const baseViewport = page.getViewport({ scale: 1 });
        // Fit into a `targetWidth` SQUARE, not just a target width. Every
        // PowerPoint/Impress slide is landscape (4:3, 16:9), so `width` alone
        // always bound them and this changes nothing for any existing deck —
        // no cache to invalidate. A PDF page can be portrait, though (a real
        // one here: 72 pages at 841×594 with `/Rotate 90`), and scaling a
        // portrait page by width alone renders it 1920×2485 to be shown
        // letterboxed at roughly 834 px wide on a 16:9 projector — 2,3× the
        // pixels anyone can see, paid for in cache on every page.
        const scale = clamp(
          Math.min(targetWidth / baseViewport.width, targetWidth / baseViewport.height),
          MIN_SCALE,
          MAX_SCALE,
        );
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement("canvas");
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Couldn't create the 2D context");

        await page.render({ canvas, canvasContext: ctx, viewport }).promise;

        const full = await encode(canvas, format, quality);
        const thumb = await encode(drawScaled(canvas, thumbWidth), format, 0.7);

        await window.worship.invoke("raster:page", {
          jobId,
          index,
          total,
          widthPx: canvas.width,
          heightPx: canvas.height,
          data: full,
          thumbData: thumb,
        });
      } finally {
        // pdf.js leaks aggressively without this on long documents.
        page.cleanup();
      }
    }

    await window.worship.invoke("raster:done", { jobId, total });
  } finally {
    // Releases the worker and every page's resources; pdf.js leaks
    // aggressively on long documents otherwise.
    await loadingTask.destroy();
  }
}

window.worship.on("raster:start", (payload) => {
  const message = payload as StartMessage;
  void run(message).catch(async (error: unknown) => {
    await window.worship.invoke("raster:error", {
      jobId: message.jobId,
      // An encrypted PDF is the one failure here that the operator can act on,
      // and the only way to tell it apart is pdf.js's exception name — its
      // message is prose. Reported as a plain tag rather than a `SlideErrorCode`
      // so this window stays ignorant of main's error vocabulary; main maps it.
      kind: error instanceof Error && error.name === "PasswordException" ? "password" : "unknown",
      message: error instanceof Error ? error.message : String(error),
    });
  });
});
