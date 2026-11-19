/**
 * «Novedades» (owner, 2026-11-15, D4): a screen shown once after an update, to profiles that already existed. Each
 * key is a version that has one, oldest first; the control window gives each key its steps (`WhatsNewScreen`), and
 * a key without them does not compile. A version with nothing to show adds no key: the last one stays the latest.
 */
export const WHATS_NEW_KEYS = ["2.10", "2.11", "2.12", "2.12.1"] as const;
export type WhatsNewKey = (typeof WHATS_NEW_KEYS)[number];

export const LATEST_WHATS_NEW: WhatsNewKey = WHATS_NEW_KEYS[WHATS_NEW_KEYS.length - 1]!;

/** «2.10», «2.9»: what `ui.whatsNewSeen` stores. */
export const isWhatsNewKey = (value: unknown): value is string => typeof value === "string" && /^\d+(\.\d+)*$/.test(value);

/** Whether `a` is a later version than `b`, number by number («2.10» is after «2.9»). */
function isLater(a: string, b: string): boolean {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/** Whether a profile that last saw `seen` (`null`: none yet) has a «Novedades» to be shown. */
export const whatsNewDue = (seen: string | null): boolean => seen === null || isLater(LATEST_WHATS_NEW, seen);

/** The versions a profile that last saw `seen` has not been told about, oldest first: a church that skips a version
 *  (2.9 straight to 2.11) is told what both brought. None due (opened by hand from Settings ▸ About): the latest. */
export function whatsNewKeysFor(seen: string | null): readonly WhatsNewKey[] {
  const due = WHATS_NEW_KEYS.filter((key) => seen === null || isLater(key, seen));
  return due.length > 0 ? due : [LATEST_WHATS_NEW];
}
