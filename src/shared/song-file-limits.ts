/**
 * What a song file cannot keep of a song edited in the app (owner,
 * 2026-11-06: «keep + warn»). The app keeps every field in its own database
 * whatever the file holds; this says which of them never reach the file, so
 * the editor can say so before the operator relies on them.
 *
 * Derived from what `main/songs/song-writers.ts` really writes and its readers
 * read back — change one, change the other.
 */

/** The song files saving writes back into. */
export type SongFileFormat = "openlyrics" | "chordpro" | "songselect";

/**
 * - `number` — the hymn number
 * - `notes`
 * - `translation` — the second language
 * - `order` — the order, as its own field (a linear file writes the song in it)
 * - `slides` — where a section's slides break
 * - `chords`
 */
export type SongFileField = "number" | "notes" | "translation" | "order" | "slides" | "chords";

export const SONG_FILE_LIMITS: Record<SongFileFormat, readonly SongFileField[]> = {
  // Every field: the number in a songbook, the notes as its comment, the
  // translation as the same verse in a second language.
  openlyrics: [],
  // No directive the readers share holds a number, notes or a second language.
  chordpro: ["number", "notes", "translation"],
  // The title, the sections' words, authors, copyright and CCLI number only;
  // a blank line starts a section, so a section is one block.
  songselect: ["number", "notes", "translation", "order", "slides", "chords"],
};

/** ChordPro's extensions; a `.txt` may be SongSelect or ChordPro. */
const CHORDPRO_EXTENSIONS = ["cho", "chordpro", "chopro", "crd", "pro"];

/** A song file's format by its name, or `null` for one that is not a song
 *  file. A `.txt` is told apart by its words, which only main reads: here it
 *  is SongSelect, the format that keeps the least — a warning too many,
 *  never one missing. */
export function songFileFormat(file: string): SongFileFormat | null {
  const extension = /\.([^./\\]+)$/.exec(file)?.[1]?.toLowerCase() ?? "";
  if (extension === "xml") return "openlyrics";
  if (extension === "txt") return "songselect";
  return CHORDPRO_EXTENSIONS.includes(extension) ? "chordpro" : null;
}

/** What the file named `file` cannot keep of its song; nothing for a name
 *  that is not a song file. */
export function songFileLimits(file: string): readonly SongFileField[] {
  const format = songFileFormat(file);
  return format ? SONG_FILE_LIMITS[format] : [];
}
