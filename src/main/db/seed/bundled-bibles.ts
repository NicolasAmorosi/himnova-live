import { BUILTIN_BIBLE_CODE } from "@shared/constants";
import type { Locale } from "@shared/types/settings";
import type { BibleVersionDTO, BundledBibleDTO } from "@shared/types/bible";

export type BundledBible = {
  /** The installed row's `code`: what a re-seed compares the file's hash against and what
   *  `bible_favorites` rows point at, so it never changes once shipped. */
  code: string;
  /** In `resources/bibles/` (`paths.biblesDir`). Rebuilt from its sources by the maintainer's scripts, outside
   *  this repo; `resources/bibles/NOTICE.txt` says where each text comes from. */
  file: string;
  name: string;
  language: Locale;
  /** The attribution the text's licence asks to show, in its own words; `null` when none. */
  credit: string | null;
};

/**
 * The Bible versions inside the installer: public-domain or freely licensed classics in the interface's four
 * languages. A new profile gets those of its language at first launch, in this order (the first is the default);
 * any other is installed from Settings ▸ Bible with one click, no internet. Everything after the RV1909 is Zefania
 * XML: it carries each verse's own number, so a verse a text leaves out (the ASV's 16) is a gap, never a shift.
 */
export const BUNDLED_BIBLES: readonly BundledBible[] = [
  { code: BUILTIN_BIBLE_CODE, file: "rv1909.json", name: "Reina-Valera 1909", language: "es", credit: null },
  {
    code: "vbl",
    file: "vbl.xml",
    name: "Versión Biblia Libre",
    language: "es",
    // Creative Commons Attribution-ShareAlike 4.0: the copyright line eBible.org publishes with it; the licence's
    // link and what was changed are in `resources/bibles/NOTICE.txt`.
    credit:
      "Versión Biblia Libre (VBL), copyright © 2018-2020 Jonathan Gallagher y Shelly Barrios de Avila. " +
      "Licencia Creative Commons Atribución-CompartirIgual 4.0.",
  },
  { code: "kjv", file: "kjv.xml", name: "King James Version", language: "en", credit: null },
  { code: "asv", file: "asv.xml", name: "American Standard Version", language: "en", credit: null },
  { code: "web", file: "web.xml", name: "World English Bible", language: "en", credit: null },
  { code: "riveduta1927", file: "riveduta1927.xml", name: "Riveduta 1927", language: "it", credit: null },
  { code: "diodati1885", file: "diodati1885.xml", name: "Diodati 1885", language: "it", credit: null },
  { code: "almeida1911", file: "almeida1911.xml", name: "Almeida 1911", language: "pt", credit: null },
  {
    code: "biblialivre",
    file: "biblialivre.xml",
    name: "Bíblia Livre",
    language: "pt",
    // Creative Commons Attribution 4.0 Brazil: the credit its authors suggest, without the link, which
    // `resources/bibles/NOTICE.txt` carries with the rest of it (they allow «any reasonable manner», down to
    // «BLIVRE» alone where there is no room).
    credit:
      "Bíblia Livre (BLIVRE), Copyright © Diego Santos, Mario Sérgio, e Marco Teles, fevereiro de 2018. " +
      "Licença Creative Commons Atribuição 4.0 Brasil.",
  },
];

/** The catalog as `bible:bundled` answers it: each entry with its installed row, if any. */
export function bundledBibleDTOs(installed: readonly BibleVersionDTO[]): BundledBibleDTO[] {
  const idByCode = new Map(installed.map((version) => [version.code, version.id]));
  return BUNDLED_BIBLES.map(({ code, credit, language, name }) => ({
    code,
    name,
    language,
    versionId: idByCode.get(code) ?? null,
    credit,
  }));
}
