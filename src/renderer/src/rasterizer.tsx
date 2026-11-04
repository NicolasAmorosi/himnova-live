// The LEGACY build, deliberately: pdf.js's modern bundle uses JS built-ins
// (e.g. Uint8Array.prototype.toHex) that Electron 36's Chromium doesn't have
// yet, and it fails at runtime with an unhelpful "n.toHex is not a function".
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

/**
 * Offscreen PDF painter. This window has no UI and no domain logic: main hands
 * it one task at a time — read a PDF's page sizes, or draw one page — with a
 * `worship://raster/<taskId>` URL for the file, and it answers with the sizes
 * or the encoded bytes. Main serves them; nothing is written anywhere.
 *
 * It lives in the renderer (not a Node worker) because drawing needs a real
 * Canvas2D and Chromium already has one — see src/main/slides/rasterizer.ts for
 * why the native-canvas alternative was rejected.
 */
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type Task = { id: string; docKey: string; url: string } & (
  | { op: "open"; targetWidth: number }
  | { op: "render"; page: number; width: number; thumb: boolean; format: "webp" | "png"; quality: number }
);

/** Documents kept open, most recent last: a deck's pages are asked for one by
 *  one, and parsing the file again for each would be most of the cost. */
const MAX_OPEN_DOCS = 3;
const docs = new Map<string, Promise<PDFDocumentProxy>>();

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;

function openDoc(docKey: string, url: string): Promise<PDFDocumentProxy> {
  const open = docs.get(docKey);
  if (open) {
    docs.delete(docKey);
    docs.set(docKey, open);
    return open;
  }
  const loading = (async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Couldn't read the PDF (${response.status})`);
    return pdfjs.getDocument({
      data: new Uint8Array(await response.arrayBuffer()),
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
      // If a PDF ever turns up whose missing font is NOT one of the base 14,
      // the deterministic fix is shipping `pdfjs-dist/standard_fonts/` (816 KB)
      // and pointing `standardFontDataUrl` at it; that also needs `connect-src`
      // in rasterizer.html widened, which is why it is not the default here.
      useSystemFonts: true,
    }).promise;
  })();
  docs.set(docKey, loading);
  loading.catch(() => {
    if (docs.get(docKey) === loading) docs.delete(docKey);
  });
  for (const [key, doc] of docs) {
    if (docs.size <= MAX_OPEN_DOCS) break;
    docs.delete(key);
    // Releases the worker's copy and every page's resources.
    void doc.then((d) => d.loadingTask.destroy(), () => undefined);
  }
  return loading;
}

/** The page's size fitted into a `width` SQUARE, not just a width: a PDF page
 *  can be portrait (a real one here: 72 pages at 841×594 with `/Rotate 90`),
 *  and scaling it by width alone drew it 1920×2485 to be shown letterboxed at
 *  ~834 px wide on a 16:9 projector. A thumbnail is never clamped up. */
function viewportOf(page: PDFPageProxy, width: number, thumb: boolean) {
  const base = page.getViewport({ scale: 1 });
  const fit = Math.min(width / base.width, width / base.height);
  return page.getViewport({ scale: thumb ? fit : Math.min(MAX_SCALE, Math.max(MIN_SCALE, fit)) });
}

async function run(task: Task): Promise<unknown> {
  const doc = await openDoc(task.docKey, task.url);
  if (task.op === "open") {
    const pages = [];
    for (let index = 1; index <= doc.numPages; index += 1) {
      const viewport = viewportOf(await doc.getPage(index), task.targetWidth, false);
      pages.push({ widthPx: Math.round(viewport.width), heightPx: Math.round(viewport.height) });
    }
    return { pages };
  }

  const page = await doc.getPage(task.page);
  try {
    const viewport = viewportOf(page, task.width, task.thumb);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Couldn't create the 2D context");
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, `image/${task.format}`, task.quality));
    if (!blob) throw new Error("Couldn't encode the slide image");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    // pdf.js leaks aggressively without this on long documents.
    page.cleanup();
  }
}

window.worship.on("raster:task", (payload) => {
  const task = payload as Task;
  void run(task).then(
    (result) => window.worship.invoke("raster:reply", { id: task.id, result }),
    (error: unknown) =>
      window.worship.invoke("raster:reply", {
        id: task.id,
        error: {
          // An encrypted PDF is the one failure here that the operator can act
          // on, and the only way to tell it apart is pdf.js's exception name —
          // its message is prose. Reported as a plain tag rather than a
          // `SlideErrorCode` so this window stays ignorant of main's error
          // vocabulary; main maps it.
          kind: error instanceof Error && error.name === "PasswordException" ? "password" : "unknown",
          message: error instanceof Error ? error.message : String(error),
        },
      }),
  );
});
