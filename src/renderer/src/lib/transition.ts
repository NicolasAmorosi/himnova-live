/**
 * Everything the renderer needs to DRAW a `TransitionSpec` — the stacking and
 * the keyframes on one side, the operator's two dropdowns on the other.
 *
 * Extracted from `output-view.tsx` when a second thing started fading: a time
 * scene crossing into its end state (`TimerScene`). Both are the same picture
 * replacing another picture, so they share one set of keyframes and one set
 * of options; two copies would be two chances for «Crossfade» to mean
 * something slightly different depending on where it was chosen.
 */
import type { CSSProperties } from "react";
import type { SelectOption } from "@renderer/components/ui";
import type { MessageKey, Translate } from "@renderer/lib/i18n/i18n-provider";
import {
  TRANSITION_STYLES,
  type SlideTransitionStyle,
  type TransitionStyle,
} from "@shared/types/transition";

/** Grace added to a transition's own duration before the outgoing layer is
 *  dropped without having reported `animationend`. Generous on purpose: it is
 *  a safety net for an animation that never ran at all, not a second clock
 *  racing the one that did. */
export const LEAVE_FALLBACK_MARGIN_MS = 400;

/** A layer's part in an in-flight transition. "steady" means no transition is
 *  currently in flight for this element — nothing else is competing with it
 *  for the same pixels, so its z-order doesn't matter and its opacity is
 *  whatever it rests at. */
export type LayerRole = "steady" | "entering" | "leaving";

const LAYER_Z: Record<LayerRole, number> = { leaving: 0, steady: 1, entering: 2 };

const FADE_KEYFRAMES: Record<Exclude<TransitionStyle, "none">, Record<"entering" | "leaving", string>> = {
  crossfade: { entering: "wa-scene-fade-in", leaving: "wa-scene-fade-out" },
  "fade-through-black": { entering: "wa-scene-black-then-in", leaving: "wa-scene-out-then-black" },
};

/** The leaving side of a crossfade whose incoming side covers the whole stage:
 *  it stays exactly as it is until the picture on top has fully arrived. */
const HOLD_KEYFRAME = "wa-scene-hold";

/** What two stacked scene layers can run between them: a scene fade the
 *  operator chose, or the way a slide of a deck enters as its file says
 *  (`SlideTransition`) — random bars only ever arrive that second way. */
export type LayerTransition = {
  style: TransitionStyle | SlideTransitionStyle;
  durationMs: number;
};

/** Whether this transition has anything to animate at all. Generic so the
 *  narrowing survives on whatever the caller passed — a `SceneTransition`
 *  stays a `SceneTransition`, `epoch` and all. */
export function isAnimatable<T extends LayerTransition>(
  transition: T,
): transition is T & { style: Exclude<T["style"], "none"> } {
  return transition.style !== "none" && transition.durationMs > 0;
}

export function isRandomBars(transition: LayerTransition): boolean {
  return transition.style === "random-bars-horizontal" || transition.style === "random-bars-vertical";
}

/** How many bars a random-bars transition cuts the stage into. PowerPoint's
 *  are thin; this many reads as the same effect at any size. */
export const RANDOM_BAR_COUNT = 60;

/**
 * When each bar of a random-bars transition appears, in ms from its start,
 * by bar index. A seeded shuffle rather than `Math.random`: the projector and
 * the LIVE monitor draw the same entry in two windows, and must draw the same
 * bars in the same order.
 */
export function randomBarDelays(seed: number, durationMs: number): number[] {
  // mulberry32 — tiny and good enough to look random.
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const order = Array.from({ length: RANDOM_BAR_COUNT }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const delays: number[] = [];
  order.forEach((bar, rank) => {
    delays[bar] = Math.round((rank * durationMs) / RANDOM_BAR_COUNT);
  });
  return delays;
}

/**
 * Inline style for one side of a transition — a scene layer, the persistent
 * video, or a time scene's text block. `role === "steady"` (or a
 * non-animatable transition) means nothing is in flight: opacity is
 * `restOpacity` directly, no keyframe, no z-index competition. Otherwise it
 * drives the CSS `animation` shorthand (not `transition`): a `transition`
 * property doesn't run when the very same commit that mounts an element also
 * gives it its target value, so an `animation` — which always plays from its
 * own keyframes regardless of when it starts — is what actually fades the
 * very first frame.
 *
 * `held` pauses the animation at its start without changing anything else —
 * or, for a cut, keeps the entering side out of sight.
 *
 * `incomingCovers` says the entering side paints every pixel of the stage —
 * the projector's scenes, which are whole pictures stacked on each other. A
 * crossfade then holds the leaving side at full opacity under it instead of
 * fading it out: fading both lets the black behind them through, a 25% dip at
 * the midpoint (measured on the projector: an image at luma 116 into a video
 * at 131 bottomed out at 95). A time scene's text blocks are transparent over
 * a shared background, so they leave it false and both of them fade.
 */
export function transitionStyle(
  role: LayerRole,
  transition: LayerTransition,
  restOpacity: number,
  held = false,
  incomingCovers = false,
): CSSProperties {
  if (role === "steady" || !isAnimatable(transition)) {
    // A cut held for a video's first frame: what enters stays out of sight until then.
    return { zIndex: LAYER_Z[role], opacity: held && role === "entering" ? 0 : restOpacity };
  }
  // Random bars: the entering side reveals itself bar by bar (`SceneLayer`),
  // so the layer itself stays put; the leaving side holds under it for the
  // whole length, which is also what reports the end through `animationend`.
  if (isRandomBars(transition) && role === "entering") {
    return { zIndex: LAYER_Z[role], opacity: restOpacity };
  }
  const style = transition.style;
  return {
    zIndex: LAYER_Z[role],
    animationName:
      isRandomBars(transition) || (role === "leaving" && incomingCovers && style === "crossfade")
        ? HOLD_KEYFRAME
        : FADE_KEYFRAMES[style === "fade-through-black" ? "fade-through-black" : "crossfade"][
            role === "entering" ? "entering" : "leaving"
          ],
    animationDuration: `${transition.durationMs}ms`,
    animationTimingFunction: "ease-in-out",
    // Holds the keyframe's start value until the animation actually starts
    // and its end value once it finishes, instead of snapping back to the
    // plain `opacity` this element would otherwise have.
    animationFillMode: "both",
    // Held at its first keyframe until what is entering has something to
    // show — see the video hold in `OutputView`. `fill-mode: both` is what
    // makes a paused start meaningful: the entering side rests at its `from`
    // opacity and the leaving one at full.
    animationPlayState: held ? "paused" : "running",
  };
}

/* -------------------------------------------------------------------------
 * The operator's two dropdowns
 *
 * Shared by Settings → Projection and by a scene's «When the countdown ends»,
 * because the promise made to the operator is literally "the same options the
 * screen has".
 * ---------------------------------------------------------------------- */

const TRANSITION_STYLE_LABEL_KEYS: Record<TransitionStyle, MessageKey> = {
  none: "transition.styles.none",
  crossfade: "transition.styles.crossfade",
  "fade-through-black": "transition.styles.fadeThroughBlack",
};

/** The three durations on offer. A closed list rather than a free number:
 *  nobody can name the difference between 280 ms and 300 ms, and a text field
 *  is one typo away from a five-second fade in the middle of a service. */
const TRANSITION_DURATION_OPTIONS = [150, 300, 600] as const;

export function transitionStyleOptions(t: Translate): SelectOption[] {
  return TRANSITION_STYLES.map((style) => ({ label: t(TRANSITION_STYLE_LABEL_KEYS[style]), value: style }));
}

/** With `current` off the list (a value written by an older build or by the
 *  starter look's 400 ms slide), it is offered too, in order: a select whose
 *  value matches no option shows an empty box. */
export function transitionDurationOptions(t: Translate, current: number): SelectOption[] {
  const known = (ms: number): ms is (typeof TRANSITION_DURATION_OPTIONS)[number] =>
    (TRANSITION_DURATION_OPTIONS as readonly number[]).includes(ms);
  const durations = known(current) ? TRANSITION_DURATION_OPTIONS : [...TRANSITION_DURATION_OPTIONS, current].sort((a, b) => a - b);
  return durations.map((ms) => ({
    label: known(ms) ? t(`transition.durations.${ms}`) : t("transition.durations.other", { ms: String(ms) }),
    value: String(ms),
  }));
}
