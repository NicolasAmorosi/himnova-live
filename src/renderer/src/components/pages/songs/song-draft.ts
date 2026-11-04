import { isSongUpsert } from "@shared/song-validators";
import { parseLyrics, serializeLyrics, textOrder, type ParsedLyrics } from "@shared/song-text";
import type { Locale } from "@shared/types/settings";
import type { Song, SongUpsert } from "@shared/types/song";

/**
 * The song being edited, as the form holds it: the lyrics as TEXT (what the
 * operator types or pastes) and the order either following that text or the
 * operator's own.
 *
 * `order: null` follows the text: the sections as written, or — when the text
 * names a section twice («[Coro]» again, a pasted chorus that comes back) —
 * the text's own sequence. Touching the order makes it the operator's, and
 * editing a word in the lyrics then never resets it.
 */
export type SongDraft = {
  title: string;
  number: string;
  authors: string;
  copyright: string;
  ccliNumber: string;
  notes: string;
  lyrics: string;
  order: string[] | null;
  themeId: number | null;
};

export function emptySongDraft(): SongDraft {
  return {
    title: "",
    number: "",
    authors: "",
    copyright: "",
    ccliNumber: "",
    notes: "",
    lyrics: "",
    order: null,
    themeId: null,
  };
}

export function toSongDraft(song: Song, locale: Locale): SongDraft {
  return {
    title: song.title,
    number: song.number ?? "",
    authors: song.authors ?? "",
    copyright: song.copyright ?? "",
    ccliNumber: song.ccliNumber ?? "",
    notes: song.notes ?? "",
    lyrics: serializeLyrics(song.sections, locale),
    order: song.order.length > 0 ? song.order : null,
    themeId: song.themeId,
  };
}

/** The order the slides follow, as the chips show it. */
export function shownOrder(draft: SongDraft, parsed: ParsedLyrics): string[] {
  return draft.order ?? parsed.sequence;
}

const blankToNull = (value: string): string | null => (value.trim() === "" ? null : value.trim());

export function toSongUpsert(draft: SongDraft, parsed: ParsedLyrics, id: number | null): SongUpsert {
  const upsert: SongUpsert = {
    title: draft.title.trim(),
    number: blankToNull(draft.number),
    authors: blankToNull(draft.authors),
    copyright: blankToNull(draft.copyright),
    ccliNumber: blankToNull(draft.ccliNumber),
    notes: blankToNull(draft.notes),
    sections: parsed.sections,
    order: draft.order ?? textOrder(parsed),
    themeId: draft.themeId,
  };
  return id === null ? upsert : { ...upsert, id };
}

/** The very predicate main runs, so «Save» is never on for a song main refuses. */
export function isSongDraftSavable(draft: SongDraft, parsed: ParsedLyrics): boolean {
  return isSongUpsert(toSongUpsert(draft, parsed, null));
}

export function parseDraft(draft: SongDraft, locale: Locale): ParsedLyrics {
  return parseLyrics(draft.lyrics, locale);
}
