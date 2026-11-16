import type { Db } from "../client";
import { settings } from "../schema";
import { DEFAULT_SETTINGS, SETTINGS_NORMALIZERS, SETTINGS_VALIDATORS, type SettingsMap } from "@shared/types/settings";

/** A key whose default is a single value (a string, a number, a boolean, or null), not a structure. */
const isScalarKey = (key: keyof SettingsMap): boolean => {
  const fallback = DEFAULT_SETTINGS[key];
  return fallback === null || typeof fallback !== "object";
};

/**
 * Settings are read from a hot path, so they are held in memory.
 *
 * `resolveRenderTarget()` reads a key and runs once per asset on every
 * prewarm; `worship://logo` reads one per request. Each of those used to be a
 * SELECT plus a `JSON.parse`, on the thread that also serves the projection
 * window. The table is a handful of rows that only this process writes, so the
 * whole map is loaded once and kept — `setMany` is the only mutation point and
 * it updates the cache in the same call.
 */
export class SettingsRepo {
  /** Null until the first read. Not populated in the constructor: repos are
   *  built during startup, before migrations have necessarily finished
   *  creating the table. */
  private cache: SettingsMap | null = null;

  constructor(private readonly db: Db) {}

  private load(): SettingsMap {
    if (this.cache) return this.cache;
    const rows = this.db.select().from(settings).all();
    const result = structuredClone(DEFAULT_SETTINGS);
    for (const row of rows) {
      if (row.key in result) {
        try {
          const parsed: unknown = JSON.parse(row.value);
          const key = row.key as keyof SettingsMap;
          // A structured key gets read field by field rather than trusted
          // whole (see `SETTINGS_NORMALIZERS`). A scalar key goes through its
          // validator: a value another build wrote (`ui.locale: "fr"`) left a
          // `Select` empty, or the UI in raw keys, and reads as the default
          // (2026-11-15 audit, D13). A structure without a normalizer (a
          // folder list) still lands as stored: all-or-nothing would drop the
          // operator's own entries over one that is off.
          const normalize = SETTINGS_NORMALIZERS[key];
          if (normalize) (result as Record<string, unknown>)[key] = (normalize as (value: unknown) => unknown)(parsed);
          else if (!isScalarKey(key) || SETTINGS_VALIDATORS[key](parsed)) (result as Record<string, unknown>)[key] = parsed;
        } catch {
          // A row that isn't valid JSON (a hand-edited DB) must not take the
          // whole settings map down with it — the default stands.
        }
      }
    }
    this.cache = result;
    return result;
  }

  /** Drops what is cached: a transaction that wrote settings and then rolled back left them here for the whole
   *  session, a theme id that no longer exists among them (2026-11-15 audit, D12). The next read reloads. */
  forget(): void {
    this.cache = null;
  }

  /** A fresh copy every time: the two `Record`-valued keys would otherwise
   *  hand the cache's own objects to a caller that may mutate them. */
  getAll(): SettingsMap {
    return structuredClone(this.load());
  }

  setMany(partial: Partial<SettingsMap>): void {
    const now = Date.now();
    const current = this.load();
    for (const [key, value] of Object.entries(partial)) {
      this.db
        .insert(settings)
        .values({ key, value: JSON.stringify(value), updatedAt: now })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: JSON.stringify(value), updatedAt: now },
        })
        .run();
      if (key in current) (current as Record<string, unknown>)[key] = structuredClone(value);
    }
  }

  /** The hot one. Returns the cached value by reference — every key main reads
   *  through here is a primitive; the object-valued ones are only ever read by
   *  the renderer, through `getAll`. */
  get<K extends keyof SettingsMap>(key: K): SettingsMap[K] {
    return this.load()[key];
  }
}
