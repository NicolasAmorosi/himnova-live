import { useEffect, useMemo, useState } from "react";
import { useI18n, type MessageKey } from "@renderer/lib/i18n/i18n-provider";
import { ConfirmModal } from "@renderer/components/shared/modal";
import { EditorScreen, EditorStage } from "@renderer/components/shared/editor-screen";
import { OutputView } from "@renderer/components/shared/output-view";
import {
  BackgroundFields,
  FontFamilyFields,
  TextStyleFields,
  VerticalAlignField,
  type TextSizeRange,
} from "@renderer/components/shared/style-fields";
import {
  ColorField,
  FieldRow,
  Inspector,
  InspectorSection,
  ListRow,
  Select,
  Slider,
  Switch,
  type MenuOption,
} from "@renderer/components/ui";
import { api } from "@renderer/lib/api";
import { toast } from "@renderer/lib/toast";
import { transitionDurationOptions } from "@renderer/lib/transition";
import { useSongFit } from "@renderer/lib/song-fit";
import { songOutputFor, slideLines } from "@renderer/lib/song-output";
import { deleteSongTheme, saveSongTheme } from "@renderer/lib/actions/songs";
import { findSong, resolveSong, useSongStore } from "@renderer/stores/song.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { isSongThemeUpsert } from "@shared/song-validators";
import { parseLyrics } from "@shared/song-text";
import { BIBLE_LINE_HEIGHT_MAX, BIBLE_LINE_HEIGHT_MIN, TEXT_ALIGNS, type TextAlign } from "@shared/types/bible-style";
import { INSTANT_TRANSITION, type ProjectionOutput } from "@shared/types/projection";
import type { MediaAsset } from "@shared/types/media";
import type { SongBackground } from "@shared/types/song";
import {
  DEFAULT_SONG_THEME,
  SONG_FOOTER_ALIGNS,
  SONG_FOOTER_SHOWS,
  SONG_LETTER_SPACING_MAX_EM,
  SONG_LETTER_SPACING_MIN_EM,
  SONG_MARGIN_MAX_CQW,
  SONG_MAX_LINES_MAX,
  SONG_OUTLINE_MAX_CQW,
  SONG_THEME_NAME_MAX_LENGTH,
  type Song,
  type SongFooterAlign,
  type SongFooterFields,
  type SongFooterShow,
  type SongMargins,
  type SongTheme,
} from "@shared/types/song";

type Draft = { name: string; style: SongTheme };
type Editing = { themeId: number | null; draft: Draft; baseline: Draft };
type Pending = { kind: "discard"; go: () => void } | { kind: "delete"; themeId: number };

const ALIGN_LABEL: Record<TextAlign, MessageKey> = {
  left: "settings.verse.align.left",
  center: "settings.verse.align.center",
  right: "settings.verse.align.right",
  justify: "settings.verse.align.justify",
};

const FOOTER_SHOW_LABEL: Record<SongFooterShow, MessageKey> = {
  never: "songThemes.footerShow.never",
  first: "songThemes.footerShow.first",
  last: "songThemes.footerShow.last",
  firstAndLast: "songThemes.footerShow.firstAndLast",
  all: "songThemes.footerShow.all",
};

const FOOTER_FIELD_LABEL: Record<keyof SongFooterFields, MessageKey> = {
  title: "songs.title",
  authors: "songs.authors",
  copyright: "songs.copyright",
  ccli: "songs.ccli",
  license: "songThemes.license",
};

const MARGIN_LABEL: Record<keyof SongMargins, MessageKey> = {
  top: "songThemes.margins.top",
  bottom: "songThemes.margins.bottom",
  left: "songThemes.margins.left",
  right: "songThemes.margins.right",
};

/** The lyrics' ceiling and floor: a song is sung, not read up close. */
const LYRICS_SIZE_RANGE: TextSizeRange = { max: 15, min: 1, step: 0.1 };
const FOOTER_SIZE_RANGE: TextSizeRange = { max: 4, min: 0.5, step: 0.1 };

/** What the preview sings when no song is previewed. */
const SAMPLE: Song = {
  id: 0,
  title: "Sublime gracia",
  number: null,
  authors: "John Newton",
  copyright: "Dominio público",
  ccliNumber: "22025",
  notes: null,
  sections: parseLyrics("[Estrofa 1]\nSublime gracia del Señor\nque a un pecador salvó\nfui ciego mas hoy veo yo\nperdido y él me halló", "es").sections,
  order: [],
  themeId: null,
  updatedAt: 0,
};

const toDraft = (row: { name: string; style: SongTheme }): Draft => ({ name: row.name, style: row.style });

/**
 * The named song themes (owner, 2026-11-04: flexible — spacing, sizes,
 * colours). The same layout and explicit save as the plate editor; the
 * preview sings the song in PREVIEW (or a sample), through the projector's own
 * `OutputView`, at the size the theme gives it — with the footer drawn when
 * the theme shows one. Saving re-dresses the live song in place.
 */
export function SongThemesModal({ onOpenChange, open }: { onOpenChange: (open: boolean) => void; open: boolean }) {
  const { t } = useI18n();
  const themes = useSongStore((s) => s.themes);
  const songs = useSongStore((s) => s.songs);
  const target = usePreviewStore((s) => s.target);
  const license = useSettingsStore((s) => s.settings["songs.ccliLicense"]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);
  const [imageAssets, setImageAssets] = useState<readonly MediaAsset[]>([]);
  const [addingImages, setAddingImages] = useState(false);
  const [videoAssets, setVideoAssets] = useState<readonly MediaAsset[]>([]);
  const [addingVideos, setAddingVideos] = useState(false);
  /** An image or video background with nothing chosen yet: shown, not saved. */
  const [pendingBackground, setPendingBackground] = useState<SongBackground | null>(null);

  useEffect(() => {
    if (!open) {
      setEditing(null);
      setPending(null);
      return;
    }
    void api.library
      .list("image")
      .then(setImageAssets)
      .catch((error: unknown) => console.warn("[songThemes] could not list the image library", error));
    void api.library
      .list("video")
      .then(setVideoAssets)
      .catch((error: unknown) => console.warn("[songThemes] could not list the video library", error));
    setEditing((current) => {
      if (current) return current;
      const first = themes[0];
      return first ? { themeId: first.id, draft: toDraft(first), baseline: toDraft(first) } : null;
    });
  }, [open, themes]);

  const dirty = editing !== null && JSON.stringify(editing.draft) !== JSON.stringify(editing.baseline);
  const savable = editing !== null && isSongThemeUpsert(editing.draft);
  const canSave = savable && (editing.themeId === null || dirty);

  const sung = (target?.kind === "song" ? findSong(songs, target.songId) : null) ?? SAMPLE;
  const style = editing?.draft.style ?? DEFAULT_SONG_THEME;
  const preview = useMemo(() => resolveSong(sung, style, license), [sung, style, license]);
  const fit = useSongFit(preview, style);
  const output: ProjectionOutput | null = fit
    ? {
        ...songOutputFor(
          preview,
          slideLines(preview, 1),
          style,
          fit.sizeCqw,
          style.footer.show === "never" ? null : preview.footer,
        ),
        videoUnderlay: null,
        slideVideo: null,
        plates: [],
        transition: INSTANT_TRANSITION,
      }
    : null;

  function leaveEditing(go: () => void) {
    if (dirty) setPending({ kind: "discard", go });
    else go();
  }

  const patchStyle = (next: Partial<SongTheme>) =>
    setEditing((current) => (current ? { ...current, draft: { ...current.draft, style: { ...current.draft.style, ...next } } } : current));
  const patchFooter = (next: Partial<SongTheme["footer"]>) => patchStyle({ footer: { ...style.footer, ...next } });

  function createNew(from: Draft = { name: t("songThemes.newName"), style: DEFAULT_SONG_THEME }) {
    leaveEditing(() => setEditing({ themeId: null, draft: from, baseline: from }));
  }

  async function handleSave() {
    if (!editing || !canSave) return;
    setSaving(true);
    try {
      const saved = await saveSongTheme(
        editing.themeId === null ? editing.draft : { ...editing.draft, id: editing.themeId },
      );
      if (!saved) return;
      setEditing({ themeId: saved.id, draft: toDraft(saved), baseline: toDraft(saved) });
      toast.success(t("songThemes.saved", { name: saved.name }));
    } finally {
      setSaving(false);
    }
  }

  /** A copy of what is SAVED, saved at once and chosen — the other editors'
   *  «Duplicate» (it used to copy the draft, discarded changes included). */
  async function handleDuplicate(source: Draft) {
    const copy = await saveSongTheme({ name: t("songThemes.copyName", { name: source.name }), style: source.style });
    if (!copy) return;
    setEditing({ themeId: copy.id, draft: toDraft(copy), baseline: toDraft(copy) });
    toast.success(t("songThemes.saved", { name: copy.name }));
  }

  async function handleAddImages() {
    setAddingImages(true);
    try {
      const paths = await api.files.pick("image", true);
      if (paths.length === 0) return;
      const added = await api.library.add(paths, "image");
      setImageAssets(await api.library.list("image"));
      const first = added[0];
      if (first) {
        setPendingBackground(null);
        patchStyle({ background: { kind: "image", assetId: first.id, fit: "cover" } });
      }
    } catch (error) {
      console.warn("[songThemes] could not add images", error);
      toast.danger(t("style.addImageError"));
    } finally {
      setAddingImages(false);
    }
  }

  async function handleAddVideos() {
    setAddingVideos(true);
    try {
      const paths = await api.files.pick("video", true);
      if (paths.length === 0) return;
      const added = await api.library.add(paths, "video");
      setVideoAssets(await api.library.list("video"));
      const first = added[0];
      if (first) {
        setPendingBackground(null);
        patchStyle({ background: { kind: "video", assetId: first.id, fit: "cover" } });
      }
    } catch (error) {
      console.warn("[songThemes] could not add videos", error);
      toast.danger(t("style.addVideoError"));
    } finally {
      setAddingVideos(false);
    }
  }

  const menuOptions: MenuOption<"duplicate" | "delete">[] = [
    { disabled: editing?.themeId == null, label: t("common.duplicate"), value: "duplicate" },
    // The last theme stays: a song always has a look to fall back to.
    { disabled: editing?.themeId == null || themes.length <= 1, label: t("common.delete"), tone: "danger", value: "delete" },
  ];

  return (
    <>
      <EditorScreen
        inspector={
          editing ? (
            <Inspector key={editing.themeId ?? "new"} label={t("songThemes.title")}>
          <InspectorSection title={t("style.groups.background")}>
            <BackgroundFields<SongBackground>
              addingImages={addingImages}
              addingVideos={addingVideos}
              imageAssets={imageAssets}
              kinds={["solid", "gradient", "image", "video"]}
              onAddImages={() => void handleAddImages()}
              onAddVideos={() => void handleAddVideos()}
              onChange={(background) => {
                const nothingYet = (background.kind === "image" || background.kind === "video") && background.assetId === 0;
                setPendingBackground(nothingYet ? background : null);
                if (!nothingYet) patchStyle({ background });
              }}
              value={pendingBackground ?? style.background}
              videoAssets={videoAssets}
            />
          </InspectorSection>

          <InspectorSection title={t("songThemes.groups.lyrics")}>
            <FontFamilyFields onChange={(fontFamily) => patchStyle({ fontFamily })} value={style.fontFamily} />
            <TextStyleFields
              onChange={(text) => patchStyle({ text })}
              sizeRange={LYRICS_SIZE_RANGE}
              t={t}
              value={style.text}
            />
            <FieldRow description={t("songThemes.minSizeHint")} label={t("songThemes.minSize")}>
              <Slider
                label={t("songThemes.minSize")}
                max={style.text.sizeCqw}
                min={LYRICS_SIZE_RANGE.min}
                onChange={(minSizeCqw) => patchStyle({ minSizeCqw: Number(minSizeCqw.toFixed(1)) })}
                readoutChars={5}
                step={0.1}
                value={Math.min(style.minSizeCqw, style.text.sizeCqw)}
              />
            </FieldRow>
            <FieldRow label={t("songThemes.uppercase")}>
              <Switch checked={style.uppercase} onChange={(e) => patchStyle({ uppercase: e.target.checked })} />
            </FieldRow>
            <FieldRow label={t("songThemes.letterSpacing")}>
              <Slider
                format={(value) => value.toFixed(2)}
                label={t("songThemes.letterSpacing")}
                max={SONG_LETTER_SPACING_MAX_EM}
                min={SONG_LETTER_SPACING_MIN_EM}
                onChange={(letterSpacingEm) => patchStyle({ letterSpacingEm: Number(letterSpacingEm.toFixed(2)) })}
                readoutChars={5}
                step={0.01}
                value={style.letterSpacingEm}
              />
            </FieldRow>
            <FieldRow description={t("songThemes.outlineHint")} label={t("songThemes.outline")}>
              <Switch
                checked={style.outline.enabled}
                onChange={(e) => patchStyle({ outline: { ...style.outline, enabled: e.target.checked } })}
              />
            </FieldRow>
            {style.outline.enabled ? (
              <>
                <FieldRow label={t("songThemes.outlineColor")}>
                  <ColorField
                    label={t("songThemes.outlineColor")}
                    onChange={(color) => patchStyle({ outline: { ...style.outline, color } })}
                    value={style.outline.color}
                  />
                </FieldRow>
                <FieldRow label={t("songThemes.outlineWidth")}>
                  <Slider
                    format={(value) => value.toFixed(2)}
                    label={t("songThemes.outlineWidth")}
                    max={SONG_OUTLINE_MAX_CQW}
                    min={0.02}
                    onChange={(widthCqw) => patchStyle({ outline: { ...style.outline, widthCqw: Number(widthCqw.toFixed(2)) } })}
                    readoutChars={5}
                    step={0.02}
                    value={style.outline.widthCqw}
                  />
                </FieldRow>
              </>
            ) : null}
          </InspectorSection>

          <InspectorSection title={t("songThemes.groups.spacing")}>
            <VerticalAlignField onChange={(verticalAlign) => patchStyle({ verticalAlign })} value={style.verticalAlign} />
            <FieldRow label={t("settings.verse.textAlign")}>
              <Select
                className="w-52"
                onChange={(align) => patchStyle({ textAlign: align as TextAlign })}
                options={TEXT_ALIGNS.map((align) => ({ label: t(ALIGN_LABEL[align]), value: align }))}
                value={style.textAlign}
              />
            </FieldRow>
            <FieldRow label={t("settings.verse.lineHeight")}>
              <Slider
                format={(value) => value.toFixed(2)}
                label={t("settings.verse.lineHeight")}
                max={BIBLE_LINE_HEIGHT_MAX}
                min={BIBLE_LINE_HEIGHT_MIN}
                onChange={(lineHeight) => patchStyle({ lineHeight: Number(lineHeight.toFixed(2)) })}
                step={0.01}
                value={style.lineHeight}
              />
            </FieldRow>
            {(Object.keys(MARGIN_LABEL) as (keyof SongMargins)[]).map((side) => (
              <FieldRow key={side} label={t(MARGIN_LABEL[side])}>
                <Slider
                  format={(value) => value.toFixed(1)}
                  label={t(MARGIN_LABEL[side])}
                  max={SONG_MARGIN_MAX_CQW}
                  min={0}
                  onChange={(value) =>
                    patchStyle({ margins: { ...style.margins, [side]: Number(value.toFixed(1)) } })
                  }
                  readoutChars={5}
                  step={0.5}
                  value={style.margins[side]}
                />
              </FieldRow>
            ))}
            <FieldRow description={t("songThemes.maxLinesHint")} label={t("songThemes.maxLines")}>
              <Slider
                format={(value) => (value === 0 ? t("songThemes.noLimit") : String(value))}
                label={t("songThemes.maxLines")}
                max={SONG_MAX_LINES_MAX}
                min={0}
                onChange={(maxLines) => patchStyle({ maxLines: Math.round(maxLines) })}
                readoutChars={9}
                step={1}
                value={style.maxLines}
              />
            </FieldRow>
          </InspectorSection>

          <InspectorSection title={t("songThemes.groups.footer")}>
            <FieldRow description={t("songThemes.footerShowHint")} label={t("songThemes.footerShowLabel")}>
              <Select
                className="w-52"
                onChange={(show) => patchFooter({ show: show as SongFooterShow })}
                options={SONG_FOOTER_SHOWS.map((show) => ({ label: t(FOOTER_SHOW_LABEL[show]), value: show }))}
                value={style.footer.show}
              />
            </FieldRow>
            {style.footer.show === "never" ? null : (
              <>
                {(Object.keys(FOOTER_FIELD_LABEL) as (keyof SongFooterFields)[]).map((field) => (
                  <FieldRow key={field} label={t(FOOTER_FIELD_LABEL[field])}>
                    <Switch
                      checked={style.footer.fields[field]}
                      onChange={(e) =>
                        patchFooter({ fields: { ...style.footer.fields, [field]: e.target.checked } })
                      }
                    />
                  </FieldRow>
                ))}
                <FieldRow label={t("settings.verse.textAlign")}>
                  <Select
                    className="w-52"
                    onChange={(align) => patchFooter({ align: align as SongFooterAlign })}
                    options={SONG_FOOTER_ALIGNS.map((align) => ({ label: t(ALIGN_LABEL[align]), value: align }))}
                    value={style.footer.align}
                  />
                </FieldRow>
                <TextStyleFields
                  onChange={(text) => patchFooter({ text })}
                  sizeRange={FOOTER_SIZE_RANGE}
                  t={t}
                  value={style.footer.text}
                />
              </>
            )}
          </InspectorSection>

          <InspectorSection title={t("songThemes.groups.transition")}>
            <FieldRow description={t("songThemes.transitionHint")} label={t("songThemes.transition")}>
              <Select
                className="w-52"
                onChange={(value) =>
                  patchStyle({ slideTransition: { ...style.slideTransition, style: value as "cut" | "fade" } })
                }
                options={[
                  { label: t("songThemes.cut"), value: "cut" },
                  { label: t("songThemes.fade"), value: "fade" },
                ]}
                value={style.slideTransition.style}
              />
            </FieldRow>
            {style.slideTransition.style === "fade" ? (
              <FieldRow label={t("songThemes.duration")}>
                <Select
                  className="w-52"
                  onChange={(value) =>
                    patchStyle({ slideTransition: { ...style.slideTransition, durationMs: Number(value) } })
                  }
                  options={transitionDurationOptions(t)}
                  value={String(style.slideTransition.durationMs)}
                />
              </FieldRow>
            ) : null}
          </InspectorSection>
            </Inspector>
          ) : null
        }
        onNew={{ label: t("songThemes.new"), onClick: () => createNew() }}
        list={
          <>
            <ul aria-label={t("songThemes.listLabel")} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
              {themes.map((theme) => (
                <ListRow
                  key={theme.id}
                  onClick={() =>
                    leaveEditing(() => setEditing({ themeId: theme.id, draft: toDraft(theme), baseline: toDraft(theme) }))
                  }
                  selected={editing?.themeId === theme.id}
                >
                  {theme.name}
                </ListRow>
              ))}
              {editing?.themeId === null ? <ListRow selected>{editing.draft.name}</ListRow> : null}
            </ul>
          </>
        }
        menu={{
          onSelect: (command) => {
            if (!editing || editing.themeId === null) return;
            if (command === "duplicate") {
              const source = themes.find((theme) => theme.id === editing.themeId);
              if (source) leaveEditing(() => void handleDuplicate(source));
            } else if (themes.length > 1) {
              setPending({ kind: "delete", themeId: editing.themeId });
            }
          },
          options: menuOptions,
        }}
        name={
          editing
            ? {
                label: t("songThemes.name"),
                maxLength: SONG_THEME_NAME_MAX_LENGTH,
                onChange: (name) => setEditing({ ...editing, draft: { ...editing.draft, name } }),
                value: editing.draft.name,
              }
            : undefined
        }
        onClose={() => leaveEditing(() => onOpenChange(false))}
        open={open}
        save={
          editing
            ? {
                canSave,
                dirty,
                onDiscard: () => setEditing({ ...editing, draft: editing.baseline }),
                onSave: () => void handleSave(),
                saving,
              }
            : undefined
        }
        title={t("songThemes.title")}
      >
        {editing ? (
          <EditorStage warning={savable ? undefined : t("songThemes.invalidHint")}>
            {output ? <OutputView mode="preview" output={output} /> : null}
          </EditorStage>
        ) : null}
      </EditorScreen>

      <ConfirmModal
        confirmLabel={pending?.kind === "delete" ? t("common.delete") : t("songThemes.discard")}
        danger={pending?.kind === "delete"}
        description={pending?.kind === "delete" ? t("songThemes.deleteBody") : t("songThemes.discardBody")}
        onConfirm={async () => {
          if (!pending) return;
          if (pending.kind === "discard") {
            pending.go();
            return;
          }
          if (!(await deleteSongTheme(pending.themeId))) return;
          const next = useSongStore.getState().themes[0];
          setEditing(next ? { themeId: next.id, draft: toDraft(next), baseline: toDraft(next) } : null);
        }}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
        open={pending !== null}
        title={pending?.kind === "delete" ? t("songThemes.deleteTitle") : t("songThemes.discardTitle")}
      />
    </>
  );
}
