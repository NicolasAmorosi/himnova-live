import { claimLiveIntent } from "@renderer/lib/actions/live-intent";
import { bibleVersionLabel, useBibleStore } from "@renderer/stores/bible.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { previewVerse } from "@renderer/lib/actions/preview";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { api } from "@renderer/lib/api";
import type { DraggedVerse } from "@renderer/lib/dnd";
import type { BibleSearchHit } from "@shared/types/bible";
import type { ProgramItemDTO } from "@shared/types/program";

export type BibleScheduleItem = Extract<ProgramItemDTO, { kind: "bible" }>;

/** Projects the verse at `index` and marks it current — the single
 *  implementation behind `goLive()` on a verse target and the global ←/→
 *  shortcut (use-global-shortcuts.ts) while scripture is on the projector. */
export function projectVerse(index: number): void {
  const { bookId, chapter, recordRecent, setCurrentVerseIndex, versionId, verses, versions } =
    useBibleStore.getState();
  const verse = verses[index];
  if (!verse) return;
  const reference = `${verse.bookName} ${verse.chapter}:${verse.verse}`;
  // Resolved HERE and stored in `base`, not looked up at push time:
  // `selectOutput` is a pure function of the projection store and cannot reach
  // into this one. See `BaseContent`'s `bible` variant.
  const versionLabel = bibleVersionLabel(versions, versionId);
  // Claimed here rather than in `goLive()` alone, because `advanceVerse` is a
  // second entry point: ←/→ moves what the congregation is reading, exactly
  // like `advanceSlide` does for a deck, and a deck finishing its conversion
  // must not land on top of it. See `live-intent.ts`.
  claimLiveIntent();
  // A verse of the tab is never a schedule row: ←/→ from a row's verse that
  // went live must take the row's on-air rail down with it.
  useProgramStore.getState().setActive(null);
  useProjectionStore.getState().setBase({ kind: "bible", text: verse.text, reference, versionLabel });
  setCurrentVerseIndex(index);
  if (bookId !== null && chapter !== null) recordRecent(bookId, chapter, verse.verse, verse.verse);
}

/** Live navigation: the arrows move what the congregation sees, not the
 *  preview — consistent with a deck, where they drive the live slide too. */
export function advanceVerse(direction: 1 | -1): void {
  const { currentVerseIndex, verses } = useBibleStore.getState();
  if (currentVerseIndex === null) return;
  const next = currentVerseIndex + direction;
  if (next < 0 || next >= verses.length) return;
  projectVerse(next);
}

/** A search hit lives outside the loaded chapter: load it, then preview the
 *  verse the operator actually clicked. */
export async function previewSearchHit(hit: BibleSearchHit): Promise<void> {
  await previewPassage(hit.bookId, hit.chapter, hit.verse);
}

/** Loads a chapter and previews one of its verses — a search hit, a favorite,
 *  a recent passage or a typed reference. False: the chapter has no such
 *  verse (a reference typed past its end), and nothing is previewed. */
export async function previewPassage(bookId: number, chapter: number, verse: number): Promise<boolean> {
  await useBibleStore.getState().setBookAndChapter(bookId, chapter);
  const index = useBibleStore.getState().verses.findIndex((v) => v.verse === verse);
  if (index >= 0) previewVerse(index);
  return index >= 0;
}

/**
 * Loads a schedule row's chapter into the Bible tab, in the row's own version,
 * and — while the row is the one on air — marks its verse there as the live
 * one, so ←/→, the LIVE transport and a remote walk on from it, as from a
 * verse of the tab. A range's cursor is its last verse: → goes on past it.
 *
 * Already there (a book id is its version's), the chapter is not reloaded,
 * which would drop the ←/→ of a verse of it that is live. `stillWanted` is
 * asked after each round trip: anything the operator did meanwhile wins.
 */
async function openItemChapter(item: BibleScheduleItem, stillWanted: () => boolean): Promise<boolean> {
  const { bibleBookId, bibleVersionId, chapter } = item;
  if (bibleBookId === null || chapter === null) return false;
  const { setVersion, versionId } = useBibleStore.getState();
  if (bibleVersionId !== null && bibleVersionId !== versionId) await setVersion(bibleVersionId);
  if (!stillWanted()) return false;
  const tab = useBibleStore.getState();
  if (tab.bookId !== bibleBookId || tab.chapter !== chapter) await tab.setBookAndChapter(bibleBookId, chapter);
  if (!stillWanted()) return false;
  const { activeIndex, items } = useProgramStore.getState();
  if (activeIndex !== null && items[activeIndex] === item && useProjectionStore.getState().base?.kind === "bible") {
    const last = item.verseTo ?? item.verseFrom;
    const live = useBibleStore.getState().verses.findIndex((v) => v.verse === last);
    if (live >= 0) useBibleStore.getState().setCurrentVerseIndex(live);
  }
  return true;
}

/**
 * A schedule row's verse, walked like one of the Bible tab (owner, 2026-11-06:
 * PREVIEW shows the row's whole chapter): the chapter is loaded there and that
 * verse previewed — only for a verse that exists (↓ on a chapter's last verse
 * must not reload it for nothing), and only while the operator is still on
 * that row.
 */
export async function previewItemVerse(item: BibleScheduleItem, verse: number): Promise<void> {
  const { bibleBookId, chapter } = item;
  if (bibleBookId === null || chapter === null) return;
  const target = usePreviewStore.getState().target;
  const stillHere = () => usePreviewStore.getState().target === target;
  const verses = await api.bible.chapter(bibleBookId, chapter);
  if (!verses.some((v) => v.verse === verse) || !stillHere()) return;
  if (!(await openItemChapter(item, stillHere))) return;
  const index = useBibleStore.getState().verses.findIndex((v) => v.verse === verse);
  if (index >= 0) previewVerse(index);
}

/**
 * A schedule row's verse just went live: its chapter goes to the Bible tab at
 * once (owner, 2026-11-06), so → and a remote's PageDown walk on right away
 * instead of waiting for ↓ to hand it over. Only while that verse is still
 * what is live, and never over a verse of the tab waiting in PREVIEW: a row
 * reached by a video's «next» must not take the operator's next verse away.
 */
export async function handLiveItemToTab(item: BibleScheduleItem): Promise<void> {
  if (usePreviewStore.getState().target?.kind === "verse") return;
  const base = useProjectionStore.getState().base;
  await openItemChapter(item, () => useProjectionStore.getState().base === base);
}

/** Builds the drag/schedule payload for the verse at `index` of the loaded
 *  chapter — shared by the click-to-add footer button and the draggable row,
 *  so both add exactly the same item. */
export function buildVerseDrag(index: number): DraggedVerse | null {
  const { bookId, chapter, verses, versionId } = useBibleStore.getState();
  const verse = verses[index];
  if (!verse || versionId === null || bookId === null || chapter === null) return null;
  return {
    bibleVersionId: versionId,
    bibleBookId: bookId,
    chapter,
    verseFrom: verse.verse,
    verseTo: verse.verse,
    reference: `${verse.bookName} ${verse.chapter}:${verse.verse}`,
    text: verse.text,
  };
}

/** Adds the verse at `index` of the loaded chapter to the program. */
export function addVerseToSchedule(index: number): void {
  const payload = buildVerseDrag(index);
  if (!payload) return;
  useProgramStore.getState().addItem({ kind: "bible", ...payload });
}
