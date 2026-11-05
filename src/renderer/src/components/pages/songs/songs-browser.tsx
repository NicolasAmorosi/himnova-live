import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useI18n } from "@renderer/lib/i18n/i18n-provider";
import {
  Button,
  Caption,
  EmptyState,
  HighlightedText,
  Icon,
  IconButton,
  Input,
  ListRow,
  Tooltip,
} from "@renderer/components/ui";
import { PanelBody, PanelFooter } from "@renderer/components/shared/panel";
import { ModalBoundary } from "@renderer/components/shared/modal-boundary";
import { api } from "@renderer/lib/api";
import { toast } from "@renderer/lib/toast";
import { setSongDrag } from "@renderer/lib/dnd";
import { previewSong } from "@renderer/lib/actions/preview";
import { importEasyWorship } from "@renderer/lib/actions/songs";
import { goLive } from "@renderer/lib/actions/playback";
import { useDebouncedCallback } from "@renderer/lib/hooks/use-debounced-callback";
import { findSong, useSongStore } from "@renderer/stores/song.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { parseSnippet } from "@shared/types/bible";
import type { Song, SongSearchHit } from "@shared/types/song";
import { SongEditorModal } from "./SongEditorModal";
import { SongThemesModal } from "./SongThemesModal";

/** One query per pause in typing, not per keystroke. */
const SEARCH_DEBOUNCE_MS = 150;

type Row = { song: Song; snippet: string | null };

/**
 * The Songs tab: the library, searched by title, number, author and lyrics
 * without accents. The two-stage flow like every list: a click previews, a
 * double click (or Enter on the PREVIEW) goes live; a row is dragged onto the
 * order of service or added from the footer. The editor edits one song at a
 * time (owner, 2026-11-04): «New», or «Edit» on the previewed one.
 */
export function SongsBrowser() {
  const { locale, t } = useI18n();
  const songs = useSongStore((s) => s.songs);
  const target = usePreviewStore((s) => s.target);
  const liveSongId = useProjectionStore((s) => (s.base?.kind === "song" ? s.base.songId : null));
  const addItem = useProgramStore((s) => s.addItem);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SongSearchHit[] | null>(null);
  const [editing, setEditing] = useState<{ songId: number | null } | null>(null);
  const [themesOpen, setThemesOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const runImport = () => {
    setImporting(true);
    void importEasyWorship().finally(() => setImporting(false));
  };
  const requestRef = useRef(0);

  const previewedId = target?.kind === "song" ? target.songId : null;
  const previewed = findSong(songs, previewedId);

  // ponytail: every row rendered; virtualize when a church's library makes typing lag.
  const sorted = useMemo(() => {
    const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
    return [...songs].sort((a, b) => collator.compare(a.title, b.title));
  }, [locale, songs]);

  const search = useDebouncedCallback((value: string) => {
    const request = (requestRef.current += 1);
    api.songs
      .search(value)
      .then((result) => {
        // An answer to an older query must not replace a newer one's.
        if (request === requestRef.current) setHits(result);
      })
      .catch((error: unknown) => console.warn("[songs] search failed", error));
  }, SEARCH_DEBOUNCE_MS);

  const searching = query.trim() !== "";
  const rows: Row[] = searching
    ? (hits ?? []).flatMap((hit) => {
        const song = findSong(songs, hit.songId);
        return song ? [{ song, snippet: hit.snippet }] : [];
      })
    : sorted.map((song) => ({ song, snippet: null }));

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // Enter previews the best match; Escape then Enter sends it live.
    if (e.key !== "Enter") return;
    const first = rows[0];
    if (first) previewSong(first.song.id);
  }

  return (
    <>
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border p-1.5">
        <Input
          aria-label={t("songs.search")}
          icon="search"
          onChange={(e) => {
            const value = e.target.value;
            setQuery(value);
            if (value.trim() === "") {
              requestRef.current += 1;
              setHits(null);
            } else {
              search(value);
            }
          }}
          onKeyDown={handleKeyDown}
          placeholder={t("songs.search")}
          value={query}
        />
      </div>

      <PanelBody className="p-1.5">
        {songs.length === 0 ? (
          // No buttons in an empty state (2026-11-04 review): «+» and «Importar»
          // are in the footer right below, and some empty states had a button
          // while others did not.
          <EmptyState
            description={t("songs.emptyHint")}
            icon="song"
            title={t("songs.empty")}
          />
        ) : rows.length === 0 ? (
          <EmptyState icon="search" title={hits === null ? t("songs.searching") : t("songs.noResults")} />
        ) : (
          <ul aria-label={t("songs.listLabel")} className="flex flex-col gap-0.5">
            {rows.map(({ snippet, song }) => (
              <ListRow
                active={liveSongId === song.id}
                draggable
                key={song.id}
                leading={song.number ? <Caption className="shrink-0 tabular-nums">{song.number}</Caption> : undefined}
                onClick={() => previewSong(song.id)}
                onDoubleClick={() => {
                  previewSong(song.id);
                  void goLive();
                }}
                onDragStart={(e) => setSongDrag(e, song.id)}
                selected={previewedId === song.id}
                trailing={
                  song.authors ? <span className="max-w-32 truncate text-xs text-subtle">{song.authors}</span> : undefined
                }
              >
                {snippet ? (
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{song.title}</span>
                    <HighlightedText
                      className="truncate text-xs text-muted-foreground"
                      segments={parseSnippet(snippet.replace(/\n/g, " / "))}
                    />
                  </span>
                ) : (
                  song.title
                )}
              </ListRow>
            ))}
          </ul>
        )}
      </PanelBody>

      <PanelFooter>
        <Tooltip content={t("songs.newHint")} floating>
          <IconButton aria-label={t("songs.new")} onClick={() => setEditing({ songId: null })} size="sm" variant="ghost">
            <Icon name="add" />
          </IconButton>
        </Tooltip>
        <Tooltip content={t("songs.editHint")} floating>
          <IconButton
            aria-label={t("songs.edit")}
            disabled={!previewed}
            onClick={() => previewed && setEditing({ songId: previewed.id })}
            size="sm"
            variant="ghost"
          >
            <Icon name="pencil" />
          </IconButton>
        </Tooltip>
        {/* With words, not icons alone (2026-11-04 redesign, P2): nobody finds
            «Themes» behind a palette. «+» and the pencil are universal. */}
        <Tooltip content={t("songs.importHint")} floating>
          <Button
            aria-label={t("songs.importEasyWorship")}
            disabled={importing}
            onClick={runImport}
            size="sm"
            variant="ghost"
          >
            <Icon name="import" />
            {t("songs.import")}
          </Button>
        </Tooltip>
        <Tooltip content={t("songThemes.manageHint")} floating>
          <Button onClick={() => setThemesOpen(true)} size="sm" variant="ghost">
            <Icon name="palette" />
            {t("songThemes.title")}
          </Button>
        </Tooltip>
        <Tooltip className="ml-auto" content={t("resources.addToScheduleHint")} placement="top">
          <Button
            aria-label={t("resources.addToSchedule")}
            disabled={!previewed}
            onClick={() => previewed && addItem({ kind: "song", songId: previewed.id, title: null })}
            size="sm"
            variant="outline"
          >
            <Icon name="addToSchedule" />
            {t("resources.addToScheduleShort")}
          </Button>
        </Tooltip>
      </PanelFooter>

      <ModalBoundary
        onCrash={() => {
          setEditing(null);
          toast.danger(t("app.modalCrashed"));
        }}
        open={editing !== null}
      >
        <SongEditorModal
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSaved={(song) => previewSong(song.id)}
          open={editing !== null}
          songId={editing?.songId ?? null}
        />
      </ModalBoundary>

      <ModalBoundary
        onCrash={() => {
          setThemesOpen(false);
          toast.danger(t("app.modalCrashed"));
        }}
        open={themesOpen}
      >
        <SongThemesModal onOpenChange={setThemesOpen} open={themesOpen} />
      </ModalBoundary>
    </>
  );
}
