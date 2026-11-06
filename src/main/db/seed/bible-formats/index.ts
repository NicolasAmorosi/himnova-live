import fs from "node:fs";
import path from "node:path";
import { readZipEntries, ZipFormatError } from "../../../slides/zip-reader";
import { parseBibleJson } from "./json";
import { parseMyBibleModule } from "./mybible";
import { parseOsis } from "./osis";
import { parseUsfx } from "./usfx";
import { parseZefania } from "./zefania";
import { BibleFormatError, type ParsedBible } from "./types";
import { mt } from "../../../i18n";
import { decodeText } from "../../../decode-text";

export { BibleFormatError };
export type { ParsedBible, ParsedBook, ParsedVerse } from "./types";

export type BibleFormat = "json" | "zefania" | "usfx" | "osis" | "sqlite";

/**
 * The file picker's filters — a function because their names are in the
 * interface language of the moment. Electron matches on the LAST extension, so
 * `mybible` covers the `.bbl.mybible` that MySword actually writes.
 */
export function bibleImportFilters(): { name: string; extensions: string[] }[] {
  return [
    {
      name: mt("filters.bibles"),
      extensions: ["json", "xml", "zip", "sqlite3", "sqlite", "mybible", "bbl", "db", "usfx", "osis"],
    },
    { name: "JSON", extensions: ["json"] },
    { name: "XML (Zefania, USFX, OSIS)", extensions: ["xml", "usfx", "osis", "zip"] },
    { name: mt("filters.sqliteModules"), extensions: ["sqlite3", "sqlite", "mybible", "bbl", "db"] },
  ];
}

/** `SQLite format 3\0`. */
const SQLITE_MAGIC = Buffer.from("53514c69746520666f726d6174203300", "hex");
/** A local file header — the start of every non-empty zip. */
const ZIP_MAGIC = Buffer.from("504b0304", "hex");

/** Enough of the file to find a root element past an XML declaration, a
 *  DOCTYPE and a licence comment, which between them are routinely a kilobyte
 *  in a Zefania module. */
const SNIFF_BYTES = 8192;

/**
 * Which format a file is, decided by its CONTENT.
 *
 * Deliberately not by its extension. A Zefania module downloaded from
 * SourceForge is as likely to be called `spaRV1909.xml` as `SPARV.zefania`, a
 * MySword module is `.bbl.mybible` but a MyBible.zone one is `.SQLite3`, and
 * an operator who renames a file to get past a file dialog is not doing
 * anything unreasonable. The same reasoning `container-kind.ts` applies to a
 * presentation: the bytes are the truth, the name is a hint.
 */
export function detectBibleFormat(filePath: string): BibleFormat {
  const head = readHead(filePath);
  if (head.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) return "sqlite";
  if (head.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) {
    // A zip is a container, not a format: what is inside decides, and that is
    // resolved in `parseBibleFile` where the entry is actually extracted.
    return detectTextFormat(decodeText(extractFromZip(filePath)).slice(0, SNIFF_BYTES), filePath);
  }
  return detectTextFormat(decodeText(head).slice(0, SNIFF_BYTES), filePath);
}

function readHead(filePath: string): Buffer {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const read = fs.readSync(fd, buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function detectTextFormat(head: string, filePath: string): BibleFormat {
  const text = head.replace(/^\uFEFF/, "").trimStart();
  if (text.startsWith("{") || text.startsWith("[")) return "json";
  if (/<\s*XMLBIBLE/i.test(text)) return "zefania";
  if (/<\s*usfx/i.test(text)) return "usfx";
  if (/<\s*osis(Text)?[\s>]/i.test(text)) return "osis";
  throw new BibleFormatError(mt("bible.unknownFormat", { file: path.basename(filePath) }));
}

/**
 * The single text entry of a zipped module.
 *
 * Read through `readZipEntries` rather than `unzipSync` for the reason
 * `.claude/knowledge/a-pptx-is-random-access-and-inflatesync-needs-its-out-buffer.md`
 * gives: a zip is random access, and `unzipSync` takes a buffer, which means
 * reading the whole archive to get at one entry inside it.
 */
function extractFromZip(filePath: string): Buffer {
  let entries: Record<string, Uint8Array>;
  try {
    entries = readZipEntries(filePath, (name) => /\.(xml|json|usfx|osis)$/i.test(name));
  } catch (error) {
    if (error instanceof ZipFormatError) throw new BibleFormatError(mt("bible.zipUnreadable", { detail: error.message }));
    throw error;
  }
  // Largest wins: a module zip regularly carries a readme or a licence
  // alongside the bible, and the bible is never the smaller of the two.
  const best = Object.values(entries).sort((a, b) => b.length - a.length)[0];
  if (!best) throw new BibleFormatError(mt("bible.zipEmpty"));
  return Buffer.from(best);
}

/**
 * Reads a bible file of any supported format.
 *
 * SQLite is the one branch that works from the PATH rather than from bytes:
 * `better-sqlite3` opens a file, not a buffer, and the whole point of that
 * format is that it is random-access — reading a 40 MB module into memory to
 * hand it to a parser would throw away exactly what makes it cheap. Which is
 * also why a zipped SQLite module is not supported: it would have to be
 * written back out to a temporary file first, and asking the operator to
 * unzip it is a smaller cost than a temp file with a bible in it.
 */
export function parseBibleFile(filePath: string): ParsedBible {
  const format = detectBibleFormat(filePath);
  if (format === "sqlite") return parseMyBibleModule(filePath);

  const head = readHead(filePath);
  const raw = head.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)
    ? extractFromZip(filePath)
    : fs.readFileSync(filePath);
  const text = decodeText(raw);

  switch (format) {
    case "json":
      return parseBibleJson(JSON.parse(text));
    case "zefania":
      return parseZefania(text);
    case "usfx":
      return parseUsfx(text);
    case "osis":
      return parseOsis(text);
  }
}
