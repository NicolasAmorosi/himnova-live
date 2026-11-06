import type { Db } from "../client";
import { settings } from "../schema";
import { DEFAULT_SETTINGS, SETTINGS_NORMALIZERS, type SettingsMap } from "@shared/types/settings";

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
          // A structured key gets read field by field rather than trusted
          // whole — see `SETTINGS_NORMALIZERS`. A scalar key has no entry and
          // lands exactly as it always did.
          const normalize = SETTINGS_NORMALIZERS[row.key as keyof SettingsMap];
          (result as Record<string, unknown>)[row.key] = normalize
            ? (normalize as (value: unknown) => unknown)(parsed)
            : parsed;
        } catch {
          // A row that isn't valid JSON (a hand-edited DB) must not take the
          // whole settings map down with it — the default stands.
        }
      }
    }
    this.cache = result;
    return result;
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
