/**
 * An overlay plate: a saved, reusable piece of text (and, for a bug, an image)
 * drawn ON TOP of whatever is projected, without replacing it.
 *
 * The operator builds «Pastor Juan Pérez» once and shows it every Sunday after
 * that. Several plates may be up at once, but at most ONE PER KIND AND ONE PER
 * EDGE (`platesCollide`), and BLACK, LOGO and "nothing live" cover every plate.
 *
 * The style reuses the pieces `SceneStyle` was written to share (a
 * `SceneTextStyle` per line, a font family, a background), and adds what only
 * a plate has: where it sits, how far from the edge, and how it comes and goes.
 */
import { DEFAULT_SHADOW_STRENGTH, type SceneBackground, type SceneTextStyle } from "./scene-style";

/** Closed on purpose: each kind is a different layout on the projector. A
 *  banner is the one kind that spans the stage. */
export const PLATE_KINDS = ["lower-third", "banner", "bug"] as const;
export type PlateKind = (typeof PLATE_KINDS)[number];

export const PLATE_POSITIONS = [
  "top-left",
  "top-center",
  "top-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;
export type PlatePosition = (typeof PLATE_POSITIONS)[number];

export type PlateEdge = "top" | "bottom";

export const plateEdge = (position: PlatePosition): PlateEdge => (position.startsWith("top") ? "top" : "bottom");

/**
 * Two plates that cannot be up together: putting one up takes the other down.
 * The same kind, as from the start, and — decided 2026-09-24 — the same EDGE:
 * two plates on one edge either landed on each other (a lower third and a bug
 * in one corner) or stacked one above the other (anything over a banner), and
 * both looked wrong from the seats. One edge, one plate.
 */
export function platesCollide(
  a: { kind: PlateKind; position: PlatePosition },
  b: { kind: PlateKind; position: PlatePosition },
): boolean {
  return a.kind === b.kind || plateEdge(a.position) === plateEdge(b.position);
}

/** Which positions each kind may take. A lower third lives at the bottom by
 *  definition; a bug is a corner mark; a banner spans the stage, so its
 *  position is an edge plus where its text sits inside the band. */
export const PLATE_KIND_POSITIONS: Record<PlateKind, readonly PlatePosition[]> = {
  "lower-third": ["bottom-left", "bottom-center", "bottom-right"],
  banner: PLATE_POSITIONS,
  bug: ["top-left", "top-right", "bottom-left", "bottom-right"],
};

export const PLATE_ANIMATION_STYLES = ["none", "fade", "slide"] as const;
export type PlateAnimationStyle = (typeof PLATE_ANIMATION_STYLES)[number];

/** How a plate comes in and goes out. Its own type rather than a
 *  `TransitionSpec`: "slide" means nothing to a scene change, and a crossfade
 *  means nothing to a plate, which has no "previous picture" to fade from. */
export type PlateAnimation = { style: PlateAnimationStyle; durationMs: number };

/** A plate's band never holds a picture: an image background is a scene's,
 *  and a bug's image is its CONTENT (`Plate.imageAssetId`), not its dressing. */
export type PlateBackground = Exclude<SceneBackground, { kind: "image" }>;

export const PLATE_STYLE_VERSION = 1;

export type PlateStyle = {
  version: typeof PLATE_STYLE_VERSION;
  background: PlateBackground;
  /** 0..1, of the band only — the text stays fully opaque. A separate knob
   *  because `ColorField` only speaks `#rrggbb`. */
  backgroundOpacity: number;
  /** Same meaning as `SceneStyle.fontFamily`: `null` is the app's Noto Sans. */
  fontFamily: string | null;
  title: SceneTextStyle;
  subtitle: SceneTextStyle;
  /** Distance from the stage edges, in `cqw` like every size on the stage. */
  marginCqw: number;
  /** How round the band's corners are, and a bug's image's, in `cqw`. `0` is
   *  square; past half the band's height the browser clamps it to a pill. */
  cornerRadiusCqw: number;
  /** A bug's image: its width, and its own opacity (a translucent watermark
   *  is the ordinary case). Ignored by a lower third. */
  image: { sizeCqw: number; opacity: number };
  animation: PlateAnimation;
  /** A banner's text running across the band in a seamless loop, at
   *  `speedCqw` stage-widths-hundredths per second — a width unit, so the
   *  pace is the same on the projector and on a 240px monitor. Ignored by
   *  every other kind, and by a banner with `enabled: false`. */
  ticker: { enabled: boolean; speedCqw: number };
  /** Takes the plate down on its own `afterMs` after it went up, so a name
   *  nobody remembered to hide does not stay on the screen for the sermon.
   *  Counted only while the room can SEE it: BLACK, LOGO and "nothing live"
   *  pause the count (decided 2026-09-24). Behaviour rather than dressing,
   *  but it lives here for the reason `ticker` does — per plate, and a new
   *  field of `style_json` needs no migration. */
  autoHide: { enabled: boolean; afterMs: number };
};

export type Plate = {
  id: number;
  /** What the operator called it. Shown in the list, never projected. */
  name: string;
  kind: PlateKind;
  position: PlatePosition;
  /** The main line. `null` hides it. */
  title: string | null;
  /** The second line (a lower third's role, a bug's second word; on a
   *  running banner it follows the title on the same line). `null`
   *  hides it. */
  subtitle: string | null;
  /** A bug's image, from the library. Always `null` for a lower third. */
  imageAssetId: number | null;
  style: PlateStyle;
};

export type PlateUpsert = Omit<Plate, "id"> & { id?: number };

/** A saved program that still references a plate — the same shape and the
 *  same job as `UtilitySceneUsage`. */
export type PlateUsage = {
  programId: number;
  programName: string;
  itemCount: number;
};

/** Default CONTENT values out of the 2026-10-22 identity sheet, the same category as
 *  `DEFAULT_SCENE_STYLE`'s — see the note at the top of `scene-style.ts`. */
export const DEFAULT_PLATE_STYLE: PlateStyle = {
  version: PLATE_STYLE_VERSION,
  // The sheet's dark background.
  background: { kind: "solid", color: "#162231" },
  backgroundOpacity: 0.85,
  fontFamily: null,
  title: { sizeCqw: 3, color: "#ffffff", weight: 600, shadow: false, shadowStrength: DEFAULT_SHADOW_STRENGTH },
  // The dark theme's secundario.
  subtitle: { sizeCqw: 2, color: "#8299b2", weight: 400, shadow: false, shadowStrength: DEFAULT_SHADOW_STRENGTH },
  marginCqw: 3,
  cornerRadiusCqw: 0,
  image: { sizeCqw: 8, opacity: 1 },
  animation: { style: "fade", durationMs: 300 },
  ticker: { enabled: false, speedCqw: 10 },
  autoHide: { enabled: false, afterMs: 10_000 },
};

/** A bug starts out as a bare mark: no band behind it — so its text carries a
 *  shadow, or white on a white slide is no text at all. */
export const DEFAULT_BUG_STYLE: PlateStyle = {
  ...DEFAULT_PLATE_STYLE,
  backgroundOpacity: 0,
  title: { ...DEFAULT_PLATE_STYLE.title, shadow: true },
  subtitle: { ...DEFAULT_PLATE_STYLE.subtitle, shadow: true },
};
