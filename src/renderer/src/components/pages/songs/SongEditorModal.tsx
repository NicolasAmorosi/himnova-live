import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@renderer/lib/i18n/i18n-provider";
import { ConfirmModal } from "@renderer/components/shared/modal";
import { EditorScreen } from "@renderer/components/shared/editor-screen";
import { ProgramUsages } from "@renderer/components/shared/program-usages";
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
  Title,
  type MenuOption,
} from "@renderer/components/ui";
import { toast } from "@renderer/lib/toast";
import { useSongFit } from "@renderer/lib/song-fit";
import { footerAt, slideLines, songOutputFor } from "@renderer/lib/song-output";
import { deleteSong, duplicateSong, isSongLive, saveSong, songUsages } from "@renderer/lib/actions/songs";
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
} from "@shared/song-text";
import { SONG_FIELD_MAX_LENGTH, SONG_NOTES_MAX_LENGTH, SONG_TITLE_MAX_LENGTH } from "@shared/song-validators";
import type { Song, SongUsage } from "@shared/types/song";
import {
  emptySongDraft,
  isSongDraftSavable,
  parseDraft,
  shownOrder,
  toSongDraft,
  toSongUpsert,
  type SongDraft,
} from "./song-draft";
import { SongOrderField } from "./song-order-field";

type Pending =
  | { kind: "discard"; go: () => void }
  | { kind: "delete"; songId: number; live: boolean; usages: SongUsage[] };

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
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);
  const lyricsRef = useRef<HTMLTextAreaElement>(null);

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
    setPending(null);
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
    () => ({ ...toSongUpsert(draft, parsed, null), id: currentId ?? 0, updatedAt: 0 }),
    [currentId, draft, parsed],
  );
  const preview = resolveSong(draftSong, theme, license);
  const fit = useSongFit(preview, theme);

  const upsert = toSongUpsert(draft, parsed, null);
  const dirty = JSON.stringify(upsert) !== JSON.stringify(toSongUpsert(baseline, baselineParsed, null));
  const savable = isSongDraftSavable(draft, parsed);
  const canSave = savable && (currentId === null || dirty);

  const missing = missingOrderKeys(parsed.sections, order);
  const unused = parsed.sections.filter((section) => !order.includes(section.key));
  const overflowing = new Set(fit?.overflowing ?? []);
  const overflowingLabels = [
    ...new Set(
      preview.slides
        .filter((slide) => overflowing.has(slide.lines.join("\n")))
        .map((slide) => sectionLabel(slide.type, slide.number, locale)),
    ),
  ];
  const labelOf = (key: string) => {
    const section = parseSectionKey(key);
    return section ? sectionLabel(section.type, section.number, locale) : key;
  };

  // The caret's slide when it is on one that is projected, else the one clicked.
  const caretSlide =
    caret === null ? null : slideAtCaret(draft.lyrics, caret, locale, theme.maxLines, preview.slides, selected - 1);
  const slideIndex = Math.min(Math.max(1, caretSlide === null ? selected : caretSlide + 1), Math.max(1, preview.slides.length));
  const shownSlide = preview.slides[slideIndex - 1];
  const output: ProjectionOutput | null =
    fit && preview.slides.length > 0
      ? {
          ...songOutputFor(
            preview,
            slideLines(preview, slideIndex),
            theme,
            fit.sizeCqw,
            footerAt(preview, theme, { slideIndex, detour: null }),
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
    const lyrics = lyricsRef.current;
    if (offset === null || !lyrics) return;
    lyrics.focus();
    lyrics.setSelectionRange(offset, offset);
    setCaret(offset);
  }

  function leaveEditing(go: () => void) {
    if (dirty) setPending({ kind: "discard", go });
    else go();
  }

  function show(song: Song) {
    const loaded = toSongDraft(song, locale);
    setCurrentId(song.id);
    replaceDraft(loaded);
    setBaseline(loaded);
  }

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    try {
      const saved = await saveSong(toSongUpsert(draft, parsed, currentId));
      if (!saved) return;
      show(saved);
      onSaved(saved);
      toast.success(t("songs.saved", { title: saved.title }));
    } finally {
      setSaving(false);
    }
  }

  async function handleDuplicate() {
    const source = findSong(songs, currentId);
    if (!source) return;
    const copy = await duplicateSong(source.id, t("songs.copyName", { title: source.title }));
    if (copy) {
      show(copy);
      onSaved(copy);
    }
  }

  async function askToDelete(id: number) {
    setPending({ kind: "delete", songId: id, live: isSongLive(id), usages: await songUsages(id) });
  }

  const menuOptions: MenuOption<"duplicate" | "delete">[] = [
    { disabled: currentId === null, label: t("common.duplicate"), value: "duplicate" },
    { disabled: currentId === null, label: t("common.delete"), tone: "danger", value: "delete" },
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
                ) : null}
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
                  {t("songs.orderMissingHint", { sections: missing.map(labelOf).join(", ") })}
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

            <InspectorSection title={t("songs.groups.data")}>
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
        menu={{
          onSelect: (command) => {
            if (currentId === null) return;
            if (command === "duplicate") leaveEditing(() => void handleDuplicate());
            else void askToDelete(currentId);
          },
          options: menuOptions,
        }}
        name={{
          label: t("songs.title"),
          maxLength: SONG_TITLE_MAX_LENGTH,
          onChange: (title) => patch({ title }),
          placeholder: t("songs.newTitle"),
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
            <Title as="h3" className="flex-1">
              {t("songs.groups.lyrics")}
            </Title>
            <Button
              disabled={parsed.sections.length === 0}
              onClick={() => replaceDraft({ ...draft, lyrics: serializeLyrics(parsed.sections, locale) })}
              size="xs"
              title={t("songs.writeHeadersHint")}
              variant="outline"
            >
              {t("songs.writeHeaders")}
            </Button>
          </div>
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
          <Caption>{t("songs.lyricsHint")}</Caption>
          {!savable ? (
            <Callout className="py-2" role="status" tone="warning">
              {t("songs.invalidHint")}
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
        confirmLabel={
          pending?.kind !== "delete"
            ? t("songs.discard")
            : pending.usages.length > 0
              ? t("songs.deleteAnyway")
              : t("common.delete")
        }
        danger={pending?.kind === "delete"}
        description={
          pending?.kind !== "delete" ? (
            t("songs.discardBody")
          ) : pending.usages.length > 0 ? (
            <ProgramUsages
              intro={t("songs.deleteInUseIntro")}
              usages={pending.usages}
              warning={pending.live ? t("songs.deleteInUseLiveWarning") : t("songs.deleteInUseWarning")}
            />
          ) : pending.live ? (
            t("songs.deleteLiveBody")
          ) : (
            t("songs.deleteBody")
          )
        }
        onConfirm={async () => {
          if (!pending) return;
          if (pending.kind === "delete") {
            if (await deleteSong(pending.songId, pending.usages.length > 0)) onOpenChange(false);
          } else {
            pending.go();
          }
        }}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
        open={pending !== null}
        title={pending?.kind === "delete" ? t("songs.deleteTitle") : t("songs.discardTitle")}
      />
    </>
  );
}
