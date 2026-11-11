import type { BibleBookDTO } from "@shared/types/bible";
import type { Locale } from "@shared/types/settings";
import { canonIndex } from "@shared/bible-canon";
import { normalizeForSearch } from "@renderer/lib/utils";

/**
 * The Bible tab's «Referencia» finder (owner, 2026-11-06): what an operator
 * types — «Ro 8», «1 Co 13», «Jn 3:16», «Juan 3.16-18» — to the book, chapter
 * and verse they mean, in the interface's language, whatever the version
 * calls its books.
 */

/** The abbreviations each language prints, per book in canonical order (`|`
 *  between books, `,` between forms), lowercase, without spaces or dots, with
 *  their accents: «Jo» is João and «Jó» is Job in Portuguese. */
const ABBREVIATIONS: Record<Locale, string> = {
  es: "gn,gen,ge|ex,éx,exo|lv,lev|nm,num,nú|dt,deut,deu|jos|jue,jc|rt,rut|1s,1sa,1sam,1sm|2s,2sa,2sam,2sm|1r,1re,1rey|2r,2re,2rey|1cr,1cro,1crón|2cr,2cro,2crón|esd|neh,ne|est|job|sal,sl,salm|pr,prov,pro|ec,ecl,ecles|cnt,cant,ct|is,isa|jer,jr|lm,lam|ez,eze,ezeq|dn,dan,da|os|jl|am|abd,ab|jon|mi,miq|nah,na|hab,ha|sof|hag,hg|zac|mal|mt,mat|mr,mc,mar,marc|lc,luc,lu|jn,jua|hch,hech,hc|ro,rom,rm|1co,1cor|2co,2cor|ga,gál,gal|ef,efe|fil,flp,fp|col|1ts,1tes|2ts,2tes|1ti,1tim,1tm|2ti,2tim,2tm|tit,tt|flm,filem|he,heb|stg,sant|1p,1pe,1ped|2p,2pe,2ped|1jn,1jua|2jn,2jua|3jn,3jua|jud,jds|ap,apoc,apo",
  en: "gen,ge,gn|exod,ex,exo|lev,le,lv|num,nu,nm,nb|deut,dt,de|josh,jos,jsh|judg,jdg,jg,jdgs|ruth,rth,ru|1sam,1sa,1sm,1s|2sam,2sa,2sm,2s|1kgs,1ki,1kin,1k|2kgs,2ki,2kin,2k|1chr,1ch,1chron|2chr,2ch,2chron|ezra,ezr|neh,ne|esth,est,es|job,jb|ps,psa,psalm,pss,psm|prov,pr,prv|eccl,ecc,ec,eccles,qoh|song,ss,sg,sos|isa,is|jer,je,jr|lam,la|ezek,eze,ezk|dan,da,dn|hos,ho|joel,jl|amos,am|obad,ob|jonah,jon,jnh|mic,mc|nah,na|hab,hb|zeph,zep,zp|hag,hg|zech,zec,zc|mal,ml|matt,mt,mat|mark,mk,mrk,mr|luke,lk,luk|john,jn,jhn|acts,ac,act|rom,ro,rm|1cor,1co|2cor,2co|gal,ga|eph,ephes|phil,php,pp|col|1thess,1th,1thes|2thess,2th,2thes|1tim,1ti|2tim,2ti|titus,tit,ti|philem,phm,pm|heb|jas,jm|1pet,1pe,1pt,1p|2pet,2pe,2pt,2p|1john,1jn,1jhn,1jo|2john,2jn,2jhn,2jo|3john,3jn,3jhn,3jo|jude,jud,jd|rev,re,rv",
  it: "gn,gen|es,eso|lv,lev|nm,num|dt,deut|gs,gios|gdc,giud|rt,rut|1sam,1sa,1s|2sam,2sa,2s|1re,1r|2re,2r|1cr,1cron|2cr,2cron|esd|ne,neem|est|gb,giob|sal|pr,prov|qo,ec,eccl|ct,cant|is|ger|lam|ez,ezec|dn,dan|os|gl,gioe|am|abd|gio|mi,mic|na|ab,abac|sof|ag|zc,zac|ml,mal|mt,matt|mc,mar|lc,luc|gv,giov|at,att|rm,rom|1cor,1co|2cor,2co|gal|ef|fil|col|1ts,1tes|2ts,2tes|1tm,1tim|2tm,2tim|tt,tit|fm,filem|eb,ebr|gc,giac|1pt,1pie|2pt,2pie|1gv,1giov|2gv,2giov|3gv,3giov|gd,giuda|ap,apoc",
  pt: "gn,gên,gen|êx,ex|lv,lev|nm,núm,num|dt,deut|js,jos|jz,juí|rt|1sm,1sam|2sm,2sam|1rs,1re|2rs,2re|1cr,1crô|2cr,2crô|ed,esd|ne,nee|et,est|jó|sl,sal|pv,pr,prov|ec,ecl|ct,cânt|is|jr,jer|lm,lam|ez,eze|dn,dan|os|jl|am|ob,obd|jn,jon|mq|na|hc,hab|sf,sof|ag|zc,zac|ml,mal|mt|mc|lc|jo|at|rm,rom|1co,1cor|2co,2cor|gl,gál|ef|fp,fil|cl,col|1ts|2ts|1tm|2tm|tt|fm|hb|tg|1pe|2pe|1jo|2jo|3jo|jd|ap",
};

const TABLES = Object.fromEntries(
  Object.entries(ABBREVIATIONS).map(([locale, table]) => [locale, table.split("|").map((forms) => forms.split(","))]),
) as Record<Locale, string[][]>;

/** Lowercase, no spaces or dots, accents kept: «1 Co.» → «1co». */
const compact = (text: string) => text.normalize("NFC").toLowerCase().replace(/[\s.]+/g, "");
/** And without accents. */
const plain = (text: string) => normalizeForSearch(compact(text));

export type ParsedReference = {
  name: string;
  chapter: number | null;
  verseFrom: number | null;
  verseTo: number | null;
};

/** «Juan 3:16-18», «Jn 3.16», «Jn 3,16», «Juan 3 16», «1 Co 13», «1co13», «Juan» — and
 *  «Juan 3:» or «Juan 3:16-» half typed. The name is the shortest start that
 *  leaves a number after it, so «1 Juan 3» is «1 Juan», chapter 3, and «1 Juan 3 2» its verse 2. */
const REFERENCE = /^(.+?)\s*(\d+)(?:(?:\s*[:.,]\s*|\s+)(?:(\d+)(?:\s*[-–]\s*(\d+)?)?)?)?$/;

export function parseReference(query: string): ParsedReference {
  const text = query.trim();
  const match = REFERENCE.exec(text);
  if (!match?.[1] || !match[2]) return { name: text, chapter: null, verseFrom: null, verseTo: null };
  const verseFrom = match[3] ? Number(match[3]) : null;
  const verseTo = match[4] && verseFrom !== null && Number(match[4]) > verseFrom ? Number(match[4]) : null;
  return { name: match[1], chapter: Number(match[2]), verseFrom, verseTo };
}

export type ReferenceMatch = ParsedReference & { book: BibleBookDTO };

/**
 * How well what was typed names `book`, best first, or `null`: written exactly
 * as a name or abbreviation of the language (accents and all), then an
 * abbreviation without accents, the name without them, the start of the name,
 * the version's own abbreviation, anywhere in the name.
 */
function rank(book: BibleBookDTO, forms: readonly string[], typed: string): number | null {
  const name = compact(book.name);
  if (name === typed || forms.includes(typed)) return 0;
  const bare = plain(typed);
  if (forms.some((form) => plain(form) === bare)) return 1;
  if (plain(name) === bare) return 2;
  if (plain(name).startsWith(bare)) return 3;
  if (plain(book.abbrev) === bare) return 4;
  if (plain(name).includes(bare)) return 5;
  return null;
}

/** The books what was typed may mean, best first (canonical order among
 *  equals), with the chapter and verses it named — only books that have that
 *  chapter. A verse is checked when the chapter is loaded: the books carry no
 *  verse counts. A number alone is a verse of the `open` chapter (owner,
 *  2026-11-10: the book and chapter pickers, then the verse typed here). */
export function matchReference(
  books: readonly BibleBookDTO[],
  query: string,
  locale: Locale,
  open?: { book: BibleBookDTO; chapter: number },
): ReferenceMatch[] {
  const verse = /^\d+$/.test(query.trim()) ? Number(query.trim()) : 0;
  if (open && verse > 0) return [{ name: "", book: open.book, chapter: open.chapter, verseFrom: verse, verseTo: null }];
  const reference = parseReference(query);
  const typed = compact(reference.name);
  if (!typed) return [];
  const table = TABLES[locale];
  return books
    .flatMap((book) => {
      if (reference.chapter !== null && (reference.chapter < 1 || reference.chapter > book.chapterCount)) return [];
      const index = canonIndex(book, books.length);
      const score = rank(book, index === null ? [] : (table[index] ?? []), typed);
      return score === null ? [] : [{ match: { ...reference, book }, score }];
    })
    .sort((a, b) => a.score - b.score)
    .map(({ match }) => match);
}
