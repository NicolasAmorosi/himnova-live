import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@renderer/lib/utils";
import { sceneTextCss as textStyle } from "./scene-text";
import { StageImage } from "./stage-image";
import { bibleReferenceLines, type BibleStyle } from "@shared/types/bible-style";
import { cssFontFamily, cssSceneBackground, type SceneVerticalAlign } from "@shared/types/scene-style";
import type { ProjectionOutput } from "@shared/types/projection";

export type BibleOutput = Extract<ProjectionOutput, { kind: "bible" }>;

const VERTICAL_ALIGN: Record<SceneVerticalAlign, string> = {
  top: "justify-start",
  middle: "justify-center",
  bottom: "justify-end",
};

/**
 * The margin the text block keeps from the top and bottom of the stage, as a
 * fraction of the stage's WIDTH.
 *
 * Always applied, not only when the verse is aligned to an edge — it is the
 * vertical counterpart of `maxWidthCqw`, and it is what the auto-fit measures
 * against. Without it a shrunk verse fits the frame EXACTLY, which on a
 * projector with any overscan at all means the first and last lines are cut in
 * half; measured in the editor's own preview, a 12 cqw verse settled at a size
 * whose block was 252 px tall inside a 252 px stage. 8 % of the height top and
 * bottom leaves the 84 % that broadcast has called the title-safe area for
 * sixty years.
 *
 * `cqw` and not `cqh`, which would read more naturally: `OutputView`'s root is
 * an `inline-size` container, so it has no block axis to query and a `cqh`
 * there silently resolves against the small VIEWPORT instead — which on a
 * 240 px confidence monitor inside a maximised control window is an enormous
 * number. See the note on `SlideVideo`'s own overlay in `output-view.tsx`,
 * which hit exactly this. 4.5 cqw is 8 % of the height of a 16:9 stage.
 */
const EDGE_GUTTER_CQW = 4.5;

/** The gutter between a verse and its parallel version, out of `maxWidthCqw`. */
const PARALLEL_GAP_CQW = 4;

/** How many halvings the search below does. Seven puts the answer within
 *  1/128th of the range — far finer than a reader can tell apart, and seven
 *  reflows of one paragraph is work nobody will ever perceive either. */
const FIT_STEPS = 7;

/**
 * How much overflow is not overflow.
 *
 * `clientHeight`, `scrollHeight` and their inline counterparts are integers
 * rounded off a fractional layout, so a block that fills its box exactly still
 * reports a pixel too many often enough to matter — measured at
 * `line-height: 1.2` and 6 cqw, where a 48.6 px block read as 48 against a
 * 49 px content. One pixel is the rounding, not a fit failure, and treating it
 * as one costs the verse its whole size.
 */
const FIT_TOLERANCE_PX = 1;

/**
 * The height the block is actually allowed to take: the stage's content box.
 *
 * This is `max-h-full` resolved into a number — the same percentage the block
 * itself is capped by, which is why the two cannot disagree. Read once per
 * search rather than per probe: it is a function of the STAGE, and no font
 * size can change it.
 */
function availableHeight(stage: HTMLElement): number {
  const { paddingBottom, paddingTop } = getComputedStyle(stage);
  return stage.clientHeight - parseFloat(paddingTop) - parseFloat(paddingBottom);
}

/**
 * The largest size at or below `max` at which the whole block still fits, or
 * `min` if even that does not.
 *
 * Measures the BLOCK and not the paragraph, deliberately: the reference line
 * is inside the same bounded box and the verse may not push it off the stage
 * to make room for itself.
 *
 * But it measures the block against the SPACE, not against the block's own
 * overflow. `scrollHeight > clientHeight` reads as "too tall" only while the
 * block is at its `max-h-full` ceiling; below it the block is content-sized,
 * and the comparison degenerates into "is any ink outside its own line boxes"
 * — which a `line-height` below the font's content area (≈1.36 for Noto Sans,
 * and the operator can pick 0.8) makes permanently true AT EVERY SIZE. That is
 * what collapsed a verse to `minSizeCqw` and made all four sliders in
 * «Verses» look dead: measured at 0.8 leading, the block reported 20 px of
 * content in an 18 px box at 1.5 cqw and 58 in 56 at 12 cqw, so the search
 * never found a size that fit and always returned its floor.
 *
 * The width leg stays a comparison against the block, and correctly so: the
 * block's width is fixed at `maxWidthCqw`, so there `scrollWidth` really does
 * mean "a word is wider than the column".
 *
 * The font size is written straight onto the element rather than round-tripped
 * through React: a measurement needs the browser to have laid the text out
 * already, and a state update per probe would be seven renders (and seven
 * frames of visibly resizing text) to answer one question. The caller commits
 * the ANSWER to state, so the value React then writes is the value already on
 * the element and nothing flashes.
 */
function measureFittedSize(
  block: HTMLElement,
  stage: HTMLElement,
  texts: readonly HTMLElement[],
  max: number,
  min: number,
): number {
  const available = availableHeight(stage);
  // Every text at the SAME size: a verse in two languages is one block with one
  // size, never two columns shrunk on their own.
  const setSize = (size: string) => {
    for (const text of texts) text.style.fontSize = size;
  };
  const fits = (cqw: number): boolean => {
    setSize(`${cqw}cqw`);
    return (
      block.scrollHeight <= available + FIT_TOLERANCE_PX &&
      block.scrollWidth <= block.clientWidth + FIT_TOLERANCE_PX &&
      // A word wider than its own column spills into the next one without
      // widening the block; for one column this is the line above.
      texts.every((text) => text.scrollWidth <= text.clientWidth + FIT_TOLERANCE_PX)
    );
  };

  if (fits(max)) return max;

  let low = min;
  let high = max;
  for (let step = 0; step < FIT_STEPS; step += 1) {
    const mid = (low + high) / 2;
    if (fits(mid)) low = mid;
    else high = mid;
  }
  // Rounded so a re-measure after an imperceptible container change cannot
  // produce a value that differs in the twelfth decimal and re-render forever.
  const fitted = Math.round(low * 100) / 100;
  setSize(`${fitted}cqw`);
  return fitted;
}

/**
 * The verse's size, shrunk to fit when the operator asked for that.
 *
 * `useLayoutEffect` rather than `useEffect`: the measurement happens before
 * the browser paints, so the congregation never sees one frame of the verse at
 * its unshrunk size. `key` is the whole reason this is one string rather than
 * a dependency array — everything that can change how the text lays out (the
 * text itself, the reference beneath it, the font, the leading, the width) has
 * to re-open the question, and listing fifteen dependencies is how one of them
 * gets forgotten.
 *
 * The `ResizeObserver` watches the STAGE, not the block. Watching the block
 * would be a feedback loop by construction: the observer's own callback
 * changes the font size, which resizes the block, which fires the observer.
 * The stage only changes when the window does.
 */
function useFittedTextSize(
  enabled: boolean,
  max: number,
  min: number,
  key: string,
): {
  blockRef: React.RefObject<HTMLDivElement | null>;
  sizeCqw: number;
  /** The verse's paragraph, and the parallel version's beside it — by column. */
  textRefs: React.RefObject<(HTMLParagraphElement | null)[]>;
} {
  const blockRef = useRef<HTMLDivElement>(null);
  const textRefs = useRef<(HTMLParagraphElement | null)[]>([]);
  const [sizeCqw, setSizeCqw] = useState(max);

  useLayoutEffect(() => {
    const block = blockRef.current;
    const texts = textRefs.current.filter((text) => text !== null);
    const stage = block?.parentElement;
    if (!block || texts.length === 0 || !stage) return;

    // A floor at or above the ceiling is not a configuration error worth
    // refusing to save (see `normalizeAutoFit`); it simply means there is no
    // room to shrink into, which is the same outcome as the feature being off.
    if (!enabled || min >= max) {
      for (const text of texts) text.style.fontSize = "";
      setSizeCqw(max);
      return;
    }

    const measure = () => setSizeCqw(measureFittedSize(block, stage, texts, max, min));
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [enabled, max, min, key]);

  return { blockRef, sizeCqw, textRefs };
}

/**
 * A scripture verse, drawn from a `BibleStyle`.
 *
 * Rendered by the projector AND by both confidence monitors, through
 * `OutputView`, which is why every measurement in it is in `cqw`: the operator
 * has to be reading the same line breaks, at the same relative size, as the
 * congregation. The auto-fit obeys the same rule — it is a function of the
 * stage's own proportions, and both stages are 16:9, so the size it settles on
 * is the same number in a 240px monitor and at 4K.
 *
 * Structurally a sibling of `TimerScene` and deliberately not a
 * generalisation of it: a countdown is one short glyph run that never wraps
 * and a verse is a paragraph, so almost nothing they do to their text is the
 * same thing. What they DO share — the background, the typeface, the vertical
 * alignment — they share as code (`cssSceneBackground`, `cssFontFamily`),
 * not as a common component with two personalities.
 */
export function BibleScene({
  onImageError,
  output,
}: {
  onImageError?: ((url: string) => void) | undefined;
  output: BibleOutput;
}) {
  const { backgroundUrl, parallel, reference, style, text, versionLabel } = output;
  const referenceLines = bibleReferenceLines(reference, versionLabel, style);
  const parallelLines = parallel ? bibleReferenceLines(parallel.reference, parallel.versionLabel, style) : [];

  const { blockRef, sizeCqw, textRefs } = useFittedTextSize(
    style.autoFit.enabled,
    style.text.sizeCqw,
    style.autoFit.minSizeCqw,
    // Everything that moves a line break or changes the height of the block.
    // `versionLabel` is in via `referenceLines`.
    JSON.stringify([text, referenceLines, parallel?.text, parallelLines, style]),
  );
  const blockStyle = {
    fontFamily: cssFontFamily(style.fontFamily),
    lineHeight: style.lineHeight,
    textAlign: style.textAlign,
    width: `${style.maxWidthCqw}cqw`,
  };
  const verseStyle = { ...textStyle(style.text), fontSize: `${sizeCqw}cqw` };
  const columnRef = (column: number) => (el: HTMLParagraphElement | null) => {
    textRefs.current[column] = el;
  };
  const above = style.referencePosition === "above";
  const below = style.referencePosition === "below";

  const background = cssSceneBackground(style.background);
  // Narrowed once, rather than re-tested inside the JSX: `background.kind`
  // does not narrow through a boolean.
  const imageBackground = style.background.kind === "image" ? style.background : null;

  return (
    <>
      {background ? <div className="absolute inset-0" style={{ background }} /> : null}

      {imageBackground && backgroundUrl ? (
        <StageImage
          className="absolute inset-0 size-full"
          onError={() => onImageError?.(backgroundUrl)}
          src={backgroundUrl}
          style={{ objectFit: imageBackground.fit }}
        />
      ) : null}

      <div
        className={cn("absolute inset-0 flex flex-col items-center", VERTICAL_ALIGN[style.verticalAlign])}
        style={{ paddingBlock: `${EDGE_GUTTER_CQW}cqw` }}
      >
        {/* `max-h-full min-h-0 overflow-hidden` is not defensive styling: it
            is what keeps a verse that has already shrunk to its floor, or one
            the operator sized past the frame with the auto-fit off, from
            painting over the edge. It is NOT what the auto-fit measures
            against — see `measureFittedSize`, which reads the stage's own
            content box, because this block is content-sized until it reaches
            that ceiling. */}
        {parallel ? (
          // Two languages side by side: two equal columns, filled row by row —
          // the references, the verses, the references — so both verses start
          // on the same line whatever either reference wraps to, and at the
          // one size measured for the whole block.
          <div
            className="grid max-h-full min-h-0 grid-cols-2 items-start gap-y-[1.2cqw] overflow-hidden"
            data-bible-parallel=""
            ref={blockRef}
            style={{ ...blockStyle, columnGap: `${PARALLEL_GAP_CQW}cqw` }}
          >
            {above ? <ReferenceLines lines={referenceLines} style={style} /> : null}
            {above ? <ReferenceLines lines={parallelLines} style={style} /> : null}
            <p dir="auto" ref={columnRef(0)} style={verseStyle}>
              {text}
            </p>
            <p dir="auto" ref={columnRef(1)} style={verseStyle}>
              {parallel.text}
            </p>
            {below ? <ReferenceLines lines={referenceLines} style={style} /> : null}
            {below ? <ReferenceLines lines={parallelLines} style={style} /> : null}
          </div>
        ) : (
          <div
            className="flex max-h-full min-h-0 flex-col gap-[1.2cqw] overflow-hidden"
            ref={blockRef}
            style={blockStyle}
          >
            {above ? <ReferenceLines lines={referenceLines} style={style} /> : null}
            {/* `dir="auto"`, like a song's lines: an Arabic or Hebrew version
                reads right to left, punctuation included. */}
            <p dir="auto" ref={columnRef(0)} style={verseStyle}>
              {text}
            </p>
            {below ? <ReferenceLines lines={referenceLines} style={style} /> : null}
          </div>
        )}
      </div>
    </>
  );
}

/** The reference, and the version label when it has a line of its own. Never
 *  an empty `<p>`: a hidden reference must cost nothing at all, and an empty
 *  paragraph still claims its own leading and the block's `gap` — which would
 *  shift a middle-aligned verse off centre for a line nobody can see. */
function ReferenceLines({ lines, style }: { lines: readonly string[]; style: BibleStyle }) {
  if (lines.length === 0) return null;
  return (
    <div>
      {lines.map((line) => (
        <p key={line} style={textStyle(style.reference)}>
          {line}
        </p>
      ))}
    </div>
  );
}
