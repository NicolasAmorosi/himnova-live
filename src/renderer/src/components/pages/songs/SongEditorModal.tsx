import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@renderer/lib/i18n/i18n-provider";
import { ConfirmModal } from "@renderer/components/shared/modal";
import { EditorScreen } from "@renderer/components/shared/editor-screen";
import { OutputView } from "@renderer/components/shared/output-view";
import { SongSlideGrid } from "@renderer/components/shared/song-slide-grid";
import {
  Button,
  Callout,
  Caption,
  FieldRow,
  Input,
  Inspector,
  InspectorSection,
  Monitor,
  Select,
  Textarea,
  Tabs,
  Title,
  type MenuOption,
} from "@renderer/components/ui";
import { toast } from "@renderer/lib/toast";
import { useSongFit } from "@renderer/lib/song-fit";
import { footerAt, slideLines, slideTranslation, songOutputFor } from "@renderer/lib/song-output";
import { duplicateSong, saveSong, songDeleteTarget, type SongDeleteTarget } from "@renderer/lib/actions/songs";
import { findSong, resolveSong, themeForSong, useSongStore } from "@renderer/stores/song.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { INSTANT_TRANSITION, type ProjectionOutput } from "@shared/types/projection";
import {
  caretAtSlide,
  missingOrderKeys,
  parseSectionKey,
  sectionLabel,
  serializeLyrics,
  slideAtCaret,
  translationFor,
} from "@shared/song-text";
import {
  SONG_FIELD_MAX_LENGTH,
  SONG_NOTES_MAX_LENGTH,
  SONG_TITLE_MAX_LENGTH,
  type SongProblem,
} from "@shared/song-validators";
import { songFileLimits } from "@shared/song-file-limits";
import type { Song } from "@shared/types/song";
import {
  emptySongDraft,
  parseDraft,
  shownOrder,
  songDraftProblem,
  toSongDraft,
  toSongUpsert,
  withHeadersWritten,
  type SongDraft,
} from "./song-draft";
import { DeleteSongConfirm } from "./delete-song-confirm";
import { SongOrderField } from "./song-order-field";


type SongEditorModalProps = {
  onOpenChange: (open: boolean) => void;
  /** After a save: the tab previews what was saved. */
  onSaved: (song: Song) => void;
  open: boolean;
  /** `null` = a new song. */
  songId: number | null;
};

/**
 * One song, full screen (2026-11-04 redesign): its slides on the left, its
 * lyrics as text in the middle, and on the right the slide chosen — drawn by
 * the projector's own `OutputView` at the song's one size — with its theme,
 * its order and its data. The title is the name in the bar.
 *
 * The caret and the slides go together (owner, 2026-11-04): the caret in the
 * lyrics picks its slide on both sides, and a click on a slide puts the caret
 * at the start of its words (`slideAtCaret` / `caretAtSlide`).
 *
 * Saved by hand like the scene and plate editors — a song can be live while
 * it is edited — and a live song is re-dressed in place on save
 * (`refreshLiveSong`), on the same section and slide.
 */
export function SongEditorModal({ onOpenChange, onSaved, open, songId }: SongEditorModalProps) {
  const { locale, t } = useI18n();
  const songs = useSongStore((s) => s.songs);
  const themes = useSongStore((s) => s.themes);
  const defaultThemeId = useSettingsStore((s) => s.settings["songs.defaultThemeId"]);
  const license = useSettingsStore((s) => s.settings["songs.ccliLicense"]);
  const [currentId, setCurrentId] = useState<number | null>(songId);
  const [draft, setDraft] = useState<SongDraft>(emptySongDraft);
  const [baseline, setBaseline] = useState<SongDraft>(emptySongDraft);
  /** The slide chosen with a click, 1-based. */
  const [selected, setSelected] = useState(1);
  /** Where the caret is in the lyrics; `null` until the operator puts it there. */
  const [caret, setCaret] = useState<number | null>(null);
  /** Which text the lyrics zone shows: the lyrics, or their translation. */
  const [textTab, setTextTab] = useState<"lyrics" | "translation">("lyrics");
  /** Leaving with unsaved changes: what to do once the operator discards them. */
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null);
  const [deleting, setDeleting] = useState<SongDeleteTarget | null>(null);
  const [saving, setSaving] = useState(false);
  /** The save in flight: ⌘S and a click — or the leave dialog's «Guardar y
   *  salir» — at once share it, never creating the song twice. */
  const savingRef = useRef<Promise<boolean> | null>(null);
  const lyricsRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Opening loads the song asked for, once — never again under the operator's typing.
  useEffect(() => {
    if (!open) return;
    const song = findSong(useSongStore.getState().songs, songId);
    const loaded = song ? toSongDraft(song, locale) : emptySongDraft();
    setCurrentId(song?.id ?? null);
    setDraft(loaded);
    setBaseline(loaded);
    setSelected(1);
    setCaret(null);
    setTextTab("lyrics");
    setPendingDiscard(null);
    setDeleting(null);
    // A new song is named first (2026-11-05 review: the caret went to the
    // lyrics and the empty title read as a heading). On the next frame, so it
    // lands after the dialog has put its own first focus.
    if (!song) requestAnimationFrame(() => nameRef.current?.focus());
    // `locale` only shapes the headers of a song being opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, songId]);

  const parsed = useMemo(() => parseDraft(draft, locale), [draft, locale]);
  const baselineParsed = useMemo(() => parseDraft(baseline, locale), [baseline, locale]);
  const order = shownOrder(draft, parsed);
  const theme = themeForSong({ themeId: draft.themeId }, themes, defaultThemeId);
  // The draft as a song, so the preview is resolved — split, footer and all —
  // exactly as the projector will resolve it once saved.
  const draftSong: Song = useMemo(
    () => ({ ...toSongUpsert(draft, parsed, null), id: currentId ?? 0, updatedAt: 0, sourceFolder: null, file: null }),
    [currentId, draft, parsed],
  );
  const preview = resolveSong(draftSong, theme, license);
  const fit = useSongFit(preview, theme);

  const upsert = toSongUpsert(draft, parsed, null);
  const dirty = JSON.stringify(upsert) !== JSON.stringify(toSongUpsert(baseline, baselineParsed, null));
  const problem = songDraftProblem(draft, parsed);
  const canSave = problem === null && (currentId === null || dirty);

  const missing = missingOrderKeys(parsed.sections, order);
  // What is really projected: an empty order, or one naming only sections
  // that are gone, is the song as written (`songDeckSlides`).
  const projected = new Set(preview.slides.map((slide) => slide.sectionKey));
  const unused = parsed.sections.filter((section) => !projected.has(section.key));
  const overflowing = new Set(fit?.overflowing ?? []);
  // Every section, not only the order's: a detour is drawn at the same size.
  const overflowingLabels = preview.sections
    .filter((section) => section.slides.some((slide) => overflowing.has(slide.lines.join("\n"))))
    .map((section) => sectionLabel(section.type, section.number, locale));
  const labelOf = (key: string) => {
    const section = parseSectionKey(key);
    return section ? sectionLabel(section.type, section.number, locale) : key;
  };
  /** Why «Guardar» is off, naming the limit (2026-11-06). */
  const problemText = (found: SongProblem) => {
    switch (found.kind) {
      case "basic":
      case "shape":
        return t("songs.invalidHint");
      case "sections":
      case "order":
        return t(`songs.limits.${found.kind}`, { max: found.max });
      default:
        return t(`songs.limits.${found.kind}`, { max: found.max, section: labelOf(found.section) });
    }
  };

  // The caret's slide when it is on one that is projected, else the one clicked.
  const caretSlide =
    caret === null ? null : slideAtCaret(draft.lyrics, caret, locale, theme.maxLines, preview.slides, selected - 1);
  const slideIndex = Math.min(Math.max(1, caretSlide === null ? selected : caretSlide + 1), Math.max(1, preview.slides.length));
  const shownSlide = preview.slides[slideIndex - 1];
  // With no lyrics yet, the theme's background alone — never a black box.
  const emptyStage: ProjectionOutput = {
    ...songOutputFor(preview, [], theme, 1),
    videoUnderlay: null,
    slideVideo: null,
    plates: [],
    transition: INSTANT_TRANSITION,
  };
  const output: ProjectionOutput | null =
    preview.slides.length === 0
      ? emptyStage
      : fit
      ? {
          ...songOutputFor(
            preview,
            slideLines(preview, slideIndex),
            theme,
            fit.sizeCqw,
            footerAt(preview, theme, { slideIndex, detour: null }),
            null,
            slideTranslation(preview, slideIndex),
          ),
          videoUnderlay: null,
          slideVideo: null,
          plates: [],
          transition: INSTANT_TRANSITION,
        }
      : null;

  const patch = (next: Partial<SongDraft>) => setDraft((current) => ({ ...current, ...next }));

  /** The lyrics replaced from outside the textarea: the caret's offset no longer means anything. */
  function replaceDraft(next: SongDraft) {
    setDraft(next);
    setCaret(null);
  }

  function selectSlide(index: number) {
    setSelected(index);
    const slide = preview.slides[index - 1];
    const offset = slide ? caretAtSlide(draft.lyrics, locale, theme.maxLines, slide) : null;
    // Moved even when the lyrics are not mounted to focus («Traducción» on
    // top): a caret left on another slide would keep choosing that one.
    setCaret(offset);
    const lyrics = lyricsRef.current;
    if (offset === null || !lyrics) return;
    lyrics.focus();
    lyrics.setSelectionRange(offset, offset);
  }

  function leaveEditing(go: () => void) {
    if (dirty) setPendingDiscard(() => go);
    else go();
  }

  function show(song: Song) {
    const loaded = toSongDraft(song, locale);
    setCurrentId(song.id);
    // Saved as it was typed: the caret stays where it was. Written back
    // otherwise (numbered headers…), its offset means nothing any more.
    if (loaded.lyrics === draft.lyrics) setDraft(loaded);
    else replaceDraft(loaded);
    setBaseline(loaded);
  }

  function handleSave(): Promise<boolean> {
    savingRef.current ??= save().finally(() => {
      savingRef.current = null;
    });
    return savingRef.current;
  }

  async function save(): Promise<boolean> {
    if (!canSave) return false;
    setSaving(true);
    try {
      const saved = await saveSong(toSongUpsert(draft, parsed, currentId));
      if (!saved) return false;
      show(saved);
      onSaved(saved);
      toast.success(t("songs.saved", { title: saved.title }));
      return true;
    } finally {
      setSaving(false);
    }
  }

  async function handleDuplicate() {
    // The store now, not this render's: «Guardar y salir» may have just renamed it.
    const source = findSong(useSongStore.getState().songs, currentId);
    if (!source) return;
    const copy = await duplicateSong(source.id, t("songs.copyName", { title: source.title }));
    if (copy) {
      show(copy);
      onSaved(copy);
    }
  }

  async function askToDelete(id: number) {
    setDeleting(await songDeleteTarget(id));
  }

  /** A song read from a linked folder's file: saving writes the file too, and
   *  it is never deleted from here — its file would bring it back, and the app
   *  never deletes a file of the operator's. A duplicate is a library song. */
  const current = findSong(songs, currentId);
  const sourceFolder = current?.sourceFolder ?? null;
  // What saving never puts in the file (owner, 2026-11-06: «keep + warn»).
  const fileLimits = current?.file ? songFileLimits(current.file) : [];
  const menuOptions: MenuOption<"duplicate" | "delete">[] = [
    { disabled: currentId === null, label: t("common.duplicate"), value: "duplicate" },
    ...(sourceFolder === null
      ? [{ disabled: currentId === null, label: t("common.delete"), tone: "danger" as const, value: "delete" as const }]
      : []),
  ];

  return (
    <>
      <EditorScreen
        inspector={
          <Inspector label={t("songs.editTitle")}>
            <div className="flex flex-col gap-3 border-b border-border pb-4">
              <Monitor>{output ? <OutputView mode="preview" output={output} /> : null}</Monitor>
              <div className="flex flex-col gap-3 px-4">
                {shownSlide ? (
                  <Caption>
                    {t("songs.counter", { current: slideIndex, total: preview.slides.length })} ·{" "}
                    {sectionLabel(shownSlide.type, shownSlide.number, locale)}
                  </Caption>
                ) : (
                  <Caption>{t("songs.previewEmpty")}</Caption>
                )}
                <FieldRow description={t("songs.themeHint")} label={t("songs.theme")}>
                  <Select
                    onChange={(value) => patch({ themeId: value === "" ? null : Number(value) })}
                    options={[
                      { label: t("songs.themeDefault"), value: "" },
                      ...themes.map((row) => ({ label: row.name, value: String(row.id) })),
                    ]}
                    value={draft.themeId === null ? "" : String(draft.themeId)}
                  />
                </FieldRow>
              </div>
            </div>

            {/* Nothing to order before the first section exists. */}
            {parsed.sections.length > 0 ? (
              <InspectorSection title={t("songs.groups.order")}>
                <SongOrderField
                  custom={draft.order !== null}
                  onChange={(next) => patch({ order: next })}
                  onReset={() => patch({ order: null })}
                  order={order}
                  sections={parsed.sections}
                />
                {missing.length > 0 ? (
                  <Callout className="mt-2 py-2" role="status" tone="warning">
                    {t(order.every((key) => missing.includes(key)) ? "songs.orderNoneHint" : "songs.orderMissingHint", {
                      sections: missing.map(labelOf).join(", "),
                    })}
                  </Callout>
                ) : null}
                {draft.order !== null && unused.length > 0 ? (
                  <Callout className="mt-2 py-2" role="status" tone="info">
                    {t("songs.orderUnusedHint", {
                      sections: unused.map((s) => sectionLabel(s.type, s.number, locale)).join(", "),
                    })}
                  </Callout>
                ) : null}
              </InspectorSection>
            ) : null}

            <InspectorSection title={t("songs.groups.data")}>
              {current?.file ? (
                <Callout className="py-2 break-all" role="note" tone="info">
                  {t("songs.fileSaveHint", { file: current.file })}
                  {fileLimits.length > 0
                    ? ` ${t("songs.fileLimits", {
                        fields: new Intl.ListFormat(locale, { type: "conjunction" }).format(
                          fileLimits.map((field) => t(`songs.fileFields.${field}`)),
                        ),
                      })}`
                    : null}
                </Callout>
              ) : null}
              <FieldRow description={t("songs.numberHint")} label={t("songs.number")}>
                <Input
                  aria-label={t("songs.number")}
                  maxLength={SONG_FIELD_MAX_LENGTH}
                  onChange={(e) => patch({ number: e.target.value })}
                  value={draft.number}
                />
              </FieldRow>
              <FieldRow label={t("songs.authors")}>
                <Input
                  aria-label={t("songs.authors")}
                  maxLength={SONG_FIELD_MAX_LENGTH}
                  onChange={(e) => patch({ authors: e.target.value })}
                  value={draft.authors}
                />
              </FieldRow>
              <FieldRow label={t("songs.copyright")}>
                <Input
                  aria-label={t("songs.copyright")}
                  maxLength={SONG_FIELD_MAX_LENGTH}
                  onChange={(e) => patch({ copyright: e.target.value })}
                  value={draft.copyright}
                />
              </FieldRow>
              <FieldRow label={t("songs.ccli")}>
                <Input
                  aria-label={t("songs.ccli")}
                  maxLength={SONG_FIELD_MAX_LENGTH}
                  onChange={(e) => patch({ ccliNumber: e.target.value })}
                  value={draft.ccliNumber}
                />
              </FieldRow>
              <FieldRow label={t("songs.notes")} layout="stacked">
                <Textarea
                  aria-label={t("songs.notes")}
                  maxLength={SONG_NOTES_MAX_LENGTH}
                  onChange={(e) => patch({ notes: e.target.value })}
                  rows={3}
                  value={draft.notes}
                />
              </FieldRow>
            </InspectorSection>
          </Inspector>
        }
        list={
          <>
            <div className="flex h-10 shrink-0 items-center px-4">
              <Title as="h3">{t("songs.slides")}</Title>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {/* A new song's column said nothing at all (2026-11-04 review). */}
              {preview.slides.length === 0 ? <Caption className="block px-2">{t("songs.slidesEmpty")}</Caption> : null}
              <SongSlideGrid
                columns={1}
                liveIndex={null}
                onSelect={selectSlide}
                scrollToIndex={slideIndex}
                selectedIndex={slideIndex}
                song={preview}
                theme={theme}
              />
            </div>
          </>
        }
        // A song not saved yet has nothing to duplicate or delete: no «⋯» of
        // two greyed commands (2026-11-05 review).
        menu={
          currentId === null
            ? undefined
            : {
                onSelect: (command) => {
                  if (command === "duplicate") leaveEditing(() => void handleDuplicate());
                  else void askToDelete(currentId);
                },
                options: menuOptions,
              }
        }
        name={{
          label: t("songs.title"),
          maxLength: SONG_TITLE_MAX_LENGTH,
          onChange: (title) => patch({ title }),
          placeholder: t("songs.newTitle"),
          ref: nameRef,
          value: draft.title,
        }}
        onClose={() => leaveEditing(() => onOpenChange(false))}
        open={open}
        save={{
          canSave,
          dirty,
          onDiscard: () => replaceDraft(baseline),
          onSave: () => void handleSave(),
          saving,
        }}
        title={t("songs.tab")}
      >
        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-2 p-6">
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <Tabs
                // Not a bar of the main window: as tall as the button beside it.
                className="h-auto py-0.5"
                onChange={setTextTab}
                tabs={[
                  { label: t("songs.groups.lyrics"), value: "lyrics" },
                  { label: t("songs.groups.translation"), value: "translation" },
                ]}
                value={textTab}
                variant="segment"
              />
            </div>
            <Button
              disabled={textTab === "lyrics" ? parsed.sections.length === 0 : draft.translation.trim() === ""}
              onClick={() =>
                textTab === "lyrics"
                  ? replaceDraft(withHeadersWritten(draft, parsed, locale))
                  : // Pasted without headers, it gets the lyrics' own: paired as before.
                    patch({ translation: serializeLyrics(translationFor(draft.lyrics, draft.translation, locale), locale) })
              }
              size="xs"
              title={t("songs.writeHeadersHint")}
              variant="outline"
            >
              {t("songs.writeHeaders")}
            </Button>
          </div>
          {textTab === "lyrics" ? (
            <Textarea
              aria-label={t("songs.groups.lyrics")}
              className="min-h-0 flex-1"
              onChange={(e) => {
                patch({ lyrics: e.target.value });
                setCaret(e.target.selectionStart);
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
              placeholder={t("songs.lyricsPlaceholder")}
              ref={lyricsRef}
              spellCheck={false}
              value={draft.lyrics}
            />
          ) : (
            // Its own text: the caret ↔ slide link stays with the lyrics.
            <Textarea
              aria-label={t("songs.groups.translation")}
              className="min-h-0 flex-1"
              onChange={(e) => patch({ translation: e.target.value })}
              placeholder={t("songs.translationPlaceholder")}
              spellCheck={false}
              value={draft.translation}
            />
          )}
          <Caption>{textTab === "lyrics" ? t("songs.lyricsHint") : t("songs.translationHint")}</Caption>
          {/* Not before anything was typed: a new song opened under a warning. */}
          {problem && dirty ? (
            <Callout className="py-2" role="status" tone="warning">
              {problemText(problem)}
            </Callout>
          ) : null}
          {overflowingLabels.length > 0 ? (
            <Callout className="py-2" role="status" tone="warning">
              {t("songs.overflowHint", { sections: overflowingLabels.join(", ") })}
            </Callout>
          ) : null}
        </div>
      </EditorScreen>

      <ConfirmModal
        confirmLabel={t("songs.discard")}
        description={t("songs.discardBody")}
        onConfirm={() => pendingDiscard?.()}
        onSave={canSave ? handleSave : undefined}
        onOpenChange={(next) => {
          if (!next) setPendingDiscard(null);
        }}
        open={pendingDiscard !== null}
        title={t("songs.discardTitle")}
      />
      <DeleteSongConfirm
        onDeleted={() => onOpenChange(false)}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
        target={deleting}
      />
    </>
  );
}
