import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { parseLyrics, songLyricsText, textOrder } from "@shared/song-text";
import { isSongUpsert, SONG_FIELD_MAX_LENGTH, SONG_TITLE_MAX_LENGTH } from "@shared/song-validators";
import type { Locale } from "@shared/types/settings";
import type { SongUpsert } from "@shared/types/song";
import { rtfToText } from "./rtf";

/**
 * EasyWorship 6/7's song database: `Songs.db` (table `song`) and
 * `SongWords.db` (table `word`, the lyrics as RTF), both SQLite, opened
 * read-only. Their columns are spelled the way OpenLP's importer reads them
 * (verified against OpenLP's own test files, EasyWorship 6); a real
 * EasyWorship 7 database is still to be checked (PLAN §10).
 *
 * The lyrics come as blocks — one slide each — whose first line may be a
 * label («Verse 1», «Chorus»): exactly the text format `parseLyrics` reads, in
 * any of the app's four languages, so a chorus written twice becomes the
 * order.
 *
 * No `ORDER BY` and no `WHERE` on a text column: EasyWorship 7 declares a
 * collation SQLite does not have (`UTF8_U_CI`), and only comparing those
 * columns would need it.
 */

type SongRow = {
  rowid: number;
  title: string | null;
  author: string | null;
  copyright: string | null;
  administrator: string | null;
  reference_number: string | null;
  vendor_id: number | string | null;
};

/** What a reader of another program's songs gives: the songs that can be
 *  written, and how many it found without a title or without lyrics. */
export type SongsRead = { songs: Omit<SongUpsert, "id">[]; problems: number };

/** Where the two files are: the folder picked, its `Data`, its
 *  `Databases/Data`, or the profile's (`Default/v6.1/Databases/Data`) — the
 *  operator may pick the profile, not its innards. */
export function findEasyWorshipData(folder: string): string | null {
  let versions: string[] = [];
  try {
    versions = fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^v\d/i.test(entry.name))
      .map((entry) => path.join(folder, entry.name, "Databases", "Data"));
  } catch {
    // Not a folder that can be listed: the candidates below say no on their own.
  }
  for (const candidate of [folder, path.join(folder, "Data"), path.join(folder, "Databases", "Data"), ...versions]) {
    if (fs.existsSync(path.join(candidate, "Songs.db")) && fs.existsSync(path.join(candidate, "SongWords.db"))) {
      return candidate;
    }
  }
  return null;
}

export const clip = (value: string | null | undefined, max: number): string | null => {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed.slice(0, max);
};

/** A CCLI song number looks like one: digits only. */
export function ccliNumber(value: string | number | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return /^\d{3,9}$/.test(text) ? text : null;
}

/** Neither column is a CCLI number in OpenLP's test files («Den Danske», 0,
 *  1), so a column that is not digits is not taken for one. */
const ccliOf = (row: SongRow): string | null => ccliNumber(row.reference_number) ?? ccliNumber(row.vendor_id);

export function readEasyWorship(dataFolder: string, locale: Locale): SongsRead {
  const songsDb = new Database(path.join(dataFolder, "Songs.db"), { readonly: true, fileMustExist: true });
  const wordsDb = new Database(path.join(dataFolder, "SongWords.db"), { readonly: true, fileMustExist: true });
  try {
    const rows = songsDb
      .prepare("SELECT rowid, title, author, copyright, administrator, reference_number, vendor_id FROM song")
      .all() as SongRow[];
    const words = new Map(
      (wordsDb.prepare("SELECT song_id, words FROM word").all() as { song_id: number; words: string | null }[]).map(
        (row) => [row.song_id, row.words ?? ""],
      ),
    );
    const songs: Omit<SongUpsert, "id">[] = [];
    let problems = 0;
    for (const row of rows) {
      const parsed = parseLyrics(rtfToText(words.get(row.rowid) ?? ""), locale);
      const copyright = [clip(row.copyright, SONG_FIELD_MAX_LENGTH), clip(row.administrator, SONG_FIELD_MAX_LENGTH)]
        .filter(Boolean)
        .join(" · ");
      const song: Omit<SongUpsert, "id"> = {
        title: clip(row.title, SONG_TITLE_MAX_LENGTH) ?? "",
        number: null,
        authors: clip(row.author, SONG_FIELD_MAX_LENGTH),
        copyright: clip(copyright, SONG_FIELD_MAX_LENGTH),
        ccliNumber: ccliOf(row),
        notes: null,
        sections: parsed.sections,
        order: textOrder(parsed),
        themeId: null,
      };
      // A song without a title or without one line of lyrics is counted,
      // never written half.
      if (isSongUpsert(song)) songs.push(song);
      else problems += 1;
    }
    return { songs, problems };
  } finally {
    songsDb.close();
    wordsDb.close();
  }
}

/** The identity a repeated import skips: the same title and the same words. */
export function songIdentity(song: Pick<SongUpsert, "title" | "sections">): string {
  return `${song.title.trim().toLocaleLowerCase()}\n${songLyricsText(song.sections)}`;
}
