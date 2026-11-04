import type { ChartModel } from "./slide-chart";

/**
 * A slide of a deck as we draw it ourselves (`SlideView`), with no picture of
 * it anywhere: main reads the file (OOXML, a legacy binary, ODF) and resolves
 * everything a painter would otherwise have to look up — placeholder and
 * master inheritance, theme colours and fonts, preset geometry — so the
 * renderer only paints.
 *
 * Lengths are EMU (914 400 per inch, 12 700 per point) in the slide's own
 * space unless a field says otherwise; angles are degrees, clockwise. Colours
 * are resolved CSS colours. A picture or a font is named by its PART inside
 * the package (`ppt/media/image3.png`), never by a URL: the same model is drawn
 * by the app (`worship://`) and by the regression harness, each resolving
 * parts its own way.
 */
export type SlideModel = {
  width: number;
  height: number;
  background: Fill | null;
  elements: SlideElement[];
  /** The deck's embedded fonts (the same on every slide), registered by
   *  whoever draws the slide before its text is laid out. */
  fonts: EmbeddedFontRef[];
  /** Part of what this slide is drawn from (its own part, its layout or its
   *  master) is in the file but won't parse, so it is drawn without that part.
   *  Only the control window says so (a warning on its tile and over the
   *  monitors' label) — never the projector. Absent on a whole slide. */
  damaged?: true;
};

/** A font embedded in the deck: the face its text names, and the part that
 *  holds it (EOT, decoded by main). */
export type EmbeddedFontRef = { family: string; style: "regular" | "bold" | "italic" | "boldItalic"; part: string };

export type SlideElement = ShapeElement | PictureElement | GroupElement | TableElement | ChartElement;

/** Where an element sits. `x/y/w/h` are in its parent's space: the slide, or a
 *  group's child space (`GroupElement.childFrame`). */
export type Frame = { x: number; y: number; w: number; h: number; rot: number; flipH: boolean; flipV: boolean };

export type GradientStop = { pos: number; color: string };

export type Fill =
  | { kind: "solid"; color: string }
  /** `angle` is the direction the colours run, PowerPoint's `lin@ang`; `path`
   *  gradients radiate from `focus` (fractions of the box). */
  | { kind: "linear"; angle: number; scaled: boolean; stops: GradientStop[] }
  | { kind: "path"; shape: "circle" | "rect" | "shape"; focus: { l: number; t: number; r: number; b: number }; stops: GradientStop[] }
  | { kind: "image"; image: ImageRef; mode: "stretch" | "tile"; tile?: Tile }
  | { kind: "pattern"; preset: string; fg: string; bg: string }
  /** `useBgFill`: the slide's background shows through, placed on the SLIDE
   *  (a gradient or picture continues across the shape, not restarted in it). */
  | { kind: "background" };

/** A tiled picture: `size` is the picture's natural size (EMU, from its pixels
 *  and DPI), which `sx/sy` scale; `tx/ty` offset the tiles from `align`. */
export type Tile = { size: { w: number; h: number }; sx: number; sy: number; tx: number; ty: number; align: string; flip: string };

/** A picture from the package, with what PowerPoint does to it before it is
 *  laid out. `crop` and `fill` are fractions (`a:srcRect`, `a:fillRect`). */
export type ImageRef = {
  part: string;
  crop: Insets | null;
  fill: Insets | null;
  alpha: number;
  /** Colour effects baked into the bitmap's look: grayscale, duotone, … Kept
   *  as their own list so a painter can tell what it did not draw. */
  effects: ImageEffect[];
};

export type ImageEffect =
  | { kind: "grayscale" }
  | { kind: "duotone"; dark: string; light: string }
  | { kind: "lum"; bright: number; contrast: number }
  | { kind: "biLevel"; threshold: number }
  | { kind: "clrChange"; from: string; to: string };

export type Insets = { l: number; t: number; r: number; b: number };

export type Line = {
  fill: Fill | null;
  width: number;
  dash: number[] | null;
  cap: "flat" | "round" | "square";
  join: "round" | "bevel" | "miter";
  head: LineEnd | null;
  tail: LineEnd | null;
  compound: "sng" | "dbl" | "thickThin" | "thinThick" | "tri";
};

export type LineEnd = { type: "triangle" | "stealth" | "diamond" | "oval" | "arrow"; w: "sm" | "med" | "lg"; len: "sm" | "med" | "lg" };

export type Shadow = { color: string; blur: number; dist: number; dir: number; inner: boolean; sx: number; sy: number };

export type Effects = {
  shadow: Shadow | null;
  glow: { color: string; radius: number } | null;
  softEdge: number | null;
  reflection: { blur: number; startAlpha: number; endAlpha: number; endPos: number; dist: number } | null;
  /** `fillOverlay`: a second fill blended over the shape's own (a themed
   *  texture tinted by a gradient), not over what lies under the shape. */
  overlay: { fill: Fill; blend: "over" | "mult" | "screen" | "darken" | "lighten" } | null;
};

/** One subpath of a geometry, in the element's own box (0..w, 0..h, EMU), as
 *  an SVG path. `fill` is how the area is painted relative to the shape fill:
 *  OOXML lets a subpath be darker or lighter than the rest (a can's lid). */
export type GeometryPath = {
  d: string;
  fill: "norm" | "none" | "lighten" | "lightenLess" | "darken" | "darkenLess";
  stroke: boolean;
};

export type ShapeElement = {
  kind: "shape";
  frame: Frame;
  /** Empty for a shape that draws nothing of its own (a text box with no fill
   *  and no line still has its rectangle here, painted with neither). */
  paths: GeometryPath[];
  fill: Fill | null;
  line: Line | null;
  effects: Effects;
  /** The text rectangle of the geometry, in the element's own box. */
  textRect: Insets;
  text: TextBody | null;
};

export type PictureElement = {
  kind: "picture";
  frame: Frame;
  image: ImageRef;
  /** Painted under the picture (its transparent parts show it). */
  fill: Fill | null;
  /** A picture cropped to a shape (`prstGeom` other than a rectangle). */
  clip: GeometryPath[] | null;
  line: Line | null;
  effects: Effects;
};

export type GroupElement = {
  kind: "group";
  frame: Frame;
  /** The rectangle of the children's coordinate space that maps onto `frame`. */
  childFrame: { x: number; y: number; w: number; h: number };
  children: SlideElement[];
};

export type TableElement = {
  kind: "table";
  frame: Frame;
  /** The table style's background, under every cell. */
  background: Fill | null;
  columns: number[];
  rows: { height: number; cells: TableCell[] }[];
};

export type TableCell = {
  /** 0 for a cell merged into a neighbour (it is not drawn). */
  gridSpan: number;
  rowSpan: number;
  fill: Fill | null;
  borders: { l: Line | null; t: Line | null; r: Line | null; b: Line | null };
  text: TextBody;
};

export type ChartElement = {
  kind: "chart";
  frame: Frame;
  chart: ChartModel;
};

export type { ChartModel };

/** What the window drawing a slide decides that the file leaves to the
 *  machine: the face for a font it lacks (`null`: the system's sans-serif,
 *  after the file's face and its metric twins) and the language chart
 *  numbers are written in — the interface's, not the system's (owner,
 *  2026-10-28). */
export type SlideTextSettings = { fallbackFont: string | null; locale: string };

export type TextBody = {
  insets: Insets;
  anchor: "t" | "ctr" | "b";
  anchorCenter: boolean;
  wrap: boolean;
  vertical: "horz" | "vert" | "vert270" | "eaVert" | "wordArtVert";
  /** PowerPoint stores the scale it applied when it shrank the text; `null`
   *  scale means "shrink on overflow" with none stored: the painter measures. */
  autofit: { kind: "none" } | { kind: "shape" } | { kind: "normal"; fontScale: number | null; lineReduction: number };
  columns: { count: number; spacing: number };
  rotation: number;
  /** `bodyPr@upright`: text stays level when the shape rotates. */
  upright: boolean;
  /** WordArt's letters stretched to fill the text box, both ways (a legacy
   *  deck's plain-text WordArt): the painter measures the laid-out text and
   *  scales it to the box. */
  stretch?: true;
  paragraphs: Paragraph[];
};

export type Paragraph = {
  align: "l" | "ctr" | "r" | "just" | "dist";
  marginLeft: number;
  indent: number;
  /** Percent of single spacing, or exact points. */
  lineSpacing: { pct: number } | { pts: number };
  spaceBefore: { pct: number } | { pts: number };
  spaceAfter: { pct: number } | { pts: number };
  rtl: boolean;
  bullet: Bullet | null;
  runs: TextRun[];
  /** Size of an empty paragraph's line (`endParaRPr`), in points. */
  endSize: number;
  /** Tab stops (`a:tabLst`), in order, measured like `marginLeft` from the
   *  text box's left edge; past the last one, a stop every `defaultTab`. */
  tabs: { pos: number; align: "l" | "ctr" | "r" | "dec" }[];
  defaultTab: number;
};

/** A numbered paragraph arrives as `char` with its number already counted. */
export type Bullet =
  | { kind: "char"; char: string; font: string | null; color: string | null; size: { pct: number } | { pts: number } }
  | { kind: "image"; image: ImageRef; size: { pct: number } | { pts: number } };

export type TextRun =
  | {
      kind: "text";
      text: string;
      /** CSS family list: the file's face first, then metric-compatible ones. */
      font: string;
      /** Points. */
      size: number;
      bold: boolean;
      italic: boolean;
      underline: boolean;
      strike: boolean;
      caps: "none" | "all" | "small";
      /** Percent of the font size; positive is superscript. */
      baseline: number;
      /** Extra letter spacing, in points. */
      spacing: number;
      fill: Fill | null;
      outline: Line | null;
      highlight: string | null;
      effects: Effects;
    }
  /** A line break, with the size (points) of the line it ends — an empty
   *  line between two of them is that tall. */
  | { kind: "break"; size: number };
