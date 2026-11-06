import { useEffect, useState } from "react";
import { useT, type MessageKey } from "@renderer/lib/i18n/i18n-provider";
import {
  Button,
  DependentFields,
  FieldRow,
  Icon,
  Inspector,
  InspectorSection,
  Select,
  Slider,
  Segmented,
  Switch,
} from "@renderer/components/ui";
import { ConfirmModal } from "@renderer/components/shared/modal";
import { EditorScreen, EditorStage } from "@renderer/components/shared/editor-screen";
import {
  BackgroundFields,
  FontFamilyFields,
  TextStyleFields,
  VerticalAlignField,
  type TextSizeRange,
} from "@renderer/components/shared/style-fields";
import { api } from "@renderer/lib/api";
import { toast } from "@renderer/lib/toast";
import { useSettingsStore } from "@renderer/stores/settings.store";
import {
  BIBLE_AUTOFIT_MIN_CQW,
  BIBLE_LINE_HEIGHT_MAX,
  BIBLE_LINE_HEIGHT_MIN,
  BIBLE_MAX_WIDTH_MAX_CQW,
  BIBLE_MAX_WIDTH_MIN_CQW,
  REFERENCE_POSITIONS,
  TEXT_ALIGNS,
  TEXT_CASES,
  VERSION_DISPLAYS,
  type BibleStyle,
  type ReferencePosition,
  type TextAlign,
  type TextCase,
  type VersionDisplay,
} from "@shared/types/bible-style";
import type { MediaAsset } from "@shared/types/media";
import type { SceneBackground } from "@shared/types/scene-style";
import { VersePreview } from "./verse-preview";

const ALIGN_LABEL: Record<TextAlign, MessageKey> = {
  left: "settings.verse.align.left",
  center: "settings.verse.align.center",
  right: "settings.verse.align.right",
  justify: "settings.verse.align.justify",
};

const POSITION_LABEL: Record<ReferencePosition, MessageKey> = {
  above: "settings.verse.positions.above",
  below: "settings.verse.positions.below",
};

const CASE_LABEL: Record<TextCase, MessageKey> = {
  normal: "settings.verse.cases.normal",
  uppercase: "settings.verse.cases.uppercase",
};

/**
 * What a verse's two text roles can actually be sized to.
 *
 * Narrower than the validators' 0.5–60, and deliberately so: those bounds
 * exist for a countdown's number (20 cqw by default), not for a paragraph. At
 * 12 cqw a verse of average length already fills a 16:9 stage top to bottom,
 * and below 1 it is unreadable on a projector — so a track spanning 60 spent
 * nineteen twentieths of itself on sizes nobody can use and made the one
 * twentieth that matters a jump per pixel.
 *
 * The step is 0.1 for the same reason: at 0.5 there were six usable positions
 * for the verse and four for the reference.
 *
 * These cap the EDITOR, never the store. A style saved with a larger size
 * still loads and still projects — the slider clamps its thumb, it does not
 * rewrite the value.
 */
const VERSE_SIZE_RANGE: TextSizeRange = { max: 12, min: 1, step: 0.1 };
/** The reference is a caption under a paragraph; above 8 cqw it competes with
 *  the verse it is labelling. */
const REFERENCE_SIZE_RANGE: TextSizeRange = { max: 8, min: 0.5, step: 0.1 };

const VERSION_DISPLAY_LABEL: Record<VersionDisplay, MessageKey> = {
  hidden: "settings.verse.versionDisplays.hidden",
  inline: "settings.verse.versionDisplays.inline",
  line: "settings.verse.versionDisplays.line",
};

/**
 * How a verse is dressed on the projector: a full-screen editor opened from the
 * palette at the foot of the Bible tab (owner, 2026-11-04), the way «Themes»
 * opens from the Songs tab's. It used to be a category of Settings; it is a look with a live
 * preview, not an option, and Settings kept only options.
 *
 * Saving is IMMEDIATE, unlike the time-scene editor, and that is a decision
 * rather than an inconsistency. A scene editor writes on an explicit save
 * because its text fields are part of the row, and persisting on every
 * keystroke would spell a new end message out letter by letter in front of the
 * congregation. Nothing here is the verse's TEXT — every control is a look —
 * so the worst an immediate write can do is restyle what is already on screen,
 * which is precisely what the operator is asking for while they watch the
 * preview above. It also makes this behave like the rest of Settings, where
 * every toggle is already immediate.
 *
 * And because it is immediate, it reaches the projector with no scene
 * transition: `App` mirrors the setting into `projection.store`, which
 * recomputes `selectOutput` WITHOUT touching `sceneEpoch` (see `setBibleStyle`
 * there). Editing a live verse's look is a patch in place, exactly like
 * `setLiveScene` is for a time scene.
 */
export function VerseStyleModal({ onOpenChange, open }: { onOpenChange: (open: boolean) => void; open: boolean }) {
  const t = useT();
  const style = useSettingsStore((s) => s.settings["bible.style"]);
  const update = useSettingsStore((s) => s.update);
  const [longPreview, setLongPreview] = useState(false);
  const [imageAssets, setImageAssets] = useState<readonly MediaAsset[]>([]);
  const [addingImages, setAddingImages] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  // «Image» picked before an image: shown here, never saved — a save is
  // immediate, and an image background with no image is one main refuses.
  const [pendingImage, setPendingImage] = useState<Extract<SceneBackground, { kind: "image" }> | null>(null);

  // The image library, for an image background's picker. Read on open rather
  // than kept in a store: it is one query, only this editor wants it, and it
  // must reflect whatever the operator added since the last time they were
  // here. Same as the scene editor's.
  useEffect(() => {
    if (!open) {
      setPendingImage(null);
      return;
    }
    void api.library
      .list("image")
      .then(setImageAssets)
      .catch((error: unknown) => console.warn("[bible] could not list the image library", error));
  }, [open]);

  // Off the store at the moment of writing, not off this render: an image
  // import resolves seconds later, and spreading the style it closed over
  // reverted whatever was changed meanwhile. A style main refuses has already
  // snapped back (`update` re-reads the settings); the operator is told which
  // change did not take, not the generic «unexpected error».
  const patch = (next: Partial<BibleStyle>) =>
    void update({ "bible.style": { ...useSettingsStore.getState().settings["bible.style"], ...next } }).catch(
      (error: unknown) => {
        console.warn("[bible] could not save the verse style", error);
        toast.danger(t("settings.verse.saveError"));
      },
    );

  async function handleAddImages() {
    setAddingImages(true);
    try {
      const paths = await api.files.pick("image", true);
      if (paths.length === 0) return;
      const added = await api.library.add(paths, "image");
      setImageAssets(await api.library.list("image"));
      // Selecting the first one is the point of the button: the operator
      // picked a file in order to use it, not in order to then find it in a
      // dropdown.
      const first = added[0];
      if (first) {
        setPendingImage(null);
        patch({ background: { kind: "image", assetId: first.id, fit: pendingImage?.fit ?? "cover" } });
      }
    } catch (error) {
      console.warn("[bible] could not add images", error);
      toast.danger(t("style.addImageError"));
    } finally {
      setAddingImages(false);
    }
  }

  return (
    <>
      <EditorScreen
        inspector={
          <Inspector label={t("bible.styleTitle")}>
            <InspectorSection title={t("style.groups.background")}>
              <BackgroundFields
                addingImages={addingImages}
                imageAssets={imageAssets}
                onAddImages={() => void handleAddImages()}
                onChange={(background) => {
                  const noImageYet = background.kind === "image" && background.assetId === 0;
                  setPendingImage(noImageYet ? background : null);
                  if (!noImageYet) patch({ background });
                }}
                value={pendingImage ?? style.background}
              />
            </InspectorSection>

            <InspectorSection title={t("settings.verse.groups.layout")}>
              <VerticalAlignField onChange={(verticalAlign) => patch({ verticalAlign })} value={style.verticalAlign} />
              <FieldRow label={t("settings.verse.textAlign")}>
                <Select
                  onChange={(align) => patch({ textAlign: align as TextAlign })}
                  options={TEXT_ALIGNS.map((align) => ({ label: t(ALIGN_LABEL[align]), value: align }))}
                  value={style.textAlign}
                />
              </FieldRow>
              <FieldRow description={t("settings.verse.lineHeightHint")} label={t("settings.verse.lineHeight")}>
                <Slider
                  format={(value) => value.toFixed(2)}
                  label={t("settings.verse.lineHeight")}
                  max={BIBLE_LINE_HEIGHT_MAX}
                  min={BIBLE_LINE_HEIGHT_MIN}
                  // 0.01, not 0.05: 0.8–3.0 in twentieths is 44 stops for the one
                  // control that decides whether a two-line verse reads as one
                  // sentence, and the default (1.375) is not even on that grid.
                  onChange={(lineHeight) => patch({ lineHeight: Number(lineHeight.toFixed(2)) })}
                  step={0.01}
                  value={style.lineHeight}
                />
              </FieldRow>
              <FieldRow description={t("settings.verse.maxWidthHint")} label={t("settings.verse.maxWidth")}>
                <Slider
                  label={t("settings.verse.maxWidth")}
                  max={BIBLE_MAX_WIDTH_MAX_CQW}
                  min={BIBLE_MAX_WIDTH_MIN_CQW}
                  onChange={(maxWidthCqw) => patch({ maxWidthCqw })}
                  step={1}
                  unit="%"
                  value={style.maxWidthCqw}
                />
              </FieldRow>
            </InspectorSection>

            {/* The font with the text it dresses: a section of its own held
                that one row (2026-11-05 review). */}
            <InspectorSection title={t("settings.verse.groups.verse")}>
              <FontFamilyFields onChange={(fontFamily) => patch({ fontFamily })} value={style.fontFamily} />
              <TextStyleFields
                onChange={(text) => patch({ text })}
                sizeRange={VERSE_SIZE_RANGE}
                t={t}
                value={style.text}
              />
            </InspectorSection>

            <InspectorSection title={t("settings.verse.groups.autoFit")}>
              <FieldRow description={t("settings.verse.autoFitHint")} label={t("settings.verse.autoFit")}>
                <Switch
                  checked={style.autoFit.enabled}
                  onChange={(e) => patch({ autoFit: { ...style.autoFit, enabled: e.target.checked } })}
                />
              </FieldRow>
              <FieldRow description={t("settings.verse.autoFitMinHint")} label={t("settings.verse.autoFitMin")}>
                <Slider
                  disabled={!style.autoFit.enabled}
                  label={t("settings.verse.autoFitMin")}
                  // Its own ceiling is the verse's size: "shrink to something
                  // bigger" is not a thing, and the renderer resolves it by taking
                  // the smaller of the two anyway (`useFittedTextSize`). Capping the
                  // control is what keeps the operator from reaching a setting that
                  // silently means "off".
                  max={style.text.sizeCqw}
                  min={BIBLE_AUTOFIT_MIN_CQW}
                  onChange={(minSizeCqw) =>
                    patch({ autoFit: { ...style.autoFit, minSizeCqw: Number(minSizeCqw.toFixed(1)) } })
                  }
                  // Matches the verse size slider's own step: this floor is read
                  // against that number, and two controls describing the same
                  // quantity at different resolutions is how the operator ends up
                  // with a floor they cannot actually reach.
                  step={0.1}
                  unit="%"
                  value={Math.min(style.autoFit.minSizeCqw, style.text.sizeCqw)}
                />
              </FieldRow>
            </InspectorSection>

            <InspectorSection title={t("settings.verse.groups.reference")}>
              <FieldRow description={t("settings.verse.showReferenceHint")} label={t("settings.verse.showReference")}>
                <Switch checked={style.showReference} onChange={(e) => patch({ showReference: e.target.checked })} />
              </FieldRow>
              {/* Everything below describes a line that is not drawn while the
                  switch above is off: dimmed, never hidden (owner, 2026-11-05). */}
              <DependentFields enabled={style.showReference}>
                <FieldRow label={t("settings.verse.referencePosition")}>
                  <Select
                    onChange={(position) => patch({ referencePosition: position as ReferencePosition })}
                    options={REFERENCE_POSITIONS.map((position) => ({
                      label: t(POSITION_LABEL[position]),
                      value: position,
                    }))}
                    value={style.referencePosition}
                  />
                </FieldRow>
                <FieldRow label={t("settings.verse.referenceCase")}>
                  <Select
                    onChange={(next) => patch({ referenceCase: next as TextCase })}
                    options={TEXT_CASES.map((next) => ({ label: t(CASE_LABEL[next]), value: next }))}
                    value={style.referenceCase}
                  />
                </FieldRow>
                <FieldRow
                  description={t("settings.verse.versionDisplayHint")}
                  label={t("settings.verse.versionDisplay")}
                >
                  <Select
                    onChange={(next) => patch({ versionDisplay: next as VersionDisplay })}
                    options={VERSION_DISPLAYS.map((next) => ({
                      label: t(VERSION_DISPLAY_LABEL[next]),
                      value: next,
                    }))}
                    value={style.versionDisplay}
                  />
                </FieldRow>
                <TextStyleFields
                  onChange={(reference) => patch({ reference })}
                  sizeRange={REFERENCE_SIZE_RANGE}
                  t={t}
                  value={style.reference}
                />
              </DependentFields>
            </InspectorSection>

            {/* Not a section: one button, last, away from every knob above. */}
            <div className="p-4">
              <Button
                className="w-full"
                onClick={() => setConfirmingReset(true)}
                title={t("settings.verse.resetDesc")}
                variant="outline"
              >
                <Icon name="restart" />
                {t("settings.verse.reset")}
              </Button>
            </div>
          </Inspector>
        }
        onClose={() => onOpenChange(false)}
        open={open}
        title={t("bible.styleTitle")}
      >
        <EditorStage
          below={
            // A long verse is how the automatic fit is checked.
            <Segmented
              label={t("settings.verse.sample")}
              onChange={(sample) => setLongPreview(sample === "long")}
              options={[
                { label: t("settings.verse.sampleShortLabel"), value: "short" },
                { label: t("settings.verse.sampleLongLabel"), value: "long" },
              ]}
              value={longPreview ? "long" : "short"}
            />
          }
        >
          <VersePreview long={longPreview} style={style} />
        </EditorStage>
      </EditorScreen>

      <ConfirmModal
        description={t("settings.verse.resetBody")}
        onConfirm={async () => {
          setPendingImage(null);
          await update({ "bible.style": await api.settings.factoryVerseStyle() });
          toast.success(t("settings.verse.resetDone"));
        }}
        onOpenChange={setConfirmingReset}
        open={confirmingReset}
        title={t("settings.verse.resetTitle")}
      />
    </>
  );
}
