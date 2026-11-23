import Database from "better-sqlite3";
import { canonByIndex, canonByMyBibleNumber, type CanonBook } from "./canon";
import { normalizeLanguage } from "./language";
import { asPlainText, BibleFormatError, BookCollector, type ParsedBible } from "./types";
import { mt } from "../../../i18n";

/**
 * MyBible.zone and MySword modules — which are SQLite databases.
 *
 * The cheapest format to support and the richest catalogue: `better-sqlite3`
 * is already a dependency (it is the app's own database), so reading one is a
 * query rather than a parser. Between them these two Android apps account for
 * most of the freely circulated Spanish modules on the web.
 *
 * They are two different schemas that happen to share a file extension
 * family, and they even number the books differently:
 *
 *   MyBible.zone  `verses(book_number, chapter, verse, text)`   10, 20, … 730
 *   MySword       `Bible(Book, Chapter, Verse, Scripture)`      1, 2, … 66
 *
 * The 10-step numbering is not decoration: it leaves room between the
 * canonical books for the deuterocanonicals (165 Esdras, 170 Tobit, 180
 * Judith sit between 160 Nehemiah and 190 Esther), which is why the canon
 * table carries the mapping rather than computing `index * 10`.
 *
 * ## On opening a file the operator chose
 *
 * `readonly` is the important flag, and not for tidiness: opening a SQLite
 * database read-write creates a `-wal` and a `-shm` next to it and can
 * silently upgrade or repair the file. The operator picked a module out of
 * their Downloads folder to READ it, and the importer copies every verse into
 * the app's own database anyway — it has no business writing a byte back.
 */

/** Strong's numbers, footnotes and translator marks, with their contents.
 *  These are apparatus, and on a projector they read as gibberish spliced
 *  into the verse: `<S>430</S>` would come out as a bare "430". */
const APPARATUS = [
  /<S>[\s\S]*?<\/S>/gi,
  /<f>[\s\S]*?<\/f>/gi,
  /<n>[\s\S]*?<\/n>/gi,
  /<m>[\s\S]*?<\/m>/gi,
  /<t>[\s\S]*?<\/t>/gi,
  // MySword's own footnote delimiters, which are NOT a matched pair of tags:
  // it opens with <RF> and closes with a lowercase <Rf> — no slash. Modules
  // converted by third-party tools write </Rf> anyway, so both close it: a
  // footnote whose end tag is not recognised swallows the rest of the verse.
  /<RF[^>]*>[\s\S]*?<\/?Rf>/gi,
  // Inline Strong's/morphology milestones: <WG2316>, <WH430>, <WTG3588>.
  /<W[GHT][^>]*>/gi,
];

/** Tags that are a line break rather than nothing — they have to become a
 *  space, or the words on either side are joined into one. */
const BREAKS = /<(br|CM|CL|pb|TS\d?|Ts)\s*\/?>/gi;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
};

/** One verse's worth of module markup, reduced to the words. */
export function cleanModuleText(raw: string): string {
  let text = raw;
  for (const pattern of APPARATUS) text = text.replace(pattern, " ");
  text = text.replace(BREAKS, " ");
  // Whatever is left is emphasis, red-letter and paragraph marks: the tags go,
  // the words they wrap stay.
  text = text.replace(/<[^>]*>/g, "");
  text = text.replace(/&[a-z]+;|&#\d+;/gi, (entity) => {
    const named = ENTITIES[entity.toLowerCase()];
    if (named !== undefined) return named;
    const code = /^&#(\d+);$/.exec(entity);
    return code?.[1] ? String.fromCodePoint(Number(code[1])) : " ";
  });
  // A space before punctuation is what all of the above leaves behind when a
  // footnote sat at the end of a clause.
  return text.replace(/\s+/g, " ").replace(/\s+([,.;:!?»)\]])/g, "$1").trim();
}

type Row = Record<string, unknown>;

function tableNames(db: Database.Database): Set<string> {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`).all() as Row[];
  return new Set(rows.map((row) => String(row.name).toLowerCase()));
}

function asString(value: unknown): string | null {
  const text = asPlainText(value).trim();
  return text.length > 0 ? text : null;
}

/** MyBible.zone: `info` is a name/value table, `books` carries the names. */
function readMyBibleZone(db: Database.Database, tables: Set<string>): ParsedBible {
  const info = new Map<string, string>();
  if (tables.has("info")) {
    for (const row of db.prepare(`SELECT name, value FROM info`).all() as Row[]) {
      info.set(asPlainText(row.name).toLowerCase(), asPlainText(row.value));
    }
  }

  const names = new Map<number, string>();
  if (tables.has("books")) {
    for (const row of db.prepare(`SELECT book_number, long_name FROM books`).all() as Row[]) {
      const name = asString(row.long_name);
      if (name) names.set(Number(row.book_number), name);
    }
  }

  const collector = new BookCollector();
  const verses = db
    .prepare(`SELECT book_number, chapter, verse, text FROM verses`)
    .all() as Row[];
  for (const row of verses) {
    const number = Number(row.book_number);
    const canon = canonByMyBibleNumber(number);
    if (!canon) continue;
    collector.add(
      canon,
      Number(row.chapter),
      Number(row.verse),
      cleanModuleText(asPlainText(row.text)),
      names.get(number) ?? null,
    );
  }

  const language = normalizeLanguage(info.get("language"));
  return {
    name: info.get("description") ?? info.get("title") ?? null,
    language,
    books: collector.finish(language),
  };
}

/** MySword: one `Details` row, and `Bible.Book` is the canonical 1..66. */
function readMySword(db: Database.Database, tables: Set<string>): ParsedBible {
  const details = tables.has("details")
    ? ((db.prepare(`SELECT * FROM Details LIMIT 1`).get() as Row | undefined) ?? {})
    : {};

  const collector = new BookCollector();
  const verses = db.prepare(`SELECT Book, Chapter, Verse, Scripture FROM Bible`).all() as Row[];
  for (const row of verses) {
    const canon: CanonBook | null = canonByIndex(Number(row.Book));
    if (!canon) continue;
    collector.add(canon, Number(row.Chapter), Number(row.Verse), cleanModuleText(asPlainText(row.Scripture)));
  }

  const language = normalizeLanguage(asString(details.Language));
  return {
    name: asString(details.Description) ?? asString(details.Title) ?? asString(details.Abbreviation),
    language,
    books: collector.finish(language),
  };
}

export function parseMyBibleModule(filePath: string): ParsedBible {
  let db: Database.Database;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new BibleFormatError(mt("bible.sqliteUnreadable"), error);
  }

  try {
    const tables = tableNames(db);
    if (tables.has("verses")) return readMyBibleZone(db, tables);
    if (tables.has("bible")) return readMySword(db, tables);
    throw new BibleFormatError(mt("bible.sqliteNoVerses"));
  } finally {
    db.close();
  }
}
