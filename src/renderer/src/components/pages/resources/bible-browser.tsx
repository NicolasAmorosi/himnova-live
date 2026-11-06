import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useI18n } from "@renderer/lib/i18n/i18n-provider";
import {
  Caption,
  EmptyState,
  HighlightedText,
  Button,
  Icon,
  IconButton,
  Input,
  ListRow,
  Select,
  Segmented,
  Tooltip,
} from "@renderer/components/ui";
import { ModalBoundary } from "@renderer/components/shared/modal-boundary";
import { PanelBody, PanelFooter } from "@renderer/components/shared/panel";
import { bookmarkCovers, useBibleStore } from "@renderer/stores/bible.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { api } from "@renderer/lib/api";
import { addVerseToSchedule, buildVerseDrag, previewPassage, previewSearchHit } from "@renderer/lib/actions/bible";
import { previewVerse } from "@renderer/lib/actions/preview";
import { goLive } from "@renderer/lib/actions/playback";
import { setBibleVerseDrag } from "@renderer/lib/dnd";
import { useDebouncedCallback } from "@renderer/lib/hooks/use-debounced-callback";
import { matchReference, type ReferenceMatch } from "@renderer/lib/bible-reference";
import { toast } from "@renderer/lib/toast";
import {
  parseSnippet,
  passageReference,
  type BibleBookmark,
  type BibleSearchHit,
} from "@shared/types/bible";
import { VerseStyleModal } from "./VerseStyleModal";

const MIN_TEXT_QUERY_LENGTH = 3;
/** One FTS query per keystroke was one round-trip per keystroke, each of them
 *  a `MATCH` over the whole bible. */
const TEXT_SEARCH_DEBOUNCE_MS = 200;

type SearchMode = "reference" | "text";

/** Scripture as one more resource tab: browse or search, click to preview,
 *  double-click to go live. Search defaults to a quick book/chapter finder;
 *  a toggle switches it to full-text verse search. */
export function BibleBrowser() {
  const { locale, t } = useI18n();
  // Field-by-field, not `useBibleStore()` bare — the whole-store subscription
  // re-rendered this panel (and its list of up to 500 verse rows) on every
  // write, including ones it never reads.
  const books = useBibleStore((s) => s.books);
  const currentVerseIndex = useBibleStore((s) => s.currentVerseIndex);
  const verses = useBibleStore((s) => s.verses);
  const versionId = useBibleStore((s) => s.versionId);
  const versions = useBibleStore((s) => s.versions);
  const setBookAndChapter = useBibleStore((s) => s.setBookAndChapter);
  const setVersion = useBibleStore((s) => s.setVersion);
  const loadedBookId = useBibleStore((s) => s.bookId);
  const loadedChapter = useBibleStore((s) => s.chapter);
  const favorites = useBibleStore((s) => s.favorites);
  const recents = useBibleStore((s) => s.recents);
  const setFavorite = useBibleStore((s) => s.setFavorite);
  const target = usePreviewStore((s) => s.target);
  const [pendingBook, setPendingBook] = useState("");
  const [pendingChapter, setPendingChapter] = useState("");
  // The pickers follow the chapter the tab holds, wherever it was loaded from:
  // a search hit, a bookmark, a verse picked in PREVIEW from a schedule row.
  // Not while the operator is choosing a book and has no chapter yet.
  useEffect(() => {
    if (loadedBookId === null || loadedChapter === null) return;
    setPendingBook(String(loadedBookId));
    setPendingChapter(String(loadedChapter));
  }, [loadedBookId, loadedChapter]);
  const [searchMode, setSearchMode] = useState<SearchMode>("reference");
  const [styleOpen, setStyleOpen] = useState(false);
  /** The list shows favorites and recent passages instead of the chapter. */
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<BibleSearchHit[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);

  const selectedBook = books.find((b) => b.id === Number(pendingBook));
  const previewIndex = target?.kind === "verse" ? target.verseIndex : null;
  const searching = searchMode === "text" ? query.trim().length >= MIN_TEXT_QUERY_LENGTH : query.trim().length > 0;

  const referenceMatches = useMemo(
    () => (searchMode === "reference" ? matchReference(books, query, locale) : []),
    [books, locale, query, searchMode],
  );

  const resultCount = searchMode === "text" ? searchResults.length : referenceMatches.length;

  const loadedBook = books.find((b) => b.id === loadedBookId);
  const previewedVerse = previewIndex !== null ? verses[previewIndex] : undefined;
  const previewedIsFavorite =
    loadedBook !== undefined &&
    previewedVerse !== undefined &&
    loadedChapter !== null &&
    favorites.some((f) => bookmarkCovers(f, loadedBook.abbrev, loadedChapter, previewedVerse.verse));

  // The list content changes on every keystroke — always land back on the
  // top hit rather than keeping a stale index that now points at something
  // unrelated to what's on screen.
  useEffect(() => {
    setHighlightedIndex(0);
    // `itemRefs` is indexed positionally and only ever written by the rows
    // that actually render, so going from 500 search hits to 3 left 497 dead
    // slots behind for the rest of the session. Truncating keeps the array
    // exactly as long as the list it describes.
    itemRefs.current.length = resultCount;
  }, [referenceMatches, searchResults, resultCount]);

  useEffect(() => {
    itemRefs.current[highlightedIndex]?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  /** Monotonic request id. `invoke` has no cancellation, so two searches in
   *  flight can resolve out of order and the LAST ONE TO ARRIVE wins — which,
   *  typing at any speed, is regularly the results for a prefix the operator
   *  has already moved past. Only the newest request is allowed to publish. */
  const searchSeqRef = useRef(0);

  const runTextSearch = useDebouncedCallback((value: string) => {
    if (versionId === null || value.trim().length < MIN_TEXT_QUERY_LENGTH) {
      setSearchResults([]);
      return;
    }
    const seq = (searchSeqRef.current += 1);
    void api.bible
      .search(versionId, value)
      .then((hits) => {
        if (seq === searchSeqRef.current) setSearchResults(hits);
      })
      .catch(() => {
        if (seq === searchSeqRef.current) setSearchResults([]);
      });
  }, TEXT_SEARCH_DEBOUNCE_MS);

  // The hits belong to a version: a search typed before the browsed version
  // loaded (on a cold start it arrives after the window) or before switching
  // it ran against none or the old one, so a new version runs it again.
  useEffect(() => {
    if (searchMode === "text") runTextSearch(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new version re-runs it; query and mode changes already search through onChange and the toggle
  }, [versionId]);

  function handleTextSearch(value: string) {
    // Cleared synchronously so the list can never show hits for a query the
    // input no longer holds while the debounce is pending.
    if (value.trim().length < MIN_TEXT_QUERY_LENGTH) {
      searchSeqRef.current += 1;
      setSearchResults([]);
    }
    runTextSearch(value);
  }

  function toggleSearchMode() {
    setSearchMode((mode) => (mode === "reference" ? "text" : "reference"));
    setQuery("");
    setSearchResults([]);
  }

  function toggleBookmarks() {
    setShowBookmarks((shown) => !shown);
    setQuery("");
    setSearchResults([]);
  }

  /** Opens in the version being browsed: a bookmark names the book by its
   *  abbrev, which every version shares. */
  function openBookmark(bookmark: BibleBookmark) {
    const book = books.find((b) => b.abbrev === bookmark.bookAbbrev);
    if (!book || bookmark.chapter > book.chapterCount) {
      toast.danger(t("bible.notInVersion"));
      return;
    }
    setPendingBook(String(book.id));
    setPendingChapter(String(bookmark.chapter));
    setShowBookmarks(false);
    void previewPassage(book.id, bookmark.chapter, bookmark.verseFrom);
  }

  function bookmarkSection(title: string, items: BibleBookmark[]) {
    if (items.length === 0) return null;
    return (
      <section aria-label={title} className="flex flex-col gap-0.5">
        <Caption className="px-2 pt-1">{title}</Caption>
        <ul className="flex flex-col gap-0.5">
          {items.map((bookmark) => {
            const book = books.find((b) => b.abbrev === bookmark.bookAbbrev);
            return (
              <ListRow key={bookmark.id} onClick={() => openBookmark(bookmark)}>
                {book
                  ? passageReference(book.name, bookmark.chapter, bookmark.verseFrom, bookmark.verseTo)
                  : bookmark.reference}
              </ListRow>
            );
          })}
        </ul>
      </section>
    );
  }

  /** A book, a chapter, or a verse (owner, 2026-11-06: «Juan 3:16» puts
   *  that verse — the first of a range — in PREVIEW). A verse past the
   *  chapter's end says so, like a bookmark the version lacks. */
  function selectReferenceMatch(match: ReferenceMatch) {
    setPendingBook(String(match.book.id));
    if (match.chapter !== null) {
      setPendingChapter(String(match.chapter));
      if (match.verseFrom === null) void setBookAndChapter(match.book.id, match.chapter);
      else
        void previewPassage(match.book.id, match.chapter, match.verseFrom).then((found) => {
          if (!found) toast.danger(t("bible.notInVersion"));
        });
    } else {
      setPendingChapter("");
    }
    setQuery("");
  }

  /** Lets the search field behave like a combobox: arrows move the
   *  highlighted result, Enter picks it — the same action its click handler
   *  would run — without ever taking focus off the input. */
  function handleSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (resultCount === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((i) => Math.min(i + 1, resultCount - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (searchMode === "text") {
        const hit = searchResults[highlightedIndex];
        if (hit) void previewSearchHit(hit);
      } else {
        const match = referenceMatches[highlightedIndex];
        if (match) selectReferenceMatch(match);
      }
    }
  }

  return (
    <>
      {/* Two strips, like every bar of the main window (owner, 2026-11-06):
          version · book · chapter above, the search mode · the search under. */}
      <div className="grid h-strip shrink-0 grid-cols-[minmax(0,3fr)_minmax(0,3fr)_minmax(8rem,2fr)] items-center gap-1.5 border-b border-border px-1.5">
          <Select
            aria-label={t("bible.versionLabel")}
            className="min-w-0"
            onChange={(value) => void setVersion(Number(value))}
            options={versions.map((v) => ({ label: v.name, value: String(v.id) }))}
            size="sm"
            value={versionId !== null ? String(versionId) : ""}
          />
          <Select
            aria-label={t("bible.bookLabel")}
            className="min-w-0"
            onChange={(value) => {
              setPendingBook(value);
              setPendingChapter("");
            }}
            options={books.map((b) => ({ label: b.name, value: String(b.id) }))}
            placeholder={t("bible.book")}
            size="sm"
            value={pendingBook}
          />
          <Select
            aria-label={t("bible.chapterLabel")}
            className="min-w-0"
            disabled={!selectedBook}
            onChange={(value) => {
              setPendingChapter(value);
              void setBookAndChapter(Number(pendingBook), Number(value));
            }}
            options={Array.from({ length: selectedBook?.chapterCount ?? 0 }, (_, i) => ({
              label: String(i + 1),
              value: String(i + 1),
            }))}
            placeholder={t("bible.chapter")}
            size="sm"
            value={pendingChapter}
          />
      </div>
      <div className="flex h-strip min-w-0 shrink-0 items-center gap-1.5 border-b border-border px-1.5">
          {/* Words, not a document icon nobody could read as «search the text»
              (2026-11-05 review), as wide as its longer word in each half
              (owner, 2026-11-05): in the first column it cut «Referencia». */}
          <Segmented
            label={t("bible.searchMode")}
            onChange={(mode) => {
              if (mode !== searchMode) toggleSearchMode();
            }}
            options={[
              { label: t("bible.modeReference"), value: "reference" },
              { label: t("bible.modeText"), value: "text" },
            ]}
            value={searchMode}
          />
          <Tooltip content={t("bible.bookmarks")} floating>
            <IconButton aria-label={t("bible.bookmarks")} onClick={toggleBookmarks} size="sm" toggled={showBookmarks} variant="ghost">
              {/* Not the star: the star in the footer MARKS a verse, this shows the
                  marked ones (2026-11-05 review: one icon, two verbs). */}
              <Icon name="bookmarks" />
            </IconButton>
          </Tooltip>
          <div className="min-w-0 flex-1">
            <Input
              icon="search"
              onChange={(e) => {
                const value = e.target.value;
                setQuery(value);
                if (searchMode === "text") handleTextSearch(value);
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder={searchMode === "reference" ? t("bible.referenceSearch") : t("bible.search")}
              value={query}
            />
          </div>
      </div>

      <PanelBody className="p-1.5">
        {searching ? (
          searchMode === "text" ? (
            searchResults.length === 0 ? (
              <EmptyState icon="search" title={t("bible.noResults")} />
            ) : (
              <ul className="flex flex-col gap-0.5">
                {searchResults.map((hit, index) => (
                  <ListRow
                    key={hit.id}
                    onClick={() => void previewSearchHit(hit)}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    ref={(el) => {
                      itemRefs.current[index] = el;
                    }}
                    selected={highlightedIndex === index}
                    // Without it two hits are two snippets: «…de tal manera
                    // amó Dios…» says nothing about WHICH verse is about to
                    // be previewed. Same form as the PREVIEW heading.
                    leading={<Caption className="shrink-0">{`${hit.bookName} ${hit.chapter}:${hit.verse}`}</Caption>}
                  >
                    <HighlightedText segments={parseSnippet(hit.snippet)} />
                  </ListRow>
                ))}
              </ul>
            )
          ) : referenceMatches.length === 0 ? (
            <EmptyState icon="bible" title={t("bible.noResults")} />
          ) : (
            <ul className="flex flex-col gap-0.5">
              {referenceMatches.map((match, index) => (
                <ListRow
                  key={match.book.id}
                  onClick={() => selectReferenceMatch(match)}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  ref={(el) => {
                    itemRefs.current[index] = el;
                  }}
                  selected={highlightedIndex === index}
                >
                  {match.chapter === null
                    ? match.book.name
                    : match.verseFrom === null
                      ? `${match.book.name} ${match.chapter}`
                      : passageReference(match.book.name, match.chapter, match.verseFrom, match.verseTo ?? match.verseFrom)}
                </ListRow>
              ))}
            </ul>
          )
        ) : showBookmarks ? (
          favorites.length === 0 && recents.length === 0 ? (
            <EmptyState description={t("bible.bookmarksEmptyHint")} icon="favorite" title={t("bible.bookmarksEmpty")} />
          ) : (
            <div className="flex flex-col gap-2">
              {bookmarkSection(t("bible.favorites"), favorites)}
              {bookmarkSection(t("bible.recents"), recents)}
            </div>
          )
        ) : verses.length === 0 ? (
          <EmptyState description={t("bible.emptyHint")} icon="bible" title={t("bible.empty")} />
        ) : (
          <ul className="flex flex-col gap-0.5">
            {verses.map((verse, index) => (
              <ListRow
                active={currentVerseIndex === index}
                draggable
                index={verse.verse}
                key={verse.id}
                onClick={() => previewVerse(index)}
                onDoubleClick={() => {
                  previewVerse(index);
                  void goLive();
                }}
                onDragStart={(e) => {
                  const payload = buildVerseDrag(index);
                  if (payload) setBibleVerseDrag(e, payload);
                }}
                selected={previewIndex === index}
              >
                {verse.text}
              </ListRow>
            ))}
          </ul>
        )}
      </PanelBody>

      <PanelFooter>
        {/* Bottom left, like the Songs tab's «Themes»: the tab's own tools, an
            icon with a tooltip (owner, 2026-11-05). */}
        <Tooltip content={t("bible.styleHint")} floating>
          <IconButton aria-label={t("bible.styleTitle")} onClick={() => setStyleOpen(true)} size="sm" variant="ghost">
            <Icon name="palette" />
          </IconButton>
        </Tooltip>
        <Tooltip
          className="ml-auto"
          content={previewedIsFavorite ? t("bible.favoriteRemove") : t("bible.favoriteAdd")}
          placement="top"
        >
          <IconButton
            aria-label={previewedIsFavorite ? t("bible.favoriteRemove") : t("bible.favoriteAdd")}
            disabled={previewIndex === null}
            onClick={() => previewIndex !== null && void setFavorite(previewIndex, !previewedIsFavorite)}
            size="sm"
            toggled={previewedIsFavorite}
            variant="ghost"
          >
            <Icon name="favorite" />
          </IconButton>
        </Tooltip>
        <Tooltip content={t("resources.addToScheduleHint")} placement="top">
          <Button
            aria-label={t("resources.addToSchedule")}
            disabled={previewIndex === null}
            onClick={() => previewIndex !== null && addVerseToSchedule(previewIndex)}
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
          setStyleOpen(false);
          toast.danger(t("app.modalCrashed"));
        }}
        open={styleOpen}
      >
        <VerseStyleModal onOpenChange={setStyleOpen} open={styleOpen} />
      </ModalBoundary>
    </>
  );
}
