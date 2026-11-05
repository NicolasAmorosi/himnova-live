import { create } from "zustand";
import type { BibleBookDTO, BibleBookmark, BibleVerseDTO, BibleVersionDTO } from "@shared/types/bible";
import { api } from "@renderer/lib/api";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { usePreviewStore } from "@renderer/stores/preview.store";

/** A verse PREVIEW target is an index into the chapter loaded HERE, so a
 *  different chapter makes it name another verse: Juan 3:16 previewed, then
 *  Romanos 8 browsed, and PREVIEW — and Enter — became Romanos 8:16 with
 *  nothing to show it had changed. Nothing in PREVIEW beats the wrong verse. */
function dropVersePreview(): void {
  if (usePreviewStore.getState().target?.kind === "verse") usePreviewStore.getState().clear();
}

type BibleStoreState = {
  versions: BibleVersionDTO[];
  books: BibleBookDTO[];
  versionId: number | null;
  bookId: number | null;
  chapter: number | null;
  verses: BibleVerseDTO[];
  currentVerseIndex: number | null;
  favorites: BibleBookmark[];
  recents: BibleBookmark[];

  loadVersions: () => Promise<void>;
  loadBookmarks: () => Promise<void>;
  /** Stars or unstars the verse at `index` of the loaded chapter. */
  setFavorite: (index: number, favorite: boolean) => Promise<void>;
  /** A passage went live — from this tab or from a program row. */
  recordRecent: (bookId: number, chapter: number, verseFrom: number, verseTo: number) => void;
  reorderVersions: (ids: number[]) => Promise<void>;
  setVersion: (versionId: number) => Promise<void>;
  setBookAndChapter: (bookId: number, chapter: number) => Promise<void>;
  setCurrentVerseIndex: (index: number | null) => void;
};

export const useBibleStore = create<BibleStoreState>((set, get) => ({
  versions: [],
  books: [],
  versionId: null,
  bookId: null,
  chapter: null,
  verses: [],
  currentVerseIndex: null,
  favorites: [],
  recents: [],

  /**
   * Re-reads the installed versions and settles on which one is browsed.
   *
   * Three rules, in order, and each of them is there because the other two
   * are wrong on their own:
   *
   * 1. **Keep what is already open.** This runs again after every import,
   *    rename and delete; switching the operator to another version because a
   *    list was refreshed would lose the chapter they were reading.
   * 2. **Otherwise the default** (`bible.defaultVersionId`) — which is the
   *    whole point of that setting.
   * 3. **Otherwise the first one.** What the app always did, now only as a
   *    last resort: it is an insertion order nobody chose.
   *
   * Reading settings at call time rather than subscribing is deliberate and
   * safe here because `App` hydrates this AFTER `loadSettings()` — the one
   * ordering that matters, and the reason the Bible tab does not load them on
   * its own mount any more.
   */
  loadVersions: async () => {
    const versions = await api.bible.versions();
    set({ versions });

    const current = get().versionId;
    if (current !== null && versions.some((version) => version.id === current)) return;

    const defaultId = useSettingsStore.getState().settings["bible.defaultVersionId"];
    const next = versions.find((version) => version.id === defaultId) ?? versions[0];
    if (next) {
      await get().setVersion(next.id);
      return;
    }
    // Every version was deleted: the browser has to empty out rather than keep
    // showing the chapter of a bible that is gone.
    set({ versionId: null, books: [], bookId: null, chapter: null, verses: [], currentVerseIndex: null });
  },

  /**
   * Applies the operator's manual arrangement of the installed versions.
   *
   * It lives here rather than in the Settings section that owns the drag
   * because `versions` is also what the Bible tab's picker offers: a local
   * copy in the settings panel would leave the picker showing yesterday's
   * order until something else happened to reload the store.
   *
   * Optimistic, then replaced by what main actually stored — the same shape as
   * `ProgramsModal`'s reorder, and for the same reason: the drop has to land
   * under the cursor immediately, and the persisted order is the one that
   * survives. A failure reloads rather than leaving the optimistic guess on
   * screen pretending to be saved.
   */
  reorderVersions: async (ids) => {
    const byId = new Map(get().versions.map((version) => [version.id, version]));
    const optimistic = ids.map((id) => byId.get(id)).filter((version) => version !== undefined);
    // Only a complete permutation is applied optimistically: anything else
    // would DROP a version from the picker until main answered.
    if (optimistic.length === byId.size) set({ versions: optimistic });
    try {
      set({ versions: await api.bible.reorder(ids) });
    } catch (error) {
      console.error("[bible] reorder failed", error);
      await get().loadVersions();
    }
  },

  setVersion: async (versionId) => {
    const books = await api.bible.books(versionId);
    dropVersePreview();
    set({ versionId, books, bookId: null, chapter: null, verses: [], currentVerseIndex: null });
  },

  setBookAndChapter: async (bookId, chapter) => {
    const verses = await api.bible.chapter(bookId, chapter);
    const { bookId: currentBook, chapter: currentChapter } = get();
    if (bookId !== currentBook || chapter !== currentChapter) dropVersePreview();
    set({ bookId, chapter, verses, currentVerseIndex: null });
  },

  setCurrentVerseIndex: (currentVerseIndex) => set({ currentVerseIndex }),

  loadBookmarks: async () => {
    const [favorites, recents] = await Promise.all([api.bible.favorites(), api.bible.recents()]);
    set({ favorites, recents });
  },

  setFavorite: async (index, favorite) => {
    const { bookId, chapter, verses } = get();
    const verse = verses[index];
    if (!verse || bookId === null || chapter === null) return;
    set({ favorites: await api.bible.setFavorite(bookId, chapter, verse.verse, favorite) });
  },

  // Fire and forget: going live never waits on it, and a failed write only
  // costs the list one passage.
  recordRecent: (bookId, chapter, verseFrom, verseTo) => {
    api.bible
      .recordRecent(bookId, chapter, verseFrom, verseTo)
      .then((recents) => set({ recents }))
      .catch((error: unknown) => console.error("[bible] recordRecent failed", error));
  },
}));

/** Whether `bookmark` covers `verse` of `abbrev` `chapter`. */
export function bookmarkCovers(bookmark: BibleBookmark, abbrev: string, chapter: number, verse: number): boolean {
  return (
    bookmark.bookAbbrev === abbrev &&
    bookmark.chapter === chapter &&
    bookmark.verseFrom <= verse &&
    verse <= bookmark.verseTo
  );
}

/**
 * The label a verse coming from `versionId` projects under, or `null` when
 * there is nothing to print.
 *
 * It is the version's NAME, which is also what the operator can rename — that
 * is the lever. «Reina-Valera 1909» is too long to sit under a verse on a
 * three-metre screen, and the short form every church actually uses («RV1909»)
 * is a preference, not a fact the app can derive: a Spanish congregation
 * writes RV60 and an Italian one writes NR94. So there is no second `abbrev`
 * column and no formatting rule here — the name IS the label, and Settings ▸
 * Bible is where it gets shortened.
 *
 * `null` for an unknown id rather than a placeholder: a saved program whose
 * version was deleted has a `set null` FK, and printing «(unknown)» under
 * a verse in front of the congregation would be worse than printing nothing.
 */
export function bibleVersionLabel(
  versions: readonly BibleVersionDTO[],
  versionId: number | null,
): string | null {
  if (versionId === null) return null;
  return versions.find((version) => version.id === versionId)?.name ?? null;
}
