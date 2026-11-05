import { useT, type MessageKey, type Translate } from "@renderer/lib/i18n/i18n-provider";
import {
  Button,
  Callout,
  ColorField,
  FieldRow,
  Icon,
  Select,
  Slider,
  Switch,
  type SelectOption,
} from "@renderer/components/ui";
import { useLocalFonts } from "@renderer/lib/hooks/use-local-fonts";
import { STYLE_SHADOW_MAX, STYLE_SHADOW_MIN, STYLE_TEXT_MAX_CQW, STYLE_TEXT_MIN_CQW } from "@shared/style-validators";
import {
  BACKGROUND_FITS,
  GRADIENT_DIRECTIONS,
  SCENE_FONT_WEIGHTS,
  SCENE_VERTICAL_ALIGNS,
  type SceneBackground,
  type SceneFontWeight,
  type SceneTextStyle,
  type SceneVerticalAlign,
} from "@shared/types/scene-style";
import type { MediaAsset } from "@shared/types/media";

/**
 * The field rows every editor that DRESSES something reuses.
 *
 * `SceneStyle` was written to be shared by the time scenes, the Overlays
 * plates and the Bible verse; these are the controls that edit the parts they
 * have in common. They lived inside `scene-form.tsx` until the Bible style
 * editor became the second caller, which is exactly the point `CLAUDE.md`
 * promotes on — and the reason they are in `components/shared/` rather than
 * `components/ui/`: a background that resolves an `assetId` out of the image
 * library is domain, not a primitive.
 *
 * The labels moved with them, from `scenes.*` to `style.*`. Two features
 * spelling «Background type» from two dictionary entries is how the two
 * spellings start to differ.
 *
 * Every row here is a bare `FieldRow`: the caller owns the `FieldGroup`, so
 * one editor can put the background in a group of its own and another can
 * fold it in among its own rows.
 */

const ALIGN_LABEL: Record<SceneVerticalAlign, MessageKey> = {
  top: "style.align.top",
  middle: "style.align.middle",
  bottom: "style.align.bottom",
};

/** Numeric weights named in words: the dictionary's keys are paths, and a
 *  numeric key is not one `MessageKey` can express. The operator reads
 *  "Bold" either way — 700 is a CSS number, not a label. */
const WEIGHT_LABEL: Record<SceneFontWeight, MessageKey> = {
  300: "style.weights.light",
  400: "style.weights.regular",
  600: "style.weights.semibold",
  700: "style.weights.bold",
  900: "style.weights.black",
};

const BACKGROUND_LABEL: Record<SceneBackground["kind"], MessageKey> = {
  solid: "style.background.solid",
  gradient: "style.background.gradient",
  image: "style.background.image",
};

const GRADIENT_LABEL: Record<(typeof GRADIENT_DIRECTIONS)[number], MessageKey> = {
  "to-bottom": "style.gradient.toBottom",
  "to-right": "style.gradient.toRight",
  "to-bottom-right": "style.gradient.toBottomRight",
  radial: "style.gradient.radial",
};

const FIT_LABEL: Record<(typeof BACKGROUND_FITS)[number], MessageKey> = {
  cover: "style.fits.cover",
  contain: "style.fits.contain",
};

/** `null` in the row, a sentinel in the `<Select>`: a select's value is a
 *  string, and "" is already what an empty option would be. */
const APP_FONT = "__app__";

/** Keeps the fields the previous background kind shared, so switching from a
 *  solid to a gradient and back does not lose the colour the operator picked.
 *  Module-private: it is `BackgroundFields`' own behaviour, and exporting it
 *  would also cost this file its fast-refresh boundary. */
function backgroundOfKind(kind: SceneBackground["kind"], current: SceneBackground): SceneBackground {
  if (kind === current.kind) return current;
  switch (kind) {
    case "solid":
      return { kind: "solid", color: current.kind === "gradient" ? current.from : "#162231" };
    case "gradient":
      return {
        kind: "gradient",
        from: current.kind === "solid" ? current.color : "#162231",
        to: "#2f557f",
        direction: "to-bottom",
      };
    case "image":
      // `0` is not a valid asset id and never matches a row, which is exactly
      // right: nothing has an image yet, and the `<Select>` shows its
      // placeholder until one is chosen. A form with a save button refuses it
      // there; the verse style, saved on every change, holds it unsaved.
      return { kind: "image", assetId: 0, fit: "cover" };
  }
}

type BackgroundFieldsProps = {
  /** The image assets a background can point at, plus the button that adds
   *  more — owned by the caller, which is where the loading state lives. */
  addingImages: boolean;
  imageAssets: readonly MediaAsset[];
  /** Which kinds the operator may pick. An overlay plate's band offers no
   *  image — a bug's picture is its content, not its dressing. */
  kinds?: readonly SceneBackground["kind"][];
  onAddImages: () => void;
  onChange: (next: SceneBackground) => void;
  value: SceneBackground;
};

/** Kind, plus whichever rows that kind needs. */
export function BackgroundFields({
  addingImages,
  imageAssets,
  kinds = ["solid", "gradient", "image"],
  onAddImages,
  onChange,
  value,
}: BackgroundFieldsProps) {
  const t = useT();
  return (
    <>
      <FieldRow label={t("style.backgroundKind")}>
        <Select
          className="w-52"
          onChange={(next) => onChange(backgroundOfKind(next as SceneBackground["kind"], value))}
          options={kinds.map((kind) => ({
            label: t(BACKGROUND_LABEL[kind]),
            value: kind,
          }))}
          value={value.kind}
        />
      </FieldRow>

      {value.kind === "solid" ? (
        <FieldRow label={t("style.backgroundColor")}>
          <ColorField
            label={t("style.backgroundColor")}
            onChange={(color) => onChange({ kind: "solid", color })}
            value={value.color}
          />
        </FieldRow>
      ) : null}

      {value.kind === "gradient" ? (
        <>
          <FieldRow label={t("style.gradientFrom")}>
            <ColorField
              label={t("style.gradientFrom")}
              onChange={(from) => onChange({ ...value, from })}
              value={value.from}
            />
          </FieldRow>
          <FieldRow label={t("style.gradientTo")}>
            <ColorField
              label={t("style.gradientTo")}
              onChange={(to) => onChange({ ...value, to })}
              value={value.to}
            />
          </FieldRow>
          <FieldRow label={t("style.gradientDirection")}>
            <Select
              className="w-52"
              onChange={(direction) =>
                onChange({ ...value, direction: direction as (typeof GRADIENT_DIRECTIONS)[number] })
              }
              options={GRADIENT_DIRECTIONS.map((direction) => ({
                label: t(GRADIENT_LABEL[direction]),
                value: direction,
              }))}
              value={value.direction}
            />
          </FieldRow>
        </>
      ) : null}

      {value.kind === "image" ? (
        <>
          <FieldRow description={t("style.imageHint")} label={t("style.image")}>
            <Select
              className="w-52"
              onChange={(assetId) => onChange({ ...value, assetId: Number(assetId) })}
              options={imageAssets.map((asset) => ({ label: asset.name, value: String(asset.id) }))}
              placeholder={t("style.imagePlaceholder")}
              value={String(value.assetId)}
            />
            <Button disabled={addingImages} onClick={onAddImages} variant="outline">
              <Icon name="add" />
              {t("style.addImage")}
            </Button>
          </FieldRow>
          <FieldRow label={t("style.fit")}>
            <Select
              className="w-52"
              onChange={(fit) => onChange({ ...value, fit: fit as (typeof BACKGROUND_FITS)[number] })}
              options={BACKGROUND_FITS.map((fit) => ({ label: t(FIT_LABEL[fit]), value: fit }))}
              value={value.fit}
            />
          </FieldRow>
        </>
      ) : null}
    </>
  );
}

/** The typeface, and the warning for a machine that will not list its fonts.
 *  The callout is a sibling of the row rather than inside it: it is about the
 *  whole control, not about one value. */
export function FontFamilyFields({
  onChange,
  value,
}: {
  onChange: (next: string | null) => void;
  value: string | null;
}) {
  const t = useT();
  const fonts = useLocalFonts(true);

  const options: SelectOption[] = [
    { label: t("style.fonts.app"), value: APP_FONT },
    ...(fonts.status === "ready" ? fonts.families.map((family) => ({ label: family, value: family })) : []),
    // The stored family, kept selectable even when this machine no longer has
    // it: dropping it silently would rewrite the row to "the app font" the
    // first time somebody opened this on a different computer.
    ...(value !== null && !(fonts.status === "ready" && fonts.families.includes(value))
      ? [{ label: t("style.fonts.missing", { name: value }), value }]
      : []),
  ];

  return (
    <>
      <FieldRow description={t("style.fontHint")} label={t("style.font")}>
        {/* The one list in the app that is as long as the machine's font book
            — hundreds of families on a designer's laptop, in an order nobody
            memorises. */}
        <Select
          className="w-64"
          onChange={(family) => onChange(family === APP_FONT ? null : family)}
          options={options}
          searchable
          value={value ?? APP_FONT}
        />
      </FieldRow>
      {fonts.status === "unavailable" ? (
        <div className="px-4 py-3">
          <Callout tone="warning">{t("style.fontsUnavailable")}</Callout>
        </div>
      ) : null}
    </>
  );
}

export function VerticalAlignField({
  onChange,
  value,
}: {
  onChange: (next: SceneVerticalAlign) => void;
  value: SceneVerticalAlign;
}) {
  const t = useT();
  return (
    <FieldRow label={t("style.verticalAlign")}>
      <Select
        className="w-52"
        onChange={(align) => onChange(align as SceneVerticalAlign)}
        options={SCENE_VERTICAL_ALIGNS.map((align) => ({ label: t(ALIGN_LABEL[align]), value: align }))}
        value={value}
      />
    </FieldRow>
  );
}

/**
 * How wide a range the size slider offers, and how finely.
 *
 * A range and not a constant because `SceneTextStyle` dresses text roles whose
 * useful sizes are an order of magnitude apart: a countdown's number is 20 cqw
 * by default, a verse 3.5 and its reference 2. One slider spanning the
 * validators' whole 0.5–60 put every verse in the leftmost twentieth of the
 * track, where a single pixel of travel was a visible jump and everything to
 * the right of it was a size no paragraph can be read at.
 *
 * So the RANGE is the editor's, per role, while `STYLE_TEXT_MIN_CQW` /
 * `STYLE_TEXT_MAX_CQW` stay what a STORED row is checked against — a value
 * saved before this existed still loads, and `Slider` clamps the thumb rather
 * than rewriting it. Nothing here narrows what the app can store.
 */
export type TextSizeRange = { max: number; min: number; step: number };

/** What a role that does not ask gets: the validators' own bounds, which is
 *  what every caller had before this was a prop — the time-scene editor's
 *  number genuinely reaches 60. */
const DEFAULT_SIZE_RANGE: TextSizeRange = {
  max: STYLE_TEXT_MAX_CQW,
  min: STYLE_TEXT_MIN_CQW,
  step: 0.5,
};

/** How many decimals a step implies, so the readout says `3.5` and not
 *  `3.5000000000000004` — `min + n * step` in binary floating point does not
 *  land on the number the operator is looking at. The same rounding is applied
 *  to the value being STORED, not only to the one being shown. */
function decimalsOf(step: number): number {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** The knobs every text role has, as bare rows — so a caller can put
 *  them in a group of their own or beside the text they belong to. */
export function TextStyleFields({
  onChange,
  sizeRange = DEFAULT_SIZE_RANGE,
  t,
  value,
}: {
  onChange: (next: SceneTextStyle) => void;
  /** The size slider's own range — see `TextSizeRange`. */
  sizeRange?: TextSizeRange;
  /** Passed in rather than hooked, so a caller that already has `t` in a
   *  render-prop position (a group rendered in a loop) does not pay for a
   *  second context read per row. */
  t: Translate;
  value: SceneTextStyle;
}) {
  const decimals = decimalsOf(sizeRange.step);
  return (
    <>
      <FieldRow description={t("style.sizeHint")} label={t("style.size")}>
        <Slider
          label={t("style.size")}
          max={sizeRange.max}
          min={sizeRange.min}
          // Rounded to the step's own precision before it is stored, not just
          // before it is shown: the readout has no `format` of its own, so a
          // `3.5000000000000004` would reach both the row and the projector.
          onChange={(sizeCqw) => onChange({ ...value, sizeCqw: Number(sizeCqw.toFixed(decimals)) })}
          step={sizeRange.step}
          value={value.sizeCqw}
        />
      </FieldRow>
      <FieldRow label={t("style.color")}>
        <ColorField
          label={t("style.color")}
          onChange={(color) => onChange({ ...value, color })}
          value={value.color}
        />
      </FieldRow>
      <FieldRow label={t("style.weight")}>
        <Select
          className="w-40"
          onChange={(weight) => onChange({ ...value, weight: Number(weight) as SceneFontWeight })}
          options={SCENE_FONT_WEIGHTS.map((weight) => ({ label: t(WEIGHT_LABEL[weight]), value: String(weight) }))}
          value={String(value.weight)}
        />
      </FieldRow>
      <FieldRow description={t("style.shadowHint")} label={t("style.shadow")}>
        <Switch checked={value.shadow} onChange={(e) => onChange({ ...value, shadow: e.target.checked })} />
      </FieldRow>
      <FieldRow label={t("style.shadowStrength")}>
        <Slider
          disabled={!value.shadow}
          format={(strength) => `${Math.round(strength * 100)}%`}
          label={t("style.shadowStrength")}
          max={STYLE_SHADOW_MAX}
          min={STYLE_SHADOW_MIN}
          onChange={(strength) => onChange({ ...value, shadowStrength: Number(strength.toFixed(2)) })}
          readoutChars={4}
          step={0.05}
          value={value.shadowStrength}
        />
      </FieldRow>
    </>
  );
}
