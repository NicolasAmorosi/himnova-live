import { getDbHandle, getProgramsRepo, getSongsRepo } from "./repos";

/**
 * `overlay-plate-removal.ts` for a song: without `force`, the FK refuses a
 * song a saved program uses (`SONG_IN_USE`); with it, the program rows go
 * first, in the same transaction as the song.
 */
export function removeSong(id: number, force: boolean): void {
  if (!force) {
    getSongsRepo().delete(id);
    return;
  }
  const { sqlite } = getDbHandle();
  sqlite.transaction(() => {
    getProgramsRepo().deleteItemsBySong(id);
    getSongsRepo().delete(id);
  })();
}
