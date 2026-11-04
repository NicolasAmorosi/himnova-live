import type Database from "better-sqlite3";
import type { Db } from "../client";
import { mediaConversions } from "../schema";
import type { AssetKind } from "@shared/constants";

/** One video/audio asset as `media/engine-assets.ts` sees it: the file, and its
 *  stored probe (null when it was never probed). */
export type ConversionCandidate = {
  id: number;
  kind: AssetKind;
  path: string;
  ext: string;
  sizeBytes: number | null;
  mtimeMs: number | null;
  probe: {
    sourceSize: number;
    sourceMtimeMs: number;
    probeVersion: number;
    probeJson: string | null;
  } | null;
};

type CandidateRow = Omit<ConversionCandidate, "probe"> & {
  sourceSize: number | null;
  sourceMtimeMs: number;
  probeVersion: number;
  probeJson: string | null;
};

/** `media_conversions`: the probe of each library video and audio. The name predates step 1.4 of the
 *  engine plan, when this table also recorded a playable copy — see the table in `schema.ts`. */
export class ConversionsRepo {
  constructor(
    private readonly db: Db,
    private readonly sqlite: Database.Database,
  ) {}

  /** Every video and audio file that is still there, linked folders included
   *  (`in_library = 0` is most of a real library), with its probe — or just
   *  the one asset `id` names. */
  candidates(id?: number): ConversionCandidate[] {
    const rows = this.sqlite
      .prepare(
        `SELECT a.id, a.kind, a.path, a.ext, a.size_bytes AS sizeBytes, a.mtime_ms AS mtimeMs,
                c.source_size AS sourceSize, c.source_mtime_ms AS sourceMtimeMs,
                c.probe_version AS probeVersion, c.probe_json AS probeJson
           FROM media_assets a
           LEFT JOIN media_conversions c ON c.media_asset_id = a.id
          WHERE a.kind IN ('video', 'audio') AND a.missing_since IS NULL
            ${id === undefined ? "" : "AND a.id = ?"}`,
      )
      .all(...(id === undefined ? [] : [id])) as CandidateRow[];
    return rows.map(({ sourceSize, sourceMtimeMs, probeVersion, probeJson, ...asset }) => ({
      ...asset,
      probe: sourceSize === null ? null : { sourceSize, sourceMtimeMs, probeVersion, probeJson },
    }));
  }

  /** Records a probe for the bytes `(size, mtime)` describe. */
  recordProbe(id: number, sourceSize: number, sourceMtimeMs: number, probeVersion: number, probeJson: string | null) {
    const now = Date.now();
    this.db
      .insert(mediaConversions)
      .values({ mediaAssetId: id, sourceSize, sourceMtimeMs, probeVersion, probeJson, updatedAt: now })
      .onConflictDoUpdate({
        target: mediaConversions.mediaAssetId,
        set: { sourceSize, sourceMtimeMs, probeVersion, probeJson, updatedAt: now },
      })
      .run();
  }
}
