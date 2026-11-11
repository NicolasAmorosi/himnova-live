/**
 * The look of a scene the app GENERATES, as opposed to one it reads out of a
 * file.
 *
 * Deliberately not a timer type. The same structure is meant to dress:
 *   - the utility scenes (countdown, clock, stopwatch) — today;
 *   - the Overlays plates;
 *   - the Bible/text projection settings, hardcoded in `output-view.tsx` today
 *     and listed as debt in `docs/knowledge/07-roadmap-and-debt.md`.
 *
 * Which is why it holds no strings: a scene's own text fields belong to the
 * scene (a plate has a title and a subtitle, a countdown has a title and a
 * message), and only their STYLE is shared.
 *
 * ## On the hex values below
 *
 * `CLAUDE.md` forbids a hardcoded colour in a component, and this does not
 * break that rule: these are default *content* values, stored in a row and
 * editable by the operator — the same category as a program's name, not the
 * same category as a Tailwind class. Every default is a literal from the
 * 2026-10-22 identity sheet (see `docs/knowledge/06-ui-and-theme.md`), so a
 * scene nobody customizes still looks like the rest of the app. They were the
 * ALPS palette's until 2026-10-22; a scene saved before keeps its own colours,
 * since defaults only dress what is created from now on.
 */

import type { TransitionSpec } from "./transition";

export const GRADIENT_DIRECTIONS = ["to-bottom", "to-right", "to-bottom-right", "radial"] as const;
export type GradientDirection = (typeof GRADIENT_DIRECTIONS)[number];

export const BACKGROUND_FITS = ["cover", "contain"] as const;
export type BackgroundFit = (typeof BACKGROUND_FITS)[number];

export const SCENE_VERTICAL_ALIGNS = ["top", "middle", "bottom"] as const;
export type SceneVerticalAlign = (typeof SCENE_VERTICAL_ALIGNS)[number];

/** The weights `@fontsource-variable/noto-sans` actually ships, and a sane
 *  subset for any system font. A closed list, so a row can never carry a
 *  weight the renderer would round to something else. */
export const SCENE_FONT_WEIGHTS = [300, 400, 600, 700, 900] as const;
export type SceneFontWeight = (typeof SCENE_FONT_WEIGHTS)[number];

/**
 * A video background is deliberately absent HERE: element churn in the
 * projection window is what produces `PIPELINE_ERROR_DECODE (-12909)` (see
 * `.claude/knowledge/worship-protocol-range-and-video-lifecycle.md`), so it got
 * its own lifecycle instead of a fourth variant — for songs only
 * (`SongBackground`, drawn through the output's `songVideo`).
 *
 * `assetId` and not a url: a scene is stored, and a `worship://asset/<id>` url
 * is derived from it by `selectOutput` exactly like a video's or an image's.
 */
export type SceneBackground =
  | { kind: "solid"; color: string }
  | { kind: "gradient"; from: string; to: string; direction: GradientDirection }
  | { kind: "image"; assetId: number; fit: BackgroundFit };

export type SceneTextStyle = {
  /** Percent of the output's WIDTH (`cqw`), never px: the projector and a
   *  240px confidence monitor render the same markup and must read the same.
   *  Same rule the Bible verse already follows. */
  sizeCqw: number;
  color: string;
  weight: SceneFontWeight;
  /** A drop shadow, so the text stays legible over a photo background. */
  shadow: boolean;
  /** How dark and how wide that shadow is, `STYLE_SHADOW_MIN..MAX` — see
   *  `sceneTextCss`. Kept while `shadow` is off, so switching it back on
   *  brings the strength the operator had chosen. */
  shadowStrength: number;
};

/** The one shadow every generated scene drew before its strength was a knob.
 *  Every default uses it, and a row stored before the knob existed reads it
 *  back — so no scene changes look the first time this build opens it. */
export const DEFAULT_SHADOW_STRENGTH = 0.55;

/** ProPresenter's "color triggers": the number changes colour as it approaches
 *  zero. `null` means it never changes. Only meaningful for a countdown. */
export type SceneTriggers = {
  /** Switch to `warningColor` when this much time or less is left. */
  warningAtMs: number;
  warningColor: string;
  /** From zero on (including overrun). */
  endColor: string;
};

/**
 * What a countdown turns into once it passes zero.
 *
 * Countdown-only, like `triggers`, and for the same reason it lives here
 * rather than in `TimerConfig`: reaching zero changes how the scene LOOKS, and
 * every one of these is a pure function of the mark the projector is already
 * holding — so the swap happens in the leaf that draws it, with no push at the
 * instant zero passes (see `TimerScene`).
 *
 * `message` is its own `SceneTextStyle` rather than a reuse of the scene's:
 * the line that says "10 minutes to go" and the one that says "Welcome!"
 * are read at different moments, from the same seats, and almost never want
 * the same size. `hideValue`/`hideTitle` are opt-in and off by default — a
 * countdown that erases itself at zero is a deliberate look, never something
 * the app decides on the operator's behalf.
 */
export type SceneEnd = {
  message: SceneTextStyle;
  /** From zero on (including overrun), drop the big number. */
  hideValue: boolean;
  /** From zero on, drop the line above it. */
  hideTitle: boolean;
  /**
   * How the scene crosses from how it reads while counting to how it reads
   * once it has run out — the same three fades the projector uses between
   * scenes (`TransitionSpec`), because from the seats it is the same kind of
   * change.
   *
   * It fades the whole text block at once rather than line by line, and that
   * is not an implementation detail: hiding the number re-centres everything
   * left, so three independent fades would still end in one jump — at the
   * exact moment the operator asked for the opposite. See `TimerScene`.
   *
   * Like the rest of `SceneEnd` it is a pure function of the mark the
   * projector already holds, so crossing zero still costs no push.
   */
  transition: TransitionSpec;
};

export const SCENE_STYLE_VERSION = 1;

/**
 * `version` is stored with the row. A future change of shape is a branch in
 * the normalizer (`scene-validators.ts`), not a schema migration — which is
 * the whole reason the style is a JSON column instead of thirty columns.
 */
export type SceneStyle = {
  version: typeof SCENE_STYLE_VERSION;
  background: SceneBackground;
  /** `null` = the app's own Noto Sans. Anything else is the family name of a
   *  font installed on this machine (`queryLocalFonts()`), which is why it is
   *  only ever rendered through `cssFontFamily()` below and falls back to Noto
   *  Sans when the font is gone. */
  fontFamily: string | null;
  verticalAlign: SceneVerticalAlign;
  /** The big number. */
  value: SceneTextStyle;
  /** The line above it. */
  title: SceneTextStyle;
  /** The line below it. */
  message: SceneTextStyle;
  /** How the scene reads once a countdown has run out. */
  end: SceneEnd;
  triggers: SceneTriggers | null;
};

/** Shared by `message` and by the end message's own default — see
 *  `SceneEnd.message`. */
const DEFAULT_MESSAGE_STYLE: SceneTextStyle = {
  sizeCqw: 4.5,
  color: "#eef2f6",
  weight: 400,
  shadow: true,
  shadowStrength: DEFAULT_SHADOW_STRENGTH,
};

/** "none" on purpose, and it is the same decision `SceneEnd.message` made:
 *  every scene dressed before this field existed cut straight into its end
 *  state, and it has to keep doing exactly that until the operator asks for a
 *  fade. The duration rides along at the projector's own "normal", so turning
 *  the style on lands somewhere sensible instead of at zero. */
const DEFAULT_END_TRANSITION: TransitionSpec = { style: "none", durationMs: 300 };

export const DEFAULT_SCENE_STYLE: SceneStyle = {
  version: SCENE_STYLE_VERSION,
  // The sheet's dark background — the same hue the dark theme uses for `bg-background`.
  background: { kind: "solid", color: "#162231" },
  fontFamily: null,
  verticalAlign: "middle",
  value: { sizeCqw: 20, color: "#ffffff", weight: 300, shadow: true, shadowStrength: DEFAULT_SHADOW_STRENGTH },
  // The dark theme's secundario, the light blue of the sheet.
  title: { sizeCqw: 4, color: "#8299b2", weight: 600, shadow: true, shadowStrength: DEFAULT_SHADOW_STRENGTH },
  message: DEFAULT_MESSAGE_STYLE,
  // The end message starts out looking exactly like the message it replaces,
  // so turning the group on changes nothing until the operator asks it to.
  end: {
    message: DEFAULT_MESSAGE_STYLE,
    hideValue: false,
    hideTitle: false,
    transition: DEFAULT_END_TRANSITION,
  },
  triggers: null,
};

/** The app's own stack, as the fallback tail of every `font-family` this
 *  builds. Mirrors `--font-sans` in `globals.css`; duplicated as a literal
 *  because the projection window sets this through an inline style, where a
 *  CSS variable inside a font-family list would not resolve per-family. */
const FONT_FALLBACK = '"Noto Sans Variable", "Noto Sans", Helvetica, Arial, sans-serif';

/** Characters that have no business in a font family name and every business
 *  in a CSS injection attempt. A name is rejected outright rather than
 *  sanitized: a font whose name contains a quote is not a font this app needs
 *  to support, and silently rendering a different family than the row names
 *  would be worse than falling back. */
const UNSAFE_FONT_NAME = /["'\\;{}<>]/;

/** How long a family name is allowed to be. No real one comes close; the cap
 *  exists so a row can never hold a novel that ends up in an inline style. */
const MAX_FONT_NAME_LENGTH = 100;

/**
 * Whether a stored family name is one this app is willing to render.
 *
 * Exported so the row validator and `cssFontFamily` below can never disagree:
 * a name main rejects on write must be the same name the renderer would have
 * silently dropped anyway. `null` (the app's own Noto Sans) is always fine.
 */
export function isSafeFontFamily(fontFamily: string | null): boolean {
  if (fontFamily === null) return true;
  const name = fontFamily.trim();
  return name.length > 0 && name.length <= MAX_FONT_NAME_LENGTH && !UNSAFE_FONT_NAME.test(name);
}

/**
 * A `font-family` value safe to hand to an inline style.
 *
 * React assigns inline styles through the CSSOM, so a malformed value is
 * dropped rather than able to escape into another property — but the family
 * name comes from `queryLocalFonts()` on the operator's machine and is stored
 * in a row that outlives the session, and "it cannot break out today" is not a
 * reason to store something unquotable. The stored name is always quoted, and
 * the app's own stack is always the tail, so a font that has since been
 * uninstalled degrades to Noto Sans instead of to the browser default.
 */
export function cssFontFamily(fontFamily: string | null): string {
  if (fontFamily === null || !isSafeFontFamily(fontFamily)) return FONT_FALLBACK;
  return `"${fontFamily.trim()}", ${FONT_FALLBACK}`;
}

const GRADIENT_SHAPES: Record<GradientDirection, string> = {
  "to-bottom": "linear-gradient(to bottom",
  "to-right": "linear-gradient(to right",
  "to-bottom-right": "linear-gradient(to bottom right",
  radial: "radial-gradient(circle at center",
};

/** The CSS `background` for a scene's non-image backgrounds. Image backgrounds
 *  are an `<img>` element instead (they need `object-fit` and an error path),
 *  so this returns `undefined` for them. */
export function cssSceneBackground(background: SceneBackground): string | undefined {
  switch (background.kind) {
    case "solid":
      return background.color;
    case "gradient":
      return `${GRADIENT_SHAPES[background.direction]}, ${background.from}, ${background.to})`;
    case "image":
      return undefined;
  }
}
