import { create } from "zustand";
import {
  passageReference,
  type BibleBookDTO,
  type BibleBookmark,
  type BibleVerseDTO,
  type BibleVersionDTO,
} from "@shared/types/bible";
import type { BibleParallel } from "@shared/types/projection";
import { api } from "@renderer/lib/api";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { sameBook } from "@shared/bible-canon";

/** A verse PREVIEW target is an index into the chapter loaded HERE, so a
 *  different chapter makes it name another verse: Juan 3:16 previewed, then
 *  Romanos 8 browsed, and PREVIEW — and Enter — became Romanos 8:16 with
 *  nothing to show it had changed. Nothing in PREVIEW beats the wrong verse. */
function dropVersePreview(): void {
  if (usePreviewStore.getState().target?.kind === "verse") usePreviewStore.getState().clear();
}

/** Which version a verse of `ownVersionId` also goes out in: the setting
 *  (`bible.parallelVersionId`), unless it names that same version or one no
 *  longer installed — both mean none. */
export function parallelVersionFor(
  setting: number | null,
  versions: readonly BibleVersionDTO[],
  ownVersionId: number | null,
): number | null {
  return setting !== null && setting !== ownVersionId && versions.some((version) => version.id === setting)
    ? setting
    : null;
}

/** `verses`' twins in another version's same chapter, by verse NUMBER, never by
 *  position: a version that leaves a verse out must not shift every verse after
 *  it onto its neighbour's text. `null` where it lacks one. */
export function alignByNumber(
  verses: readonly BibleVerseDTO[],
  twins: readonly BibleVerseDTO[],
): (BibleVerseDTO | null)[] {
  const byNumber = new Map(twins.map((verse) => [verse.verse, verse]));
  return verses.map((verse) => byNumber.get(verse.verse) ?? null);
}

type ParallelChapter = { versionId: number; verses: BibleVerseDTO[] } | null;

/** The parallel version's same chapter, its book found by what it is
 *  (`sameBook`, as `setVersion` does) — `null` when no parallel applies, no
 *  verses when that version lacks the chapter. Never a rejection: a failed
 *  lookup must not keep the browsed chapter from loading. */
async function parallelChapter(
  versions: readonly BibleVersionDTO[],
  versionId: number,
  books: readonly BibleBookDTO[],
  bookId: number,
  chapter: number,
): Promise<ParallelChapter> {
  const setting = useSettingsStore.getState().settings["bible.parallelVersionId"];
  const parallelId = parallelVersionFor(setting, versions, versionId);
  const book = books.find((b) => b.id === bookId);
  if (parallelId === null || !book) return null;
  try {
    const theirs = await api.bible.books(parallelId);
    const twin = theirs.find((b) => sameBook(b, theirs.length, book, books.length) && chapter <= b.chapterCount);
    return { versionId: parallelId, verses: twin ? await api.bible.chapter(twin.id, chapter) : [] };
  } catch (error) {
    console.error("[bible] parallel chapter failed", error);
    return null;
  }
}

function parallelState(
  parallel: ParallelChapter,
  verses: readonly BibleVerseDTO[],
): Pick<BibleStoreState, "parallelVersionId" | "parallelVerses"> {
  return {
    parallelVersionId: parallel?.versionId ?? null,
    parallelVerses: parallel ? alignByNumber(verses, parallel.verses) : [],
  };
}

type BibleStoreState = {
  versions: BibleVersionDTO[];
  books: BibleBookDTO[];
  versionId: number | null;
  bookId: number | null;
  chapter: number | null;
  verses: BibleVerseDTO[];
  currentVerseIndex: number | null;
  /** The parallel version that applies to the browsed one, and its same
   *  chapter aligned to `verses` by number — loaded WITH the chapter, so
   *  `projectVerse` and ←/→ never wait for it. A `null` entry is a verse that
   *  version lacks: it goes out alone. */
  parallelVersionId: number | null;
  parallelVerses: (BibleVerseDTO | null)[];
  favorites: BibleBookmark[];
  recents: BibleBookmark[];

  loadVersions: () => Promise<void>;
  /** «En paralelo»: saved, and the browsed chapter's twin loaded. */
  setParallelVersion: (versionId: number | null) => Promise<void>;
  /** Reloads the parallel chapter for what is browsed now. */
  refreshParallel: () => Promise<void>;
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
  parallelVersionId: null,
  parallelVerses: [],
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
    // The parallel may be the version just deleted, or the one just imported.
    if (current !== null && versions.some((version) => version.id === current)) return get().refreshParallel();

    const defaultId = useSettingsStore.getState().settings["bible.defaultVersionId"];
    const next = versions.find((version) => version.id === defaultId) ?? versions[0];
    if (next) {
      await get().setVersion(next.id);
      return;
    }
    // Every version was deleted: the browser has to empty out rather than keep
    // showing the chapter of a bible that is gone.
    set({
      versionId: null,
      books: [],
      bookId: null,
      chapter: null,
      verses: [],
      currentVerseIndex: null,
      ...parallelState(null, []),
    });
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

  /**
   * Another version, on the same passage when it has it (owner, 2026-11-06):
   * the book found by what it is, not by its row (`sameBook`), the chapter,
   * and the verses in PREVIEW and live followed by number — a verse of the
   * tab that is live keeps its ←/→, now through this version's text (what is
   * on the projector only changes with the next verse). A passage the version
   * lacks leaves the tab with no chapter, as before.
   */
  setVersion: async (versionId) => {
    const books = await api.bible.books(versionId);
    const before = get();
    const { chapter } = before;
    const oldBook = before.books.find((book) => book.id === before.bookId);
    const book =
      oldBook && chapter !== null
        ? books.find((b) => sameBook(b, books.length, oldBook, before.books.length) && chapter <= b.chapterCount)
        : undefined;
    if (!book || chapter === null) {
      dropVersePreview();
      set({
        versionId,
        books,
        bookId: null,
        chapter: null,
        verses: [],
        currentVerseIndex: null,
        ...parallelState(null, []),
      });
      return;
    }
    const [verses, parallel] = await Promise.all([
      api.bible.chapter(book.id, chapter),
      parallelChapter(before.versions, versionId, books, book.id, chapter),
    ]);
    const follow = (index: number | null) => {
      const number = index === null ? undefined : before.verses[index]?.verse;
      const next = number === undefined ? -1 : verses.findIndex((verse) => verse.verse === number);
      return next >= 0 ? next : null;
    };
    const target = usePreviewStore.getState().target;
    if (target?.kind === "verse") {
      const index = follow(target.verseIndex);
      if (index === null) usePreviewStore.getState().clear();
      else usePreviewStore.getState().setTarget({ kind: "verse", verseIndex: index });
    }
    set({
      versionId,
      books,
      bookId: book.id,
      chapter,
      verses,
      currentVerseIndex: follow(before.currentVerseIndex),
      ...parallelState(parallel, verses),
    });
  },

  setBookAndChapter: async (bookId, chapter) => {
    const { books, versionId, versions } = get();
    const [verses, parallel] = await Promise.all([
      api.bible.chapter(bookId, chapter),
      versionId === null ? null : parallelChapter(versions, versionId, books, bookId, chapter),
    ]);
    const { bookId: currentBook, chapter: currentChapter } = get();
    if (bookId !== currentBook || chapter !== currentChapter) dropVersePreview();
    set({ bookId, chapter, verses, currentVerseIndex: null, ...parallelState(parallel, verses) });
  },

  setParallelVersion: async (versionId) => {
    // ponytail: the verse already live keeps the parallel it went out with; the
    // choice reaches the NEXT verse (PREVIEW shows it at once). Upgrade: patch
    // `base.parallel` in place with no new scene, as a restyled verse does.
    // The mirror is written at once (`update`), so the reload already reads it.
    const saved = useSettingsStore.getState().update({ "bible.parallelVersionId": versionId });
    await get().refreshParallel();
    await saved;
  },

  refreshParallel: async () => {
    const { bookId, books, chapter, verses, versionId, versions } = get();
    const parallel =
      versionId === null || bookId === null || chapter === null
        ? null
        : await parallelChapter(versions, versionId, books, bookId, chapter);
    // A chapter loaded meanwhile brought its own.
    if (get().verses === verses) set(parallelState(parallel, verses));
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

/** The verse at `index` of the loaded chapter in the parallel version, as it
 *  goes out beside it — or `null`: none applies, or that version lacks it. */
export function parallelAt(
  state: Pick<BibleStoreState, "parallelVersionId" | "parallelVerses" | "versions">,
  index: number,
): BibleParallel | null {
  const twin = state.parallelVerses[index];
  if (!twin) return null;
  return {
    text: twin.text,
    reference: passageReference(twin.bookName, twin.chapter, twin.verse, twin.verse),
    versionLabel: bibleVersionLabel(state.versions, state.parallelVersionId),
  };
}
