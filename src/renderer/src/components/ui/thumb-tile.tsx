import { useState, type DragEvent, type ReactNode } from "react";
import { cn, createBoundedSet } from "@renderer/lib/utils";
import { Icon, type IconName } from "./icon";
import { LinearLoader, Skeleton } from "./linear-loader";
import { ProgressBar } from "./progress-bar";

/**
 * Image urls that have finished decoding at least once in this session,
 * shared by every tile.
 *
 * "Has this picture loaded?" was per-tile state, and a virtualized grid
 * unmounts a tile the moment it scrolls away — so coming back showed the
 * skeleton again over an image the browser already has in cache, on every
 * pass. The url is the identity (it embeds the file's size+mtime), so an
 * edited file is a different url and correctly skeletons again.
 */
const decodedSrcs = createBoundedSet(2_000);

/** The corner number's box. A text-only tile reserves this same box at the
 *  start of its first line, so a long verse flows around the number instead
 *  of running underneath it. */
const INDEX_BADGE = "rounded-sm px-1 text-[0.625rem] leading-4 font-semibold";

type ThumbTileProps = {
  className?: string;
  draggable?: boolean;
  /** Fallback shown when there is no `src` and no `media`. */
  icon?: IconName;
  /** 1-based corner number, as EasyWorship numbers its slides. */
  index?: number;
  label?: string;
  /** Replaces the image area entirely (a <video> poster, a text slide…). */
  media?: ReactNode;
  /** Absolutely positioned extras over the media area (a "missing" badge…). */
  overlay?: ReactNode;
  /** Marks the tile that is on the projector right now. */
  live?: boolean;
  /** "What goes in the media area isn't known yet" — a deck whose conversion
   *  status hasn't come back, or one still converting. Paints a skeleton over
   *  the media area instead of the `icon` fallback, so an empty tile reads as
   *  "loading" rather than as "nothing here". A tile whose `src` simply hasn't
   *  decoded yet gets the same skeleton without asking: that is tracked
   *  internally. */
  loading?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onDragStart?: (e: DragEvent<HTMLButtonElement>) => void;
  /** The thumbnail failed to load (an evicted slide cache, a moved file). */
  onImageError?: () => void;
  /** A background conversion is in progress for this tile (a deck being
   *  pre-warmed) — pinned to the bottom edge of the media area. `null` for
   *  indeterminate (still queued / total unknown), `undefined` for no bar. */
  progress?: number | null | undefined;
  selected?: boolean;
  src?: string | null;
  /** Set by `VirtualGrid`'s roving tabindex: exactly one tile in a virtualized
   *  grid is 0 and the rest are -1, so one Tab enters the grid instead of
   *  tabbing through hundreds of tiles. Left undefined outside such a grid,
   *  where the default (a naturally focusable button) is what you want. */
  tabIndex?: number | undefined;
  /** Text-only tile (a scripture verse, a plain-text slide). */
  text?: string;
  title?: string;
};

/**
 * The single tile used by every grid in the app — deck slides, media library
 * entries and scripture verses. Anything that needs a different visual goes in
 * through `media`, so no feature re-implements the frame, the selection ring
 * or the on-air ring.
 */
export function ThumbTile({
  className,
  draggable,
  icon = "file",
  index,
  label,
  live = false,
  loading = false,
  media,
  onClick,
  onDoubleClick,
  onDragStart,
  onImageError,
  overlay,
  progress,
  selected = false,
  src,
  tabIndex,
  text,
  title,
}: ThumbTileProps) {
  // Tracked by URL, not as a boolean: a tile is reused across items (a
  // virtualized grid recycles nothing, but a changing `src` on the same tile
  // is normal), and comparing against the URL that actually finished loading
  // is what keeps the skeleton from disappearing one frame early on the next
  // picture.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  // A src that fails is finished, not still decoding. Without this the
  // skeleton stayed up forever on a tile whose image 404s and whose owner has
  // no further fallback to swap in — the tile could only be rescued from
  // outside, by `AssetTile` changing `src` out from under it.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const decoding =
    media === undefined &&
    src != null &&
    loadedSrc !== src &&
    failedSrc !== src &&
    !decodedSrcs.has(src);
  const busy = loading || decoding;

  return (
    <button
      aria-busy={busy || undefined}
      aria-current={selected || undefined}
      className={cn(
        // `h-full` + `w-full` make the tile fill whatever box its container
        // gives it — a fixed cell in `VirtualGrid`, or the stretched cell of a
        // plain `SlideGrid`.
        //
        // `w-full` is NOT redundant: a <button> is sized shrink-to-fit by the
        // UA even when it is `display: flex`, so as soon as the tile stopped
        // being a direct grid item (it is wrapped in `VirtualGrid`'s
        // `role="listitem"` div, which is what carries the grid cell) its
        // width collapsed to the width of its own label text — 35px for a deck
        // named "001", 267px for a long filename, tiles overlapping each
        // other. A grid item gets stretched for free and hid this for as long
        // as the tile was one.
        "group flex h-full w-full cursor-pointer flex-col overflow-hidden rounded-md border bg-card text-left transition-colors focus-ring-inset",
        selected ? "border-accent ring-2 ring-accent" : "border-border hover:border-border-light",
        live && !selected && "border-on-air ring-1 ring-on-air",
        className,
      )}
      draggable={draggable}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onDragStart={onDragStart}
      tabIndex={tabIndex}
      title={title ?? label}
      type="button"
    >
      {/* `aspect-video` sets the shape when the tile sizes itself; `grow` +
          `min-h-0` are what make it exact when the tile is given a height.
          `min-h-0` in particular is load-bearing: a flex item's automatic
          minimum size is its CONTENT's size, so without it a large image
          pushes this box past its own aspect ratio and every tile ends up a
          different height depending on the picture inside it. */}
      <span className="relative flex aspect-video w-full min-h-0 grow items-center justify-center overflow-hidden bg-black">
        {media ??
          (src ? (
            <img
              alt={label ?? ""}
              className="size-full object-contain"
              loading="lazy"
              onError={() => {
                setFailedSrc(src);
                onImageError?.();
              }}
              onLoad={() => {
                decodedSrcs.add(src);
                setLoadedSrc(src);
              }}
              src={src}
            />
          ) : text !== undefined ? (
            // Top-aligned, so the reserved box sits exactly under the corner
            // number: `-ml-1` lands it on `left-0.5`, `pt-0.5` on `top-0.5`, and
            // `-mb-1` keeps it shorter than one line so only the first line
            // wraps around it. No bottom padding: `line-clamp` clips at the
            // padding box, so any padding there shows half of the sixth line.
            <span className="line-clamp-5 w-full self-start px-1.5 pt-0.5 text-2xs leading-tight text-white/90">
              {index !== undefined ? (
                <span aria-hidden="true" className={cn(INDEX_BADGE, "invisible float-left -mb-1 -ml-1 mr-1")}>
                  {index}
                </span>
              ) : null}
              {text}
            </span>
          ) : (
            <Icon className="size-6 text-subtle" name={icon} />
          ))}
        {index !== undefined ? (
          <span className={cn(INDEX_BADGE, "absolute top-0.5 left-0.5 bg-background/80 text-foreground")}>
            {index}
          </span>
        ) : null}
        {live ? (
          <span className="absolute top-0.5 right-0.5 size-2 rounded-full bg-on-air shadow-surface" />
        ) : null}
        {/* Over the media area, never in its place: positioning it means the
            tile's geometry is identical whether or not anything is loading,
            which is the whole point of showing a placeholder of the right
            shape. Sits under `overlay` on purpose — a "missing" badge must
            still win. */}
        {busy ? <Skeleton className="absolute inset-0 rounded-none" /> : null}
        {overlay}
        {progress !== undefined ? (
          <span className="absolute inset-x-0 bottom-0">
            {progress === null ? (
              <LinearLoader className="rounded-none bg-black/40" />
            ) : (
              <ProgressBar className="h-0.5 rounded-none bg-black/40" value={progress} />
            )}
          </span>
        ) : null}
      </span>
      {label ? (
        // Exactly `THUMB_TILE_LABEL_PX` tall (`thumb-tile.geometry.ts`), and
        // never squeezed by the media area above it — see that module for why
        // this height is fixed rather than left to the line box.
        <span className="h-6 shrink-0 truncate px-1.5 text-xs leading-6 text-muted-foreground group-hover:text-foreground">
          {label}
        </span>
      ) : null}
    </button>
  );
}
