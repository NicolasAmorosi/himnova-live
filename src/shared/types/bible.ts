export type BibleVersionDTO = {
  id: number;
  code: string;
  name: string;
  language: string;
  isBuiltin: boolean;
  verseCount: number;
};

/** Which saved programs cite a version, for the "delete anyway" confirmation.
 *  Same shape and same purpose as `UtilitySceneUsage` and `MediaAssetUsage` —
 *  and, like them, read BEFORE the dialog opens so the question cannot change
 *  under the operator while they are reading it.
 *
 *  What it means here is milder than for a scene, and deliberately so: the FK
 *  on `program_items.bible_version_id` is `set null`, and the verse's text and
 *  reference are denormalized into the row. So a forced delete costs those
 *  programs their version LINK (and therefore the projected version label),
 *  never the verse itself. Nothing is deleted from a program. */
export type BibleVersionUsage = {
  programId: number;
  programName: string;
  itemCount: number;
};

/** A version's name is what the projector prints when the style asks for it
 *  (see `bibleVersionLabel`), so it is bounded like any other projected line
 *  rather than by the column's own generosity. */
export const BIBLE_VERSION_NAME_MAX_LENGTH = 60;

/** A name the list can actually show and the projector can actually print:
 *  not blank, not a paragraph. Trimmed before the length check, because " "
 *  is a name nobody can read. */
export function isBibleVersionName(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= BIBLE_VERSION_NAME_MAX_LENGTH
  );
}

export type BibleBookDTO = {
  id: number;
  versionId: number;
  position: number;
  abbrev: string;
  name: string;
  testament: "OT" | "NT";
  chapterCount: number;
};

export type BibleVerseDTO = {
  id: number;
  bookId: number;
  bookName: string;
  chapter: number;
  verse: number;
  text: string;
};

export type BibleSearchHit = BibleVerseDTO & {
  /** The verse, trimmed around the match, with every matched run wrapped in
   *  `SNIPPET_MARK_START`/`SNIPPET_MARK_END`. Read it with `parseSnippet` and
   *  render the pieces as text — see those constants for why it is NOT
   *  markup. */
  snippet: string;
};

/**
 * Delimiters FTS5 wraps a match in, inside `BibleSearchHit.snippet`.
 *
 * Control characters, deliberately, rather than the `<mark>`/`</mark>` this
 * used to carry. A snippet embeds the verse's own text verbatim, and a verse
 * can come from any JSON the operator imports (`bible:import`) — so when the
 * renderer handed that string to `dangerouslySetInnerHTML`, a bible file with
 * `<img src=x onerror=…>` in a verse ran arbitrary script in the control
 * window, which holds the generic `window.worship.invoke` bridge and therefore
 * every IPC channel in the app. Church bible files travel on USB sticks and
 * chat apps; that is not a theoretical path.
 *
 * These two code points cannot be markup in any context, and `parseSnippet`
 * turns them into data the renderer emits as real `<mark>` elements.
 */
export const SNIPPET_MARK_START = "\u0001";
export const SNIPPET_MARK_END = "\u0002";

export type SnippetSegment = { match: boolean; text: string };

/** Splits a `snippet` into plain and matched runs. Tolerates an unbalanced or
 *  absent delimiter (an FTS quirk, or a snippet built some other way): the
 *  remainder is returned as text, never dropped. */
export function parseSnippet(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  const push = (text: string, match: boolean) => {
    if (text.length > 0) segments.push({ match, text });
  };

  let rest = snippet;
  while (rest.length > 0) {
    const start = rest.indexOf(SNIPPET_MARK_START);
    if (start < 0) {
      push(rest, false);
      break;
    }
    push(rest.slice(0, start), false);
    const end = rest.indexOf(SNIPPET_MARK_END, start + 1);
    if (end < 0) {
      push(rest.slice(start + 1), true);
      break;
    }
    push(rest.slice(start + 1, end), true);
    rest = rest.slice(end + 1);
  }
  return segments;
}

/** A favorite or a recent passage. Version-free on purpose: it names the book
 *  by its abbrev (the same in every version, see `canon.ts`) and opens in
 *  whichever version is being browsed. `reference` is how it read when saved,
 *  shown only when the browsed version lacks that book. */
export type BibleBookmark = {
  id: number;
  bookAbbrev: string;
  chapter: number;
  verseFrom: number;
  verseTo: number;
  reference: string;
};

/** How many passages «Recientes» keeps. */
export const BIBLE_RECENTS_MAX = 20;

/** «Juan 3:16» or «Juan 3:16-18». */
export function passageReference(bookName: string, chapter: number, verseFrom: number, verseTo: number): string {
  return `${bookName} ${chapter}:${verseFrom}${verseTo > verseFrom ? `-${verseTo}` : ""}`;
}

/** Raw shape of the bundled/importable Bible JSON files. */
export type BibleSourceBook = {
  abbrev: string;
  name?: string;
  nombre?: string;
  chapters: unknown;
};
