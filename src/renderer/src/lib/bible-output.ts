import { assetUrl } from "@shared/urls";
import type { BibleStyle } from "@shared/types/bible-style";
import type { BibleParallel, ProjectionOutputKind } from "@shared/types/projection";

/** What a `bible` output is made of, before it is dressed — the pieces the
 *  control window knows and the projector does not. */
export type BibleContent = {
  text: string;
  reference: string;
  /** The version's own name, or `null` when there is none to print (the
   *  version was deleted, or the verse came from a program row whose FK is
   *  now null). */
  versionLabel: string | null;
  /** The same passage in the parallel version; absent or `null` is none. */
  parallel?: BibleParallel | null | undefined;
};

/**
 * A verse as the projection window wants it.
 *
 * Shared by `selectOutput` (what actually goes on the projector) and
 * `usePreviewOutput` (the PREVIEW monitor), which is the whole point and the
 * same rule `timerOutputFor` follows: two independent translations of the same
 * verse would be two chances for a monitor to show something the projector
 * does not.
 *
 * Resolving the background's `assetId` into a url is this layer's job, exactly
 * like a video's, an image's or a scene's: the projection window turns no id
 * into anything.
 */
export function bibleOutputFor(
  content: BibleContent,
  style: BibleStyle,
): Extract<ProjectionOutputKind, { kind: "bible" }> {
  const { background } = style;
  return {
    kind: "bible",
    text: content.text,
    reference: content.reference,
    versionLabel: content.versionLabel,
    parallel: content.parallel ?? null,
    style,
    // `assetId === 0` is an image background that has not been given a file
    // yet — the same sentinel, and the same reason, as `timerOutputFor`: a url
    // for it would 404 and paint the browser's broken-image glyph over the
    // verse. No url is what "nothing" looks like.
    backgroundUrl: background.kind === "image" && background.assetId > 0 ? assetUrl(background.assetId) : null,
  };
}
