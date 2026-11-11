import { interpolate, resolveKey, type MessagePaths, type TParams } from "@shared/i18n";
import { LOCALES, type Locale } from "@shared/types/settings";
import es, { type MainMessages } from "./messages/es";
import en from "./messages/en";
import it from "./messages/it";
import pt from "./messages/pt";

/**
 * Main's own translator, for what main says to the operator: the menu, its
 * dialogs, and the errors that reach a toast. The renderer's dictionary cannot
 * serve here — a menu is built before any window exists.
 *
 * The locale is pushed in rather than read from `SettingsRepo` on every call:
 * the migration-failure dialog runs before the repos exist. `index.ts` sets it
 * from the settings at startup and the `settings:set` handler on every change.
 *
 * No `electron` import, on purpose: the Vitest suite loads modules that call
 * `mt()` (the Bible readers, the slides errors). The OS language lookup lives
 * in `system-locale.ts`.
 */
const dictionaries: Record<Locale, MainMessages> = { es, en, it, pt };

let current: Locale = "es";

export function setMainLocale(locale: Locale): void {
  current = locale;
}

export function mainLocale(): Locale {
  return current;
}

/** The whole dictionary of the current locale, for a caller that needs a
 *  group of texts as data rather than one message (the seeded scenes). */
export function mainMessages(): MainMessages {
  return dictionaries[current];
}

/** Every language's dictionary, for a name that may have been written in any of them (a background
 *  the starter look seeded before the operator changed language). */
export function everyMainMessages(): MainMessages[] {
  return Object.values(dictionaries);
}

export type MainMessageKey = MessagePaths<MainMessages>;

export function mt(key: MainMessageKey, params?: TParams): string {
  return interpolate(resolveKey(dictionaries[current], key), params, current);
}

/** `"pt-BR"`, `"en_US"`, `"it"` → a supported locale, or `null`. */
export function toLocale(tag: string): Locale | null {
  const language = tag.slice(0, 2).toLowerCase();
  return (LOCALES as readonly string[]).includes(language) ? (language as Locale) : null;
}
