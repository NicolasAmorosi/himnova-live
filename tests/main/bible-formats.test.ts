/**
 * The importer's format readers.
 *
 * Every case here is a real file written to disk and read back through
 * `parseBibleFile`, not a parser called with a string: the format is decided
 * from the file's BYTES (magic numbers, an XML declaration's encoding, a zip's
 * central directory), so a test that hands a parser a `string` would skip the
 * half of the work most likely to be wrong.
 *
 * The fixtures are deliberately tiny — two or three verses each — and each one
 * carries the specific trap its format is known for: a note element inside a
 * verse, a milestone with the text as a SIBLING, a single-chapter book that
 * parses to an object instead of an array, Strong's numbers glued into the
 * words, Latin-1 accents.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { zipSync, strToU8 } from "fflate";
import {
  BibleFormatError,
  detectBibleFormat,
  parseBibleFile,
} from "../../src/main/db/seed/bible-formats";
import { cleanModuleText } from "../../src/main/db/seed/bible-formats/mybible";
import {
  CANON,
  canonByAbbrev,
  canonByIndex,
  canonByLooseCode,
  canonByMyBibleNumber,
  canonByStandardCode,
  testamentOf,
} from "../../src/main/db/seed/bible-formats/canon";

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-bible-formats-"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes a fixture and returns its path. `encoding` is a real byte-level
 *  choice, which is the point of several cases below. */
function write(name: string, content: string, encoding: BufferEncoding = "utf8"): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from(content, encoding));
  return file;
}

describe("the canon", () => {
  test("is 66 books with no duplicate identity in any of its four namespaces", () => {
    expect(CANON).toHaveLength(66);
    for (const key of ["abbrev", "usfx", "osis", "myBible"] as const) {
      expect(new Set(CANON.map((book) => book[key])).size).toBe(66);
    }
  });

  test("splits the testaments by position, not by a list of names", () => {
    // The bug this replaced: a 39-name set that did not match the bundled
    // bible's own abbreviations, so 23 Old Testament books were stored as NT.
    expect(testamentOf(39)).toBe("OT");
    expect(testamentOf(40)).toBe("NT");
    expect(canonByStandardCode("1SA")?.abbrev).toBe("1sm");
    expect(testamentOf(canonByStandardCode("1SA")!.index)).toBe("OT");
    expect(testamentOf(canonByStandardCode("Ps")!.index)).toBe("OT");
    expect(testamentOf(canonByStandardCode("Mal")!.index)).toBe("OT");
  });

  test("resolves a book by every spelling a format uses", () => {
    expect(canonByStandardCode("GEN")).toBe(canonByStandardCode("Gen"));
    expect(canonByStandardCode("gen")).toBe(canonByStandardCode("GEN"));
    // An osisID arrives whole; the caller should not have to split it.
    expect(canonByStandardCode("Gen.1.1")?.abbrev).toBe("gn");
    expect(canonByIndex(66)?.abbrev).toBe("re");
    expect(canonByMyBibleNumber(230)?.abbrev).toBe("ps");
    expect(canonByMyBibleNumber(999)).toBeNull();
  });

  test("the app's abbreviations and the standards' codes are different namespaces", () => {
    // `jud` is Jueces here, because that is how `rv1909.json` spells it.
    // `JUD` is Judas in USFX. In one shared map the later one wins and Judges
    // becomes a New Testament book — which is what merging them actually did.
    expect(canonByAbbrev("jud")?.name).toBe("Jueces");
    expect(canonByStandardCode("JUD")?.name).toBe("Judas");
    expect(canonByStandardCode("JDG")?.name).toBe("Jueces");
    // A short name of unknown provenance reads as the standard first.
    expect(canonByLooseCode("JUD")?.name).toBe("Judas");
  });
});

describe("Zefania XML", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<XMLBIBLE biblename="Prueba">
  <INFORMATION><title>Reina Valera 1909</title><language>SPA</language></INFORMATION>
  <BIBLEBOOK bnumber="1" bname="Génesis" bsname="Gn">
    <CHAPTER cnumber="1">
      <VERS vnumber="1">En el principio creó Dios<NOTE>nota del traductor</NOTE> los cielos.</VERS>
      <VERS vnumber="2">Y la tierra estaba desordenada.</VERS>
    </CHAPTER>
  </BIBLEBOOK>
  <BIBLEBOOK bnumber="65" bname="Judas">
    <CHAPTER cnumber="1"><VERS vnumber="1">Judas, siervo de Jesucristo.</VERS></CHAPTER>
  </BIBLEBOOK>
</XMLBIBLE>`;

  test("reads its title, language, books and verses", () => {
    const parsed = parseBibleFile(write("zefania.xml", xml));
    expect(parsed.name).toBe("Reina Valera 1909");
    // `SPA` is ISO 639-2 and the column holds two letters.
    expect(parsed.language).toBe("es");
    expect(parsed.books.map((b) => b.abbrev)).toEqual(["gn", "jd"]);
    expect(parsed.books[0]!.name).toBe("Génesis");
    expect(parsed.books[0]!.testament).toBe("OT");
    expect(parsed.books[1]!.testament).toBe("NT");
  });

  test("drops a translator's note out of the verse", () => {
    // It would otherwise be projected in the middle of the sentence.
    const parsed = parseBibleFile(write("zefania-note.xml", xml));
    expect(parsed.books[0]!.verses[0]!.text).not.toContain("nota del traductor");
    expect(parsed.books[0]!.verses[0]!.text).toContain("En el principio");
  });

  test("a single-chapter book is not iterated by its keys", () => {
    // Judas, Abdías, 2 and 3 Juan: without `isArray` these parse to an object
    // and the chapter loop walks the property names instead of the chapters.
    const parsed = parseBibleFile(write("zefania-one.xml", xml));
    const jude = parsed.books[1]!;
    expect(jude.chapterCount).toBe(1);
    expect(jude.verses).toEqual([{ chapter: 1, verse: 1, text: "Judas, siervo de Jesucristo." }]);
  });

  test("a Latin-1 file keeps its accents", () => {
    // Most of the public-domain Zefania catalogue is still ISO-8859-1, and
    // Spanish is the language where reading it as UTF-8 destroys every other
    // word.
    const latin = xml.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"');
    const parsed = parseBibleFile(write("zefania-latin.xml", latin, "latin1"));
    expect(parsed.books[0]!.name).toBe("Génesis");
    expect(parsed.books[0]!.verses[0]!.text).toContain("creó Dios");
  });

  test("reads one inside a zip", () => {
    const file = path.join(dir, "zefania.zip");
    fs.writeFileSync(
      file,
      zipSync({ "readme.txt": strToU8("licencia"), "biblia.xml": strToU8(xml) }),
    );
    expect(detectBibleFormat(file)).toBe("zefania");
    // The bible, not the readme — largest entry wins.
    expect(parseBibleFile(file).books[0]!.abbrev).toBe("gn");
  });
});

describe("USFX XML", () => {
  // Milestoned: `<v/>` marks where a verse starts and its text is a SIBLING,
  // which is the whole reason this format needs the ordered walker.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<usfx>
  <languageCode>spa</languageCode>
  <book id="JHN">
    <id id="JHN">Juan, del Nuevo Testamento</id>
    <h>Juan</h>
    <c id="3"/>
    <p><v id="16"/>Porque de tal manera amó Dios al mundo<f caller="+">nota al pie</f>, que ha dado a su Hijo.<ve/></p>
    <p><v id="17"/>Porque no envió Dios a su Hijo al mundo para condenar al mundo.<ve/></p>
  </book>
</usfx>`;

  test("puts each verse's sibling text with the right verse", () => {
    const parsed = parseBibleFile(write("usfx.xml", xml));
    expect(parsed.language).toBe("es");
    const john = parsed.books[0]!;
    expect(john.abbrev).toBe("jo");
    expect(john.name).toBe("Juan");
    expect(john.verses).toHaveLength(2);
    expect(john.verses[0]).toMatchObject({ chapter: 3, verse: 16 });
    expect(john.verses[0]!.text).toContain("amó Dios al mundo");
    expect(john.verses[0]!.text).toContain("ha dado a su Hijo");
    // The give-away that the walk is really ordered: verse 16's text must not
    // have swallowed verse 17's.
    expect(john.verses[0]!.text).not.toContain("condenar");
    expect(john.verses[1]!.text).toContain("condenar al mundo");
  });

  test("a verse wrapped over lines in the file is one line", () => {
    const wrapped = `<usfx><languageCode>spa</languageCode><book id="EXO"><c id="16"/>
<p><v id="25"/>Comedlo hoy, porque hoy es reposo delante del
        <nd>Señor</nd>;   hoy no lo hallaréis en el campo.<ve/></p></book></usfx>`;
    const exodus = parseBibleFile(write("usfx-3.xml", wrapped)).books[0]!;
    expect(exodus.verses[0]!.text).toBe(
      "Comedlo hoy, porque hoy es reposo delante del Señor; hoy no lo hallaréis en el campo.",
    );
  });

  test("drops the footnote and the machine id line", () => {
    const john = parseBibleFile(write("usfx-2.xml", xml)).books[0]!;
    expect(john.verses[0]!.text).not.toContain("nota al pie");
    expect(john.verses[0]!.text).not.toContain("del Nuevo Testamento");
  });
});

describe("OSIS XML", () => {
  test("reads the container form", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<osis><osisText osisIDWork="test" xml:lang="es-419">
  <div type="book" osisID="Ps">
    <title type="main">Salmos</title>
    <chapter osisID="Ps.23">
      <verse osisID="Ps.23.1">Jehová es mi pastor<note>nota</note>; nada me faltará.</verse>
      <verse osisID="Ps.23.2">En lugares de delicados pastos me hará descansar.</verse>
    </chapter>
  </div>
</osisText></osis>`;
    const parsed = parseBibleFile(write("osis-container.xml", xml));
    // A BCP 47 tag with a region reduces to the language.
    expect(parsed.language).toBe("es");
    const psalms = parsed.books[0]!;
    expect(psalms.abbrev).toBe("ps");
    expect(psalms.name).toBe("Salmos");
    expect(psalms.testament).toBe("OT");
    expect(psalms.verses[0]!.text).toBe("Jehová es mi pastor; nada me faltará.");
    expect(psalms.verses[1]!.chapter).toBe(23);
  });

  test("reads the milestone form, where the text is a sibling", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<osis><osisText xml:lang="es">
  <div type="book" osisID="John">
    <title type="main">Juan</title>
    <chapter sID="John.3" osisID="John.3"/>
    <p>
      <verse sID="John.3.16" osisID="John.3.16"/>Porque de tal manera amó Dios al mundo.<verse eID="John.3.16"/>
      <verse sID="John.3.17" osisID="John.3.17"/>Porque no envió Dios a su Hijo para condenar.<verse eID="John.3.17"/>
    </p>
    <chapter eID="John.3"/>
  </div>
</osisText></osis>`;
    const john = parseBibleFile(write("osis-milestone.xml", xml)).books[0]!;
    expect(john.abbrev).toBe("jo");
    expect(john.verses).toHaveLength(2);
    expect(john.verses[0]!.text).toBe("Porque de tal manera amó Dios al mundo.");
    expect(john.verses[1]!.text).toBe("Porque no envió Dios a su Hijo para condenar.");
  });

  test("a section heading mid-chapter is not read as scripture", () => {
    // `<title>` is legal at both levels; only the one directly inside the book
    // div is the book's name. The other is the translator's voice.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<osis><osisText xml:lang="es">
  <div type="book" osisID="Gen"><title type="main">Génesis</title>
    <chapter osisID="Gen.1">
      <title type="section">La creación</title>
      <verse osisID="Gen.1.1">En el principio.</verse>
    </chapter>
  </div>
</osisText></osis>`;
    const genesis = parseBibleFile(write("osis-heading.xml", xml)).books[0]!;
    expect(genesis.name).toBe("Génesis");
    expect(genesis.verses[0]!.text).toBe("En el principio.");
  });
});

describe("SQLite modules", () => {
  test("MySword, whose books are numbered 1..66", () => {
    const file = path.join(dir, "rv.bbl.mybible");
    const db = new Database(file);
    db.exec(`CREATE TABLE Details (Title TEXT, Abbreviation TEXT, Description TEXT, Language TEXT)`);
    db.exec(`CREATE TABLE Bible (Book INT, Chapter INT, Verse INT, Scripture TEXT)`);
    db.prepare(`INSERT INTO Details VALUES (?, ?, ?, ?)`).run("RVR", "RV", "Reina Valera", "es");
    const insert = db.prepare(`INSERT INTO Bible VALUES (?, ?, ?, ?)`);
    insert.run(43, 3, 16, "Porque de tal <FI>manera<Fi> amó<WG25> Dios al mundo.<RF>nota</Rf>");
    insert.run(19, 23, 1, "Jehová es mi pastor.");
    db.close();

    expect(detectBibleFormat(file)).toBe("sqlite");
    const parsed = parseBibleFile(file);
    expect(parsed.name).toBe("Reina Valera");
    expect(parsed.language).toBe("es");
    // Canonical order, not insertion order: Psalms before John.
    expect(parsed.books.map((b) => b.abbrev)).toEqual(["ps", "jo"]);
    expect(parsed.books[1]!.verses[0]!.text).toBe("Porque de tal manera amó Dios al mundo.");
  });

  test("MyBible.zone, whose books are numbered 10..730", () => {
    const file = path.join(dir, "module.SQLite3");
    const db = new Database(file);
    db.exec(`CREATE TABLE info (name TEXT, value TEXT)`);
    db.exec(`CREATE TABLE books (book_number INT, short_name TEXT, long_name TEXT)`);
    db.exec(`CREATE TABLE verses (book_number INT, chapter INT, verse INT, text TEXT)`);
    db.prepare(`INSERT INTO info VALUES (?, ?)`).run("description", "RV1909");
    db.prepare(`INSERT INTO info VALUES (?, ?)`).run("language", "es");
    db.prepare(`INSERT INTO books VALUES (?, ?, ?)`).run(10, "Gn", "Génesis");
    db.prepare(`INSERT INTO verses VALUES (?, ?, ?, ?)`).run(
      10,
      1,
      1,
      "En el principio<S>7225</S> creó Dios los cielos.",
    );
    db.close();

    const parsed = parseBibleFile(file);
    expect(parsed.name).toBe("RV1909");
    expect(parsed.books[0]).toMatchObject({ abbrev: "gn", name: "Génesis", testament: "OT" });
    expect(parsed.books[0]!.verses[0]!.text).toBe("En el principio creó Dios los cielos.");
  });

  test("a SQLite file that is not a bible is refused, not half-read", () => {
    const file = path.join(dir, "not-a-bible.sqlite3");
    const db = new Database(file);
    db.exec(`CREATE TABLE notes (id INT)`);
    db.close();
    expect(() => parseBibleFile(file)).toThrow(BibleFormatError);
  });
});

describe("module markup", () => {
  test("apparatus goes with its contents, emphasis keeps its words", () => {
    // A Strong's number left behind reads as a bare "430" spliced into the
    // sentence on the projector.
    expect(cleanModuleText("creó<S>1254</S> Dios<S>430</S>")).toBe("creó Dios");
    expect(cleanModuleText("de tal <FI>manera</FI> amó")).toBe("de tal manera amó");
    // MySword closes a footnote with <Rf> and no slash; converted modules
    // write </Rf>. An unrecognised close swallows the rest of the verse.
    expect(cleanModuleText("al mundo<RF>ver Juan 3<Rf>, que ha dado")).toBe("al mundo, que ha dado");
    expect(cleanModuleText("al mundo<RF>ver Juan 3</Rf>, que ha dado")).toBe("al mundo, que ha dado");
    expect(cleanModuleText("primera<CM>segunda")).toBe("primera segunda");
    expect(cleanModuleText("Jes&#250;s &amp; Juan")).toBe("Jesús & Juan");
  });
});

describe("format detection", () => {
  test("goes by the bytes, so a renamed file still works", () => {
    // An operator who renames a module to get past a file dialog is not doing
    // anything unreasonable, and an extension is a hint rather than the truth.
    const file = write(
      "mystery.txt",
      `<?xml version="1.0"?><XMLBIBLE><BIBLEBOOK bnumber="1"><CHAPTER cnumber="1"><VERS vnumber="1">x</VERS></CHAPTER></BIBLEBOOK></XMLBIBLE>`,
    );
    expect(detectBibleFormat(file)).toBe("zefania");
  });

  test("something that is no bible format at all says so", () => {
    expect(() => detectBibleFormat(write("prose.txt", "Esto no es una biblia."))).toThrow(BibleFormatError);
  });

  test("a well-formed file with no verses in it is refused rather than stored", () => {
    // Parsed as SOMETHING and yielded nothing — a version with an empty book
    // list in the Bible tab is a bug report waiting to happen.
    const file = write("empty.xml", `<?xml version="1.0"?><XMLBIBLE><INFORMATION/></XMLBIBLE>`);
    expect(parseBibleFile(file).books).toEqual([]);
  });
});
