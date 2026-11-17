import { gunzipSync } from "node:zlib";
import { emfToSvg, isEmf } from "./metafile/emf";
import { wmfToSvg, isWmf } from "./metafile/wmf";

/**
 * Windows metafiles (EMF, WMF — clip art, pasted Visio/Excel objects, OLE previews) as a standalone
 * SVG document, which Chromium draws: it decodes neither format. The SVG's `viewBox` is the
 * metafile's own frame with `preserveAspectRatio="none"`, so stretching it over the picture's frame
 * is what PowerPoint does with the metafile. Bitmaps inside are `data:` URIs — an SVG used as an
 * image may not fetch anything.
 *
 * Written from [MS-EMF] and [MS-WMF]; the players are in `metafile/`. `null` when the bytes are not
 * a metafile this can read. Never throws: a picture this cannot draw must cost that picture, not
 * the slide.
 *
 * The format is sniffed, not taken from `_kind`: `.emz`/`.wmz` are the same files gzipped, and the
 * corpus has a `.wmf` part that is an EMF and an `.emf` part that is a PNG — PowerPoint draws all
 * of them, so a mislabelled raster comes back wrapped in an SVG too.
 */
/** Past this a gzipped metafile is refused, not inflated: this runs in main, per request and per window, and 255 KB
 *  of `.emz` inflated to 256 MB in 126 ms (2026-11-15 audit, S3). Real clip art and pasted objects are KB to a few MB. */
export const MAX_METAFILE_BYTES = 64 * 1024 * 1024;

export function metafileToSvg(bytes: Uint8Array, _kind: "emf" | "wmf"): string | null {
  try {
    const data = bytes[0] === 0x1f && bytes[1] === 0x8b ? new Uint8Array(gunzipSync(bytes, { maxOutputLength: MAX_METAFILE_BYTES })) : bytes;
    if (isEmf(data)) return emfToSvg(data);
    if (isWmf(data)) return wmfToSvg(data);
    return rasterAsSvg(data);
  } catch {
    return null;
  }
}

/** A raster in a metafile's clothes. Its own size does not matter: the frame stretches it. */
function rasterAsSvg(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 4)).toString("latin1");
  const type =
    head === "\x89PNG" ? "png" : head.startsWith("\xff\xd8") ? "jpeg" : head.startsWith("GIF8") ? "gif" : head.startsWith("BM") ? "bmp" : null;
  if (!type) return null;
  const href = `data:image/${type};base64,${Buffer.from(bytes).toString("base64")}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" preserveAspectRatio="none">` +
    `<image width="1" height="1" preserveAspectRatio="none" href="${href}"/></svg>`
  );
}
