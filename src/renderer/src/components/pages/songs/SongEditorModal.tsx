import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@renderer/lib/i18n/i18n-provider";
import { ConfirmModal, Modal, ModalTitle } from "@renderer/components/shared/modal";
import { ProgramUsages } from "@renderer/components/shared/program-usages";
import { EditorActions } from "@renderer/components/shared/editor-actions";
import { OutputView } from "@renderer/components/shared/output-view";
import { SongSlideGrid } from "@renderer/components/shared/song-slide-grid";
import {
  Button,
  Callout,
  Caption,
  DialogHeader,
  FieldGroup,
  FieldRow,
  Icon,
  IconButton,
  Input,
  Monitor,
  Textarea,
  Title,
} from "@renderer/components/ui";
import { toast } from "@renderer/lib/toast";
import { useSongFit } from "@renderer/lib/song-fit";
import { songOutputFor } from "@renderer/lib/song-output";
import { deleteSong, duplicateSong, isSongLive, saveSong, songUsages } from "@renderer/lib/actions/songs";
import { findSong, themeForSong, useSongStore } from "@renderer/stores/song.store";
import { INSTANT_TRANSITION, type ProjectionOutput } from "@shared/types/projection";
import { missingOrderKeys, parseSectionKey, sectionLabel, serializeLyrics, songDeckSlides } from "@shared/song-text";
import { SONG_FIELD_MAX_LENGTH, SONG_NOTES_MAX_LENGTH, SONG_TITLE_MAX_LENGTH } from "@shared/song-validators";
import type { ResolvedSong, Song, SongUsage } from "@shared/types/song";
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
 * One song: its data, its lyrics as text, its order, and a preview of the
 * slide chosen, drawn by the projector's own `OutputView` at the song's one
 * size. Saved by hand like the scene and plate editors — a song can be live
 * while it is edited — and a live song is re-dressed in place on save
 * (`refreshLiveSong`), on the same section and slide.
 */
export function SongEditorModal({ onOpenChange, onSaved, open, songId }: SongEditorModalProps) {
  const { locale, t } = useI18n();
  const songs = useSongStore((s) => s.songs);
  const themes = useSongStore((s) => s.themes);
  const [currentId, setCurrentId] = useState<number | null>(songId);
  const [draft, setDraft] = useState<SongDraft>(emptySongDraft);
  const [baseline, setBaseline] = useState<SongDraft>(emptySongDraft);
  const [selected, setSelected] = useState(1);
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);

  // Opening loads the song asked for, once — never again under the operator's typing.
  useEffect(() => {
    if (!open) return;
    const song = findSong(useSongStore.getState().songs, songId);
    const loaded = song ? toSongDraft(song, locale) : emptySongDraft();
    setCurrentId(song?.id ?? null);
    setDraft(loaded);
    setBaseline(loaded);
    setSelected(1);
    setPending(null);
    // `locale` only shapes the headers of a song being opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, songId]);

  const parsed = useMemo(() => parseDraft(draft, locale), [draft, locale]);
  const baselineParsed = useMemo(() => parseDraft(baseline, locale), [baseline, locale]);
  const order = shownOrder(draft, parsed);
  const theme = themeForSong({ themeId: draft.themeId }, themes);
  const preview: ResolvedSong = useMemo(
    () => ({ id: currentId ?? 0, title: draft.title, slides: songDeckSlides(parsed.sections, order) }),
    // `order` is derived from these two.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentId, draft.title, draft.order, parsed],
  );
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

  const slideIndex = Math.min(Math.max(1, selected), Math.max(1, preview.slides.length));
  const output: ProjectionOutput | null =
    fit && preview.slides.length > 0
      ? {
          ...songOutputFor(preview, slideIndex, theme, fit.sizeCqw),
          videoUnderlay: null,
          slideVideo: null,
          plates: [],
          transition: INSTANT_TRANSITION,
        }
      : null;

  const patch = (next: Partial<SongDraft>) => setDraft((current) => ({ ...current, ...next }));

  function leaveEditing(go: () => void) {
    if (dirty) setPending({ kind: "discard", go });
    else go();
  }

  function show(song: Song) {
    const loaded = toSongDraft(song, locale);
    setCurrentId(song.id);
    setDraft(loaded);
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

  return (
    <>
      <Modal
        height="tall"
        onOpenChange={(next) => (next ? onOpenChange(true) : leaveEditing(() => onOpenChange(false)))}
        open={open}
        size="2xl"
      >
        <DialogHeader className="border-b border-border">
          <ModalTitle>{currentId === null ? t("songs.newTitle") : t("songs.editTitle")}</ModalTitle>
          <IconButton
            aria-label={t("common.close")}
            onClick={() => leaveEditing(() => onOpenChange(false))}
            size="xs"
            title={t("common.close")}
            variant="ghost"
          >
            <Icon name="close" />
          </IconButton>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
            <FieldGroup title={t("songs.groups.data")}>
              <FieldRow label={t("songs.title")}>
                <Input
                  aria-label={t("songs.title")}
                  maxLength={SONG_TITLE_MAX_LENGTH}
                  onChange={(e) => patch({ title: e.target.value })}
                  size="sm"
                  value={draft.title}
                />
              </FieldRow>
              <FieldRow description={t("songs.numberHint")} label={t("songs.number")}>
                <Input
                  aria-label={t("songs.number")}
                  maxLength={SONG_FIELD_MAX_LENGTH}
                  onChange={(e) => patch({ number: e.target.value })}
                  size="sm"
                  value={draft.number}
                />
              </FieldRow>
              <FieldRow label={t("songs.authors")}>
                <Input
                  aria-label={t("songs.authors")}
                  maxLength={SONG_FIELD_MAX_LENGTH}
                  onChange={(e) => patch({ authors: e.target.value })}
                  size="sm"
                  value={draft.authors}
                />
              </FieldRow>
              <FieldRow label={t("songs.copyright")}>
                <Input
                  aria-label={t("songs.copyright")}
                  maxLength={SONG_FIELD_MAX_LENGTH}
                  onChange={(e) => patch({ copyright: e.target.value })}
                  size="sm"
                  value={draft.copyright}
                />
              </FieldRow>
              <FieldRow label={t("songs.ccli")}>
                <Input
                  aria-label={t("songs.ccli")}
                  maxLength={SONG_FIELD_MAX_LENGTH}
                  onChange={(e) => patch({ ccliNumber: e.target.value })}
                  size="sm"
                  value={draft.ccliNumber}
                />
              </FieldRow>
              <FieldRow label={t("songs.notes")}>
                <Textarea
                  aria-label={t("songs.notes")}
                  maxLength={SONG_NOTES_MAX_LENGTH}
                  onChange={(e) => patch({ notes: e.target.value })}
                  rows={2}
                  value={draft.notes}
                />
              </FieldRow>
            </FieldGroup>

            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Title as="h2" className="flex-1">
                  {t("songs.groups.lyrics")}
                </Title>
                <Button
                  disabled={parsed.sections.length === 0}
                  onClick={() => patch({ lyrics: serializeLyrics(parsed.sections, locale) })}
                  size="xs"
                  title={t("songs.writeHeadersHint")}
                  variant="outline"
                >
                  {t("songs.writeHeaders")}
                </Button>
              </div>
              <Textarea
                aria-label={t("songs.groups.lyrics")}
                onChange={(e) => patch({ lyrics: e.target.value })}
                placeholder={t("songs.lyricsPlaceholder")}
                rows={16}
                spellCheck={false}
                value={draft.lyrics}
              />
              <Caption>{t("songs.lyricsHint")}</Caption>
            </div>

            <div className="flex flex-col gap-2">
              <Title as="h2">{t("songs.groups.order")}</Title>
              <SongOrderField
                custom={draft.order !== null}
                onChange={(next) => patch({ order: next })}
                onReset={() => patch({ order: null })}
                order={order}
                sections={parsed.sections}
              />
            </div>
          </div>

          <div className="flex w-96 shrink-0 flex-col border-l border-border">
            <div className="shrink-0 border-b border-border p-2">
              <EditorActions
                canSave={canSave}
                dirty={dirty}
                onDelete={() => {
                  if (currentId !== null) void askToDelete(currentId);
                }}
                onDuplicate={() => leaveEditing(() => void handleDuplicate())}
                onRevert={() => setDraft(baseline)}
                onSave={() => void handleSave()}
                persisted={currentId !== null}
                saving={saving}
              />
            </div>
            <Monitor className="pb-3">
              {output ? <OutputView mode="preview" output={output} /> : null}
            </Monitor>
            <div className="flex shrink-0 flex-col gap-2 px-3">
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
              {missing.length > 0 ? (
                <Callout className="py-2" role="status" tone="warning">
                  {t("songs.orderMissingHint", { sections: missing.map(labelOf).join(", ") })}
                </Callout>
              ) : null}
              {draft.order !== null && unused.length > 0 ? (
                <Callout className="py-2" role="status" tone="info">
                  {t("songs.orderUnusedHint", {
                    sections: unused.map((s) => sectionLabel(s.type, s.number, locale)).join(", "),
                  })}
                </Callout>
              ) : null}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              <SongSlideGrid
                liveIndex={null}
                onSelect={setSelected}
                scrollToIndex={slideIndex}
                selectedIndex={slideIndex}
                song={preview}
                theme={theme}
              />
            </div>
          </div>
        </div>
      </Modal>

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
