import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n, type MessageKey } from "@renderer/lib/i18n/i18n-provider";
import {
  Button,
  Caption,
  EmptyState,
  HighlightedText,
  Icon,
  IconButton,
  ListRow,
  LoadingState,
  Tooltip,
} from "@renderer/components/ui";
import { PanelBody, PanelFooter } from "@renderer/components/shared/panel";
import { LibraryFilterBar } from "@renderer/components/shared/library-filter-bar";
import { ConfirmModal } from "@renderer/components/shared/modal";
import { ModalBoundary } from "@renderer/components/shared/modal-boundary";
import { api } from "@renderer/lib/api";
import { toast } from "@renderer/lib/toast";
import { setSongDrag } from "@renderer/lib/dnd";
import { previewSong } from "@renderer/lib/actions/preview";
import {
  importSongs,
  linkSongFolder,
  refreshSongFolder,
  selectSongView,
  setSongSort,
  songView,
  unlinkSongFolder,
  songDeleteTarget,
  type SongDeleteTarget,
} from "@renderer/lib/actions/songs";
import { goLive } from "@renderer/lib/actions/playback";
import { useDebouncedCallback } from "@renderer/lib/hooks/use-debounced-callback";
import { findSong, sortSongs, useSongStore } from "@renderer/stores/song.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { parseSnippet } from "@shared/types/bible";
import { SONG_SORT_ORDERS, type Song, type SongSearchHit, type SongSortOrder } from "@shared/types/song";
import { DeleteSongConfirm } from "./delete-song-confirm";
import { SongEditorModal } from "./SongEditorModal";
import { SongThemesModal } from "./SongThemesModal";

/** One query per pause in typing, not per keystroke. */
const SEARCH_DEBOUNCE_MS = 150;

type Row = { song: Song; snippet: string | null };

/** Explicit, because a message key can never be built from a runtime value. */
const SORT_LABEL_KEY: Record<SongSortOrder, MessageKey> = {
  "title-asc": "songs.sortOrders.title-asc",
  "title-desc": "songs.sortOrders.title-desc",
  "number-asc": "songs.sortOrders.number-asc",
  "date-desc": "songs.sortOrders.date-desc",
  "date-asc": "songs.sortOrders.date-asc",
};

/** The view of the library itself; any other is a linked folder's path. */
const LIBRARY = "library";

/** A folder's own name: its tail is what tells two folders apart. */
const folderName = (folderPath: string) => folderPath.split(/[\\/]/).filter(Boolean).pop() ?? folderPath;

/**
 * The Songs tab: the library, or one of the computer's folders linked to it,
 * like Media's (owner, 2026-11-05) — its song files read from disk, and saved
 * back into them —, in an order, searched by title, number, author and lyrics
 * without accents inside what it shows. The two-stage flow like every list: a click
 * previews, a double click (or Enter on the PREVIEW) goes live; a row is
 * dragged onto the order of service or added from the footer. The editor edits
 * one song at a time (owner, 2026-11-04): «New», or «Edit» on the previewed one.
 */
export function SongsBrowser() {
  const { locale, t } = useI18n();
  const songs = useSongStore((s) => s.songs);
  const listings = useSongStore((s) => s.folderListings);
  const sort = useSettingsStore((s) => s.settings["songs.sort"]);
  const linked = useSettingsStore((s) => s.settings["songs.linkedFolders"]);
  // Read again whenever the settings change, which is what `songView` reads.
  const view = useSettingsStore(() => songView());
  const folder = view === LIBRARY ? null : view;
  const listing = folder === null ? undefined : listings[folder];
  const target = usePreviewStore((s) => s.target);
  const liveSongId = useProjectionStore((s) => (s.base?.kind === "song" ? s.base.songId : null));
  const addItem = useProgramStore((s) => s.addItem);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SongSearchHit[] | null>(null);
  const [editing, setEditing] = useState<{ songId: number | null } | null>(null);
  const [themesOpen, setThemesOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SongDeleteTarget | null>(null);
  const runImport = () => {
    setImporting(true);
    void importSongs().finally(() => setImporting(false));
  };
  const requestRef = useRef(0);

  const previewedId = target?.kind === "song" ? target.songId : null;
  const previewed = findSong(songs, previewedId);
  // Only a library song: a folder's song is its file, and the app never
  // deletes one — even when it was previewed before switching views.
  const deletable = previewed?.sourceFolder === null ? previewed : null;

  // A folder is read from disk each time it is opened: its files may have
  // changed since, outside the app.
  useEffect(() => {
    if (folder !== null) void refreshSongFolder(folder);
  }, [folder]);

  /** What the view shows: the library's songs, or the folder's as last read. */
  const inView = useMemo(() => {
    if (folder === null) return songs.filter((song) => song.sourceFolder === null);
    const ids = new Set(Array.isArray(listing) ? listing : []);
    return songs.filter((song) => ids.has(song.id));
  }, [folder, listing, songs]);
  const inViewIds = useMemo(() => new Set(inView.map((song) => song.id)), [inView]);

  // ponytail: every row rendered; virtualize when a church's library makes typing lag.
  const sorted = useMemo(() => sortSongs(inView, sort, locale), [inView, locale, sort]);

  const search = useDebouncedCallback((value: string, scope: string | null) => {
    const request = (requestRef.current += 1);
    api.songs
      .search(value, scope)
      .then((result) => {
        // An answer to an older query must not replace a newer one's.
        if (request === requestRef.current) setHits(result);
      })
      .catch((error: unknown) => console.warn("[songs] search failed", error));
  }, SEARCH_DEBOUNCE_MS);

  // Searched again when the view changes too: the search is inside it.
  useEffect(() => {
    if (query.trim() === "") {
      requestRef.current += 1;
      setHits(null);
    } else {
      search(query, folder);
    }
  }, [folder, query, search]);

  const searching = query.trim() !== "";
  const rows: Row[] = searching
    ? (hits ?? []).flatMap((hit) => {
        const song = findSong(songs, hit.songId);
        // An answer for the view open a moment ago is not this one's.
        return song && inViewIds.has(song.id) ? [{ song, snippet: hit.snippet }] : [];
      })
    : sorted.map((song) => ({ song, snippet: null }));

  return (
    <>
      <LibraryFilterBar
        activeView={view}
        addFolder={{ hint: t("songs.linkFolderHint"), label: t("resources.addFolder"), onClick: () => void linkSongFolder() }}
        folderActions={
          <Tooltip content={t("resources.removeFolderHint")} floating>
            <IconButton
              aria-label={t("resources.removeFolder")}
              onClick={() => setConfirmUnlink(view)}
              size="sm"
              variant="ghost"
            >
              <Icon name="folderMinus" />
            </IconButton>
          </Tooltip>
        }
        onQueryChange={setQuery}
        // Enter previews the best match; Escape then Enter sends it live.
        onSearchEnter={() => {
          const first = rows[0];
          if (first) previewSong(first.song.id);
        }}
        onSelectView={selectSongView}
        onSortChange={setSongSort}
        query={query}
        searchLabel={t("songs.search")}
        sort={sort}
        sortHint={t("songs.sortHint")}
        sortOptions={SONG_SORT_ORDERS.map((order) => ({ label: t(SORT_LABEL_KEY[order]), value: order }))}
        views={[
          { label: t("resources.recentTab"), value: LIBRARY },
          ...linked.map((path) => ({ label: folderName(path), value: path })),
        ]}
        viewsLabel={t("resources.source")}
      />

      <PanelBody className="p-1.5">
        {/* Media's own two states: a folder that is gone says so and can be
            tried again, never reads as an empty folder. */}
        {folder !== null && listing === "missing" ? (
          <LoadingState
            action={
              <Button onClick={() => void refreshSongFolder(folder)} size="sm" variant="outline">
                {t("common.retry")}
              </Button>
            }
            hint={t("library.folderMissing")}
            icon="alert"
            surface="panel"
            title={t("library.loadFailed")}
            tone="failed"
          />
        ) : folder !== null && listing === undefined ? (
          <LoadingState progress={null} surface="panel" title={t("library.loading")} />
        ) : rows.length === 0 && !searching ? (
          // No buttons in an empty state (2026-11-04 review): «+» and «Importar»
          // are in the footer right below, and some empty states had a button
          // while others did not.
          folder === null ? (
            <EmptyState description={t("songs.emptyHint")} icon="song" title={t("songs.empty")} />
          ) : (
            <EmptyState description={t("songs.folderEmptyHint")} icon="folder" title={t("songs.folderEmpty")} />
          )
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
        {/* A new or imported song goes into the library: in a folder's view,
            where it would not show, neither is offered (Media's add, too). */}
        {folder === null ? (
          <Tooltip content={t("songs.newHint")} floating>
            <IconButton aria-label={t("songs.new")} onClick={() => setEditing({ songId: null })} size="sm" variant="ghost">
              <Icon name="add" />
            </IconButton>
          </Tooltip>
        ) : null}
        {/* Like Media's ✕ (owner, 2026-11-05) — but a song lives only here, so
            this deletes it, asked first. Not in a folder's view, like Media's. */}
        {folder === null ? (
          <Tooltip content={t("songs.removeHint")} floating>
            <IconButton
              aria-label={t("songs.remove")}
              disabled={!deletable}
              onClick={() => deletable && void songDeleteTarget(deletable.id).then(setDeleting)}
              size="sm"
              variant="ghost"
            >
              <Icon name="close" />
            </IconButton>
          </Tooltip>
        ) : null}
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
        {/* The tab's own tools are icons with a tooltip; only «Agregar», what
            the footer is for, keeps its word (owner, 2026-11-05, reversing the
            2026-11-04 redesign's P2: «me gustan solo los íconos»). */}
        {/* One picker for every format (owner, 2026-11-05: no menu of programs). */}
        {folder === null ? (
          <Tooltip content={t("songs.importHint")} floating>
            <IconButton aria-label={t("songs.import")} disabled={importing} onClick={runImport} size="sm" variant="ghost">
              <Icon name="import" />
            </IconButton>
          </Tooltip>
        ) : null}
        <Tooltip content={t("songThemes.manageHint")} floating>
          <IconButton aria-label={t("songThemes.title")} onClick={() => setThemesOpen(true)} size="sm" variant="ghost">
            <Icon name="palette" />
          </IconButton>
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

      <DeleteSongConfirm
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        target={deleting}
      />

      {/* Asked first, like Media's: the view the operator had open
          disappearing looks like data loss even though no file is touched. */}
      <ConfirmModal
        confirmLabel={t("resources.removeFolder")}
        description={t("resources.removeFolderConfirmBody", { folder: confirmUnlink ? folderName(confirmUnlink) : "" })}
        onConfirm={() => (confirmUnlink ? unlinkSongFolder(confirmUnlink) : undefined)}
        onOpenChange={(open) => {
          if (!open) setConfirmUnlink(null);
        }}
        open={confirmUnlink !== null}
        title={t("resources.removeFolderConfirmTitle")}
      />
    </>
  );
}
