import fs from "node:fs";
import type { MediaRepo } from "../../../src/main/db/repositories/media.repo";
import type { AssetKind } from "../../../src/shared/constants";
import type { MediaAsset } from "../../../src/shared/types/media";

/** One file through the app's own upsert (`library-import.ts` stats, then `upsertBatch`). */
export function upsertFile(repo: MediaRepo, filePath: string, kind: AssetKind, inLibrary: boolean): MediaAsset {
  return repo.upsertBatch([{ path: filePath, stat: fs.statSync(filePath) }], kind, inLibrary).assets[0]!;
}
