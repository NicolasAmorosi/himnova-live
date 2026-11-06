import { useT } from "@renderer/lib/i18n/i18n-provider";
import { FieldRow, Input, InspectorSection, Select, Slider, Switch } from "@renderer/components/ui";
import { BackgroundFields, FontFamilyFields, TextStyleFields, type TextSizeRange } from "@renderer/components/shared/style-fields";
import { transitionDurationOptions } from "@renderer/lib/transition";
import {
  PLATE_AUTO_HIDE_MAX_MS,
  PLATE_AUTO_HIDE_MIN_MS,
  PLATE_CORNER_MAX_CQW,
  PLATE_IMAGE_MAX_CQW,
  PLATE_IMAGE_MIN_CQW,
  PLATE_MARGIN_MAX_CQW,
  PLATE_TEXT_MAX_LENGTH,
  PLATE_TICKER_MAX_CQW,
  PLATE_TICKER_MIN_CQW,
} from "@shared/overlay-validators";
import {
  PLATE_ANIMATION_STYLES,
  PLATE_KIND_POSITIONS,
  PLATE_KINDS,
  type PlateAnimationStyle,
  type PlateKind,
  type PlatePosition,
  type PlateStyle,
} from "@shared/types/overlay";
import type { MediaAsset } from "@shared/types/media";
import { withKind, type PlateDraft } from "./plate-draft";
import { PLATE_ANIMATION_LABEL, PLATE_KIND_LABEL, PLATE_POSITION_LABEL } from "./plate-display";

/** A plate's lines are an order of magnitude smaller than a countdown's
 *  number, so the size slider spans what a plate can actually use. */
const PLATE_TEXT_SIZES: TextSizeRange = { min: 0.5, max: 10, step: 0.1 };

/** `null` in the row, a sentinel in the `<Select>`. */
const NO_IMAGE = "__none__";

const percent = (value: number) => `${Math.round(value * 100)}%`;
const seconds = (value: number) => `${value} s`;

type PlateFormProps = {
  addingImages: boolean;
  imageAssets: readonly MediaAsset[];
  onAddImages: () => void;
  onChange: (next: PlateDraft) => void;
  value: PlateDraft;
};

/** Everything about one plate but its name (the editor's title), as the
 *  sections of the editor's inspector, reusing the scene editor's style rows
 *  (`style-fields.tsx`). Fully controlled. */
export function PlateForm({ addingImages, imageAssets, onAddImages, onChange, value }: PlateFormProps) {
  const t = useT();
  const patch = (next: Partial<PlateDraft>) => onChange({ ...value, ...next });
  const patchStyle = (next: Partial<PlateStyle>) => patch({ style: { ...value.style, ...next } });
  const { style } = value;

  return (
    <>
      <InspectorSection title={t("plates.groups.plate")}>
        <FieldRow description={t("plates.kindHint")} label={t("plates.kind")}>
          <Select
            onChange={(kind) => onChange(withKind(value, kind as PlateKind))}
            options={PLATE_KINDS.map((kind) => ({ label: t(PLATE_KIND_LABEL[kind]), value: kind }))}
            value={value.kind}
          />
        </FieldRow>
      </InspectorSection>

      <InspectorSection title={t("plates.groups.texts")}>
        <FieldRow description={t("plates.titleHint")} label={t("plates.titleText")}>
          <Input
            maxLength={PLATE_TEXT_MAX_LENGTH}
            onChange={(e) => patch({ title: e.target.value === "" ? null : e.target.value })}
            value={value.title ?? ""}
          />
        </FieldRow>
        <FieldRow description={t("plates.subtitleHint")} label={t("plates.subtitleText")}>
          <Input
            maxLength={PLATE_TEXT_MAX_LENGTH}
            onChange={(e) => patch({ subtitle: e.target.value === "" ? null : e.target.value })}
            value={value.subtitle ?? ""}
          />
        </FieldRow>
        {/* With the lines it dresses: a section of its own held this one row. */}
        <FontFamilyFields onChange={(fontFamily) => patchStyle({ fontFamily })} value={style.fontFamily} />
      </InspectorSection>

      {value.kind === "bug" ? (
        <InspectorSection title={t("plates.groups.image")}>
          <FieldRow description={t("style.imageHint")} label={t("plates.image")}>
            <Select
              action={{ disabled: addingImages, label: t("style.importImage"), onSelect: onAddImages }}
              onChange={(id) => patch({ imageAssetId: id === NO_IMAGE ? null : Number(id) })}
              options={[
                { label: t("plates.imageNone"), value: NO_IMAGE },
                ...imageAssets.map((asset) => ({ label: asset.name, value: String(asset.id) })),
              ]}
              value={value.imageAssetId === null ? NO_IMAGE : String(value.imageAssetId)}
            />
          </FieldRow>
          <FieldRow description={t("plates.imageSizeHint")} label={t("plates.imageSize")}>
            <Slider
              disabled={value.imageAssetId === null}
              label={t("plates.imageSize")}
              max={PLATE_IMAGE_MAX_CQW}
              min={PLATE_IMAGE_MIN_CQW}
              onChange={(sizeCqw) => patchStyle({ image: { ...style.image, sizeCqw } })}
              step={0.5}
              unit="%"
              value={style.image.sizeCqw}
            />
          </FieldRow>
          <FieldRow label={t("plates.imageOpacity")}>
            <Slider
              // Nothing to size or fade without a picture.
              disabled={value.imageAssetId === null}
              format={percent}
              label={t("plates.imageOpacity")}
              max={1}
              min={0.05}
              onChange={(opacity) => patchStyle({ image: { ...style.image, opacity: Number(opacity.toFixed(2)) } })}
              step={0.05}
              value={style.image.opacity}
            />
          </FieldRow>
        </InspectorSection>
      ) : null}

      <InspectorSection title={t("plates.groups.band")}>
        <BackgroundFields
          addingImages={false}
          imageAssets={[]}
          kinds={["solid", "gradient"]}
          onAddImages={() => undefined}
          onChange={(background) => patchStyle({ background })}
          value={style.background}
        />
        <FieldRow description={t("plates.bandOpacityHint")} label={t("plates.bandOpacity")}>
          <Slider
            format={percent}
            label={t("plates.bandOpacity")}
            max={1}
            min={0}
            onChange={(backgroundOpacity) => patchStyle({ backgroundOpacity: Number(backgroundOpacity.toFixed(2)) })}
            step={0.05}
            value={style.backgroundOpacity}
          />
        </FieldRow>
        <FieldRow description={t("plates.cornersHint")} label={t("plates.corners")}>
          <Slider
            label={t("plates.corners")}
            max={PLATE_CORNER_MAX_CQW}
            min={0}
            onChange={(cornerRadiusCqw) => patchStyle({ cornerRadiusCqw: Number(cornerRadiusCqw.toFixed(1)) })}
            step={0.1}
            unit="%"
            value={style.cornerRadiusCqw}
          />
        </FieldRow>
      </InspectorSection>

      <InspectorSection title={t("plates.groups.titleLine")}>
        <TextStyleFields
          onChange={(title) => patchStyle({ title })}
          sizeRange={PLATE_TEXT_SIZES}
          t={t}
          value={style.title}
        />
      </InspectorSection>
      <InspectorSection title={t("plates.groups.subtitleLine")}>
        <TextStyleFields
          onChange={(subtitle) => patchStyle({ subtitle })}
          sizeRange={PLATE_TEXT_SIZES}
          t={t}
          value={style.subtitle}
        />
      </InspectorSection>

      <InspectorSection title={t("plates.groups.layout")}>
        <FieldRow
          {...(value.kind === "banner" ? { description: t("plates.bannerPositionHint") } : {})}
          label={t("plates.position")}
        >
          <Select
            onChange={(position) => patch({ position: position as PlatePosition })}
            options={PLATE_KIND_POSITIONS[value.kind].map((position) => ({
              label: t(PLATE_POSITION_LABEL[position]),
              value: position,
            }))}
            value={value.position}
          />
        </FieldRow>
        <FieldRow description={t("plates.marginHint")} label={t("plates.margin")}>
          <Slider
            label={t("plates.margin")}
            max={PLATE_MARGIN_MAX_CQW}
            min={0}
            onChange={(marginCqw) => patchStyle({ marginCqw })}
            step={0.5}
            unit="%"
            value={style.marginCqw}
          />
        </FieldRow>
      </InspectorSection>

      {value.kind === "banner" ? (
        <InspectorSection title={t("plates.groups.ticker")}>
          <FieldRow description={t("plates.tickerEnabledHint")} label={t("plates.tickerEnabled")}>
            <Switch
              checked={style.ticker.enabled}
              onChange={(e) => patchStyle({ ticker: { ...style.ticker, enabled: e.target.checked } })}
            />
          </FieldRow>
          <FieldRow description={t("plates.tickerSpeedHint")} label={t("plates.tickerSpeed")}>
            <Slider
              disabled={!style.ticker.enabled}
              label={t("plates.tickerSpeed")}
              max={PLATE_TICKER_MAX_CQW}
              min={PLATE_TICKER_MIN_CQW}
              onChange={(speedCqw) => patchStyle({ ticker: { ...style.ticker, speedCqw } })}
              step={1}
              unit="%/s"
              value={style.ticker.speedCqw}
            />
          </FieldRow>
        </InspectorSection>
      ) : null}

      <InspectorSection defaultOpen={false} title={t("plates.groups.animation")}>
        <FieldRow label={t("plates.animation")}>
          <Select
            onChange={(next) =>
              patchStyle({ animation: { ...style.animation, style: next as PlateAnimationStyle } })
            }
            options={PLATE_ANIMATION_STYLES.map((animation) => ({
              label: t(PLATE_ANIMATION_LABEL[animation]),
              value: animation,
            }))}
            value={style.animation.style}
          />
        </FieldRow>
        <FieldRow description={t("plates.animationDurationHint")} label={t("plates.animationDuration")}>
          <Select
            disabled={style.animation.style === "none"}
            onChange={(durationMs) => patchStyle({ animation: { ...style.animation, durationMs: Number(durationMs) } })}
            options={transitionDurationOptions(t, style.animation.durationMs)}
            value={String(style.animation.durationMs)}
          />
        </FieldRow>
      </InspectorSection>

      <InspectorSection defaultOpen={false} title={t("plates.groups.autoHide")}>
        <FieldRow description={t("plates.autoHideEnabledHint")} label={t("plates.autoHideEnabled")}>
          <Switch
            checked={style.autoHide.enabled}
            onChange={(e) => patchStyle({ autoHide: { ...style.autoHide, enabled: e.target.checked } })}
          />
        </FieldRow>
        <FieldRow label={t("plates.autoHideAfter")}>
          <Slider
            disabled={!style.autoHide.enabled}
            format={seconds}
            label={t("plates.autoHideAfter")}
            max={PLATE_AUTO_HIDE_MAX_MS / 1000}
            min={PLATE_AUTO_HIDE_MIN_MS / 1000}
            onChange={(value) => patchStyle({ autoHide: { ...style.autoHide, afterMs: value * 1000 } })}
            step={1}
            value={style.autoHide.afterMs / 1000}
          />
        </FieldRow>
      </InspectorSection>
    </>
  );
}
