import { createBoundedSet, type BoundedSet } from "@renderer/lib/utils";
import { assetThumbUrl, assetThumbVersion, assetUrl } from "@shared/urls";
import type { AssetKind } from "@shared/constants";
import type { MediaAsset } from "@shared/types/media";

/**
 * Thumbnail urls that answered 404, shared by every library tile and schedule
 * row.
 *
 * This was per-tile state, and the grid is virtualized: scrolling a tile out
 * of view unmounted it and threw the record away, so a `.gif` or `.webp` with
 * no generated thumbnail asked for — and missed — the same url again on every
 * single pass through the folder. Keyed by url, which already embeds the
 * file's size+mtime, so editing a file clears its entry for free.
 */
export const failedThumbUrls = createBoundedSet(2_000);

/**
 * What an asset's thumbnail should try to display, given what has already
 * failed.
 *
 * The chain matters for images. Main prefers the OS thumbnailer, which is
 * absent on Linux and declines the occasional file; its in-process fallback
 * (`nativeImage.createFromPath`) only decodes PNG and JPEG dependably, so a
 * `.gif`, `.webp` or `.bmp` can end up with no thumbnail at all. Those used to
 * render fine, because the tile pointed straight at the file — falling back to
 * the full-size image keeps that true instead of quietly downgrading them to
 * an icon. A video gets no such fallback: not mounting a decoder per tile is
 * the entire point of the change.
 *
 * `null` means "no picture" — the caller paints its kind's icon.
 */
export function resolveThumbUrl({
  asset,
  deckThumbUrl,
  failed,
  kind,
}: {
  asset: MediaAsset;
  deckThumbUrl: string | null;
  failed: BoundedSet;
  kind: AssetKind;
}): string | null {
  // A deck's own slide is authoritative and never goes through the generated
  // thumbnail cache; null while the deck hasn't been converted yet, which
  // correctly falls through to the PPT icon.
  if (kind === "ppt") {
    return deckThumbUrl !== null && !failed.has(deckThumbUrl) ? deckThumbUrl : null;
  }
  if (kind === "audio") return null;

  const candidates =
    kind === "image"
      ? [assetThumbUrl(asset.id, assetThumbVersion(asset)), assetUrl(asset.id)]
      : [assetThumbUrl(asset.id, assetThumbVersion(asset))];
  return candidates.find((url) => !failed.has(url)) ?? null;
}
