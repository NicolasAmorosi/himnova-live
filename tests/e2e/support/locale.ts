import type { Locale } from "../../../src/shared/types/settings";
import es from "../../../src/renderer/src/lib/i18n/messages/es";
import en from "../../../src/renderer/src/lib/i18n/messages/en";
import it from "../../../src/renderer/src/lib/i18n/messages/it";
import pt from "../../../src/renderer/src/lib/i18n/messages/pt";
import mainEs from "../../../src/main/i18n/messages/es";
import mainEn from "../../../src/main/i18n/messages/en";
import mainIt from "../../../src/main/i18n/messages/it";
import mainPt from "../../../src/main/i18n/messages/pt";

type Tree = { readonly [key: string]: unknown };

/** The window's dictionaries and main's (its seeded scenes, menus, dialogs). */
const DICTIONARIES: readonly Record<Locale, Tree>[] = [
  { es, en, it, pt },
  { es: mainEs, en: mainEn, it: mainIt, pt: mainPt },
];

/** Every value in `target` whose key reads `text` in `reference`. */
function parallel(reference: Tree, target: Tree, text: string, found: Set<string>): void {
  for (const [key, value] of Object.entries(reference)) {
    const other = target[key];
    if (typeof value === "string") {
      if (value === text && typeof other === "string") found.add(other);
    } else if (value && typeof value === "object" && other && typeof other === "object") {
      parallel(value as Tree, other as Tree, text, found);
    }
  }
}

/**
 * `text` — written as the app's Spanish (`es.ts`), which is what every spec is
 * written against — as the app writes it in `locale`, found by that wording in
 * the app's own dictionaries. A `{name}` in `text` is filled from `vars` after
 * the lookup. Throws when no key reads `text`, or when keys that read it in
 * Spanish disagree in `locale`: a locator that guesses finds the wrong button.
 */
export function translate(text: string, locale: Locale, vars: Record<string, string> = {}): string {
  let result = text;
  if (locale !== "es") {
    const found = new Set<string>();
    for (const dictionaries of DICTIONARIES) parallel(dictionaries.es, dictionaries[locale], text, found);
    if (found.size !== 1) {
      throw new Error(`«${text}» → ${locale}: ${found.size === 0 ? "no key reads it" : [...found].join(" | ")}`);
    }
    result = [...found][0]!;
  }
  return result.replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match);
}
