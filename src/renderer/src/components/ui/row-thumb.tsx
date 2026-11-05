import type { ReactNode } from "react";
import { cn } from "@renderer/lib/utils";
import { Badge, type BadgeVariant } from "./badge";
import { Icon, type IconName } from "./icon";

type RowThumbProps = {
  className?: string;
  /** Shown, on the content type's tint, when there is no picture. */
  icon: IconName;
  /** Replaces the picture entirely (a slide drawn from its model). */
  media?: ReactNode;
  /** The picture failed to load — the owner swaps in its next candidate. */
  onImageError?: () => void;
  src?: string | null;
  tone: BadgeVariant;
};

/**
 * A list row's small 16:9 picture — the schedule's counterpart of
 * `ThumbTile`'s media area. Black behind a picture, like the projector; with
 * none, the same tinted icon the row used to carry as its badge, in a box of
 * the same size so every row keeps one height.
 */
export function RowThumb({ className, icon, media, onImageError, src, tone }: RowThumbProps) {
  const picture = media !== undefined || Boolean(src);
  return (
    <span
      className={cn(
        "relative flex aspect-video w-16 shrink-0 items-center justify-center overflow-hidden rounded-sm",
        picture && "bg-black",
        className,
      )}
    >
      {media ??
        (src ? (
          <img alt="" className="size-full object-contain" loading="lazy" onError={onImageError} src={src} />
        ) : (
          <Badge className="size-full justify-center rounded-none p-0" variant={tone}>
            <Icon className="size-4" name={icon} />
          </Badge>
        ))}
      {/* Over a picture the kind still has to read — a video's frame and a
          photo look alike — so the icon stays, in the corner, on a scrim that
          reads over any picture. */}
      {picture ? (
        <span className="absolute bottom-0 left-0 flex rounded-tr-sm bg-black/70 p-0.5 text-white">
          <Icon className="size-3" name={icon} />
        </span>
      ) : null}
    </span>
  );
}
