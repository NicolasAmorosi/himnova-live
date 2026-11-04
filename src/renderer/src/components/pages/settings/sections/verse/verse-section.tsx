import { useEffect, useState } from "react";
import { useT, type MessageKey } from "@renderer/lib/i18n/i18n-provider";
import { Button, FieldGroup, FieldRow, Icon, Select, Slider, Switch, Tooltip } from "@renderer/components/ui";
import { ConfirmModal } from "@renderer/components/shared/modal";
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
  DEFAULT_BIBLE_STYLE,
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
 * «Verses»: how a verse is dressed on the projector.
 *
 * Its own category of Settings, beside «Bible» rather than inside it. The two
 * were one section with two tabs, and the pairing was an accident of the word
 * «Bible»: nothing here knows which bibles are installed, and nothing there
 * knows what a verse looks like.
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
export function VerseSection() {
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

  // The image library, for an image background's picker. Read on mount rather
  // than kept in a store: it is one query, only this form wants it, and it
  // must reflect whatever the operator added since the last time they were
  // here. Same as the scene editor's.
  useEffect(() => {
    void api.library
      .list("image")
      .then(setImageAssets)
      .catch((error: unknown) => console.warn("[bible] could not list the image library", error));
  }, []);

  // Off the store at the moment of writing, not off this render: an image
  // import resolves seconds later, and spreading the style it closed over
  // reverted whatever was changed meanwhile.
  const patch = (next: Partial<BibleStyle>) =>
    void update({ "bible.style": { ...useSettingsStore.getState().settings["bible.style"], ...next } });

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
    // This section owns its own scrolling, unlike the other four in Settings —
    // see the note in `SettingsModal`.
    <div className="flex min-h-0 flex-1 flex-col">
      {/* A FIXED band above the controls, the same shape and the same classes
          as the scene editor's in `ScenesModal`: every control below restyles
          what is drawn up here, and a preview that scrolls out of view while
          the operator drags the very slider it explains is a preview they have
          to remember instead of read. `shrink-0` is what keeps it out of the
          scroll, and the border is what makes the seam read as a header rather
          than as content that merely happens to come first.

          Capped and centred inside it because `Monitor` sizes by width (see
          `monitor-stage-must-size-by-width-not-flex.md`): at the full width of
          this panel a 16:9 stage is ~600 px tall and would leave no room for
          the controls it exists to explain. */}
      <div className="shrink-0 border-b border-border bg-background px-6 py-3">
        <div className="mx-auto flex w-full max-w-md flex-col gap-2">
          <VersePreview long={longPreview} style={style} />
          {/* The hint is a `Tooltip`, not the native `title` attribute it used
              to be: the browser's own bubble takes a second to appear, ignores
              the theme and cannot be reached with the keyboard. Same help-icon
              pattern as the rows that explain a format. */}
          <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
            <Tooltip content={t("settings.verse.previewHint")} floating>
              <Icon className="text-subtle" name="help" />
            </Tooltip>
            <label className="flex items-center gap-2">
              {t("settings.verse.preview")}
              <Switch checked={longPreview} onChange={(e) => setLongPreview(e.target.checked)} />
            </label>
          </div>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto p-6">
        <FieldGroup title={t("style.groups.background")}>
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
        </FieldGroup>

        <FieldGroup title={t("style.groups.typography")}>
          <FontFamilyFields onChange={(fontFamily) => patch({ fontFamily })} value={style.fontFamily} />
        </FieldGroup>

        <FieldGroup title={t("settings.verse.groups.layout")}>
          <VerticalAlignField onChange={(verticalAlign) => patch({ verticalAlign })} value={style.verticalAlign} />
          <FieldRow label={t("settings.verse.textAlign")}>
            <Select
              className="w-52"
              onChange={(align) => patch({ textAlign: align as TextAlign })}
              options={TEXT_ALIGNS.map((align) => ({ label: t(ALIGN_LABEL[align]), value: align }))}
              size="md"
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
              format={(value) => `${value}%`}
              label={t("settings.verse.maxWidth")}
              max={BIBLE_MAX_WIDTH_MAX_CQW}
              min={BIBLE_MAX_WIDTH_MIN_CQW}
              onChange={(maxWidthCqw) => patch({ maxWidthCqw })}
              step={1}
              value={style.maxWidthCqw}
            />
          </FieldRow>
        </FieldGroup>

        <FieldGroup title={t("settings.verse.groups.verse")}>
          <TextStyleFields
            onChange={(text) => patch({ text })}
            sizeRange={VERSE_SIZE_RANGE}
            t={t}
            value={style.text}
          />
        </FieldGroup>

        <FieldGroup title={t("settings.verse.groups.autoFit")}>
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
              readoutChars={5}
              step={0.1}
              value={Math.min(style.autoFit.minSizeCqw, style.text.sizeCqw)}
            />
          </FieldRow>
        </FieldGroup>

        <FieldGroup title={t("settings.verse.groups.reference")}>
          <FieldRow description={t("settings.verse.showReferenceHint")} label={t("settings.verse.showReference")}>
            <Switch checked={style.showReference} onChange={(e) => patch({ showReference: e.target.checked })} />
          </FieldRow>
          {/* Everything below describes a line that is not being drawn when the
              switch above is off. Hidden rather than disabled: a group of six
              dead controls reads as something broken. */}
          {style.showReference ? (
            <>
              <FieldRow label={t("settings.verse.referencePosition")}>
                <Select
                  className="w-52"
                  onChange={(position) => patch({ referencePosition: position as ReferencePosition })}
                  options={REFERENCE_POSITIONS.map((position) => ({
                    label: t(POSITION_LABEL[position]),
                    value: position,
                  }))}
                  size="md"
                  value={style.referencePosition}
                />
              </FieldRow>
              <FieldRow label={t("settings.verse.referenceCase")}>
                <Select
                  className="w-52"
                  onChange={(next) => patch({ referenceCase: next as TextCase })}
                  options={TEXT_CASES.map((next) => ({ label: t(CASE_LABEL[next]), value: next }))}
                  size="md"
                  value={style.referenceCase}
                />
              </FieldRow>
              <FieldRow
                description={t("settings.verse.versionDisplayHint")}
                label={t("settings.verse.versionDisplay")}
              >
                <Select
                  className="w-52"
                  onChange={(next) => patch({ versionDisplay: next as VersionDisplay })}
                  options={VERSION_DISPLAYS.map((next) => ({
                    label: t(VERSION_DISPLAY_LABEL[next]),
                    value: next,
                  }))}
                  size="md"
                  value={style.versionDisplay}
                />
              </FieldRow>
              <TextStyleFields
                onChange={(reference) => patch({ reference })}
                sizeRange={REFERENCE_SIZE_RANGE}
                t={t}
                value={style.reference}
              />
            </>
          ) : null}
        </FieldGroup>

        <FieldGroup title={t("settings.verse.reset")}>
          <FieldRow description={t("settings.verse.resetDesc")} label={t("settings.verse.reset")}>
            <Button onClick={() => setConfirmingReset(true)} size="md" variant="outline">
              <Icon name="restart" />
              {t("settings.verse.reset")}
            </Button>
          </FieldRow>
        </FieldGroup>
      </div>

      <ConfirmModal
        description={t("settings.verse.resetBody")}
        onConfirm={async () => {
          setPendingImage(null);
          await update({ "bible.style": DEFAULT_BIBLE_STYLE });
          toast.success(t("settings.verse.resetDone"));
        }}
        onOpenChange={setConfirmingReset}
        open={confirmingReset}
        title={t("settings.verse.resetTitle")}
      />
    </div>
  );
}
