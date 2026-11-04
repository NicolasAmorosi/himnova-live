import { assetUrl } from "@shared/urls";
import type { ProjectionOutputKind } from "@shared/types/projection";
import type { ResolvedSong, SongTheme } from "@shared/types/song";

/**
 * One slide of a song as the projection window wants it — shared by
 * `selectOutput`, the PREVIEW monitor and every drawn tile, so none of them
 * can dress a slide differently from the room. `slideIndex` is 1-based and
 * clamped: a song edited live may have lost the slide it was on.
 */
export function songOutputFor(
  song: ResolvedSong,
  slideIndex: number,
  theme: SongTheme,
  sizeCqw: number,
): Extract<ProjectionOutputKind, { kind: "song" }> {
  const index = Math.min(Math.max(1, slideIndex), Math.max(1, song.slides.length));
  const { background } = theme;
  return {
    kind: "song",
    songId: song.id,
    title: song.title,
    lines: song.slides[index - 1]?.lines ?? [],
    theme,
    // `timerOutputFor`'s sentinel: an image background without a file yet.
    backgroundUrl: background.kind === "image" && background.assetId > 0 ? assetUrl(background.assetId) : null,
    sizeCqw,
  };
}
