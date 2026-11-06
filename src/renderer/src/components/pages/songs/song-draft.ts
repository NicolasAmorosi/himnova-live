import { songProblem, type SongProblem } from "@shared/song-validators";
import {
  followsText,
  parseLyrics,
  serializeLyrics,
  textOrder,
  translationFor,
  translationSections,
  withTranslation,
  type ParsedLyrics,
} from "@shared/song-text";
import type { Locale } from "@shared/types/settings";
import type { Song, SongSection, SongUpsert } from "@shared/types/song";

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
  /** The second language, written like `lyrics`: paired with it by section
   *  and slide when parsed (`parseDraft`). */
  translation: string;
  order: string[] | null;
  themeId: number | null;
  /** The stored song's sections and the texts they were written as: while
   *  both texts are as opened, saving keeps those sections as they are,
   *  never re-read from the text (2026-11-06: a title fix must not touch the
   *  lyrics). */
  stored?: { lyrics: string; translation: string; sections: SongSection[] };
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
    translation: "",
    order: null,
    themeId: null,
  };
}

/** A stored order the text can say is written into it and keeps following
 *  the lyrics (`followsText`); any other stays the operator's. */
export function toSongDraft(song: Song, locale: Locale): SongDraft {
  const lyrics = serializeLyrics(song.sections, locale, song.order);
  const translation = serializeLyrics(translationSections(song.sections), locale);
  return {
    title: song.title,
    number: song.number ?? "",
    authors: song.authors ?? "",
    copyright: song.copyright ?? "",
    ccliNumber: song.ccliNumber ?? "",
    notes: song.notes ?? "",
    lyrics,
    translation,
    order: followsText(song.sections, song.order) ? null : song.order,
    themeId: song.themeId,
    stored: { lyrics, translation, sections: song.sections },
  };
}

/** The order the slides follow, as the chips show it. */
export function shownOrder(draft: SongDraft, parsed: ParsedLyrics): string[] {
  return draft.order ?? parsed.sequence;
}

/** «Escribir encabezados»: the lyrics rewritten as the app understood them,
 *  projecting what they projected — an order that follows the text keeps its
 *  repeats as headers, any other becomes the operator's. */
export function withHeadersWritten(draft: SongDraft, parsed: ParsedLyrics, locale: Locale): SongDraft {
  const order = draft.order ?? textOrder(parsed);
  return {
    ...draft,
    lyrics: serializeLyrics(parsed.sections, locale, order),
    order: followsText(parsed.sections, order) ? null : order,
  };
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

/** Why main would refuse the draft — the very predicate it runs — or `null`. */
export function songDraftProblem(draft: SongDraft, parsed: ParsedLyrics): SongProblem | null {
  return songProblem(toSongUpsert(draft, parsed, null));
}

/** So «Save» is never on for a song main refuses. */
export function isSongDraftSavable(draft: SongDraft, parsed: ParsedLyrics): boolean {
  return songDraftProblem(draft, parsed) === null;
}

/** The lyrics, with the translation paired into their slides — so saving, the
 *  preview and «Save»'s check all see the song as it will be stored. */
export function parseDraft(draft: SongDraft, locale: Locale): ParsedLyrics {
  const parsed = parseLyrics(draft.lyrics, locale);
  const { stored } = draft;
  if (stored && draft.lyrics === stored.lyrics && draft.translation === stored.translation) {
    return { ...parsed, sections: stored.sections };
  }
  if (draft.translation.trim() === "") return parsed;
  return { ...parsed, sections: withTranslation(parsed.sections, translationFor(draft.lyrics, draft.translation, locale)) };
}
