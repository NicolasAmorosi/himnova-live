import fs from "node:fs";
import path from "node:path";
import { ASSET_KINDS, type AssetKind } from "@shared/constants";
import type { SettingsMap } from "@shared/types/settings";
import type { MediaRepo } from "../db/repositories/media.repo";
import type { SongsRepo } from "../db/repositories/songs.repo";
import type { SettingsRepo } from "../db/repositories/settings.repo";

/**
 * Relocating one missing file, or one linked folder, fixes everything else the
 * same move left behind (owner, 2026-11-13). A church that moved `D:\Iglesia`
 * to `E:\Iglesia`, or its whole profile to another computer (`C:\Users\juan`
 * → `C:\Users\maria`), used to «Locate…» each of its 200 videos one by one.
 *
 * The move is what changed between the old path and the new one: their common
 * trailing folder names dropped (`moveBetween`). Every other path the app keeps
 * under the old part is tried under the new one: library rows, an operator-
 * chosen deck soundtrack, linked folders (Media's and Songs'), the views open on
 * them, folder songs and library songs tied to a file. A path changes only when
 * its old place is gone AND its twin is there, so nothing that still works is
 * touched and nothing points at a file that does not exist.
 */

/** The leading folder names `from` became `to`; the names after them stayed. */
export type PathMove = { from: readonly string[]; to: readonly string[] };

/** A path's names. Either separator: a profile brought from Windows to a Mac
 *  or a Linux PC keeps backslashes in its paths. `E:\` is `["E:"]`. */
export function namesOf(filePath: string): string[] {
  const names = filePath.split(/[\\/]/);
  if (names.length > 1 && names.at(-1) === "") names.pop();
  return names;
}

const sameName = (a: string, b: string, foldCase: boolean): boolean =>
  a.normalize("NFC") === b.normalize("NFC") || (foldCase && a.toLowerCase() === b.toLowerCase());

/** What changed when the folder `before` became `after` (names, `namesOf`):
 *  their common trailing names dropped. `null` when nothing did. */
export function moveBetween(
  before: readonly string[],
  after: readonly string[],
  foldCase = process.platform === "win32",
): PathMove | null {
  let shared = 0;
  while (
    shared < before.length &&
    shared < after.length &&
    sameName(before[before.length - 1 - shared]!, after[after.length - 1 - shared]!, foldCase)
  ) {
    shared += 1;
  }
  const from = before.slice(0, before.length - shared);
  const to = after.slice(0, after.length - shared);
  return from.length === 0 || to.length === 0 ? null : { from, to };
}

/** `filePath` under the move's new part, or `null` when it is not under the old one. */
export function movedPath(
  filePath: string,
  move: PathMove,
  sep: string = path.sep,
  foldCase = process.platform === "win32",
): string | null {
  const names = namesOf(filePath);
  if (names.length < move.from.length) return null;
  if (!move.from.every((name, index) => sameName(name, names[index]!, foldCase))) return null;
  const moved = [...move.to, ...names.slice(move.from.length)];
  // A drive or the root alone keeps its separator: `E:` is that drive's current folder.
  if (moved.length === 1 && (moved[0] === "" || /^[A-Za-z]:$/.test(moved[0]!))) return moved[0] + sep;
  return moved.join(sep);
}

type Found = Map<string, { after: string; stat: fs.Stats }>;

const PROBE_CHUNK = 200;

/** Of `paths`, the ones the move explains: gone, with their twin there as a
 *  `kind`. Asynchronous and in chunks, like the sweep: a drive or a share that
 *  went away answers slowly, and main frozen is the projector frozen. */
async function explained(paths: Iterable<string>, move: PathMove, kind: "file" | "folder"): Promise<Found> {
  const pairs = [...new Set(paths)].flatMap((before) => {
    const after = movedPath(before, move);
    return after === null || after === before ? [] : [[before, after] as const];
  });
  const found: Found = new Map();
  const stat = (p: string) => fs.promises.stat(p).catch(() => null);
  for (let i = 0; i < pairs.length; i += PROBE_CHUNK) {
    const slice = pairs.slice(i, i + PROBE_CHUNK);
    const stats = await Promise.all(slice.map(([before, after]) => Promise.all([stat(before), stat(after)])));
    slice.forEach(([before, after], index) => {
      const [old, now] = stats[index]!;
      if (old || !now || (kind === "file" ? !now.isFile() : !now.isDirectory())) return;
      found.set(before, { after, stat: now });
    });
  }
  return found;
}

export type MoveRepos = { media: MediaRepo; songs: SongsRepo; settings: SettingsRepo };

/**
 * Applies `move` to everything it explains. `fixed` = the old paths that now
 * point at their new place (a file used twice, say as a library row and as a
 * deck's soundtrack, counts once); `kinds` = the library kinds that changed.
 */
export async function followMove(
  move: PathMove,
  { media, songs, settings }: MoveRepos,
): Promise<{ fixed: ReadonlySet<string>; kinds: ReadonlySet<AssetKind> }> {
  const rows = media.pathRows();
  const sources = songs.sourcePaths();
  const mediaFolders = settings.get("library.linkedFolders");
  const songFolders = settings.get("songs.linkedFolders");
  const soundtracks = rows.filter((row) => row.linkedAudioManual === 1 && row.linkedAudioPath !== null);

  const [files, folders] = await Promise.all([
    explained([...rows.map((row) => row.path), ...soundtracks.map((row) => row.linkedAudioPath!), ...sources.files], move, "file"),
    explained([...ASSET_KINDS.flatMap((kind) => mediaFolders[kind]), ...songFolders, ...sources.folders], move, "folder"),
  ]);

  const kinds = media.relocateMany(
    rows.flatMap((row) => {
      const found = files.get(row.path);
      return found ? [{ id: row.id, path: found.after, stat: found.stat }] : [];
    }),
  );
  for (const row of soundtracks) {
    const found = files.get(row.linkedAudioPath!);
    if (found) media.setLinkedAudio(row.id, found.after);
  }

  // Before the settings: `song:list` lets go of the songs of a folder no
  // longer linked, which the old folder would be once the setting moves.
  const afterOf = (found: Found) => new Map([...found].map(([before, { after }]) => [before, after]));
  songs.relocateSources(afterOf(folders), afterOf(files));

  const moved = (folder: string) => folders.get(folder)?.after ?? folder;
  const unique = (list: string[]) => [...new Set(list.map(moved))];
  const changed: Partial<SettingsMap> = {};
  const linked = Object.fromEntries(ASSET_KINDS.map((kind) => [kind, unique(mediaFolders[kind])])) as Record<AssetKind, string[]>;
  if (ASSET_KINDS.some((kind) => linked[kind].join("\n") !== mediaFolders[kind].join("\n"))) {
    changed["library.linkedFolders"] = linked;
  }
  if (unique(songFolders).join("\n") !== songFolders.join("\n")) changed["songs.linkedFolders"] = unique(songFolders);
  const views = settings.get("library.activeView");
  if (ASSET_KINDS.some((kind) => moved(views[kind]) !== views[kind])) {
    changed["library.activeView"] = Object.fromEntries(ASSET_KINDS.map((kind) => [kind, moved(views[kind])])) as Record<
      AssetKind,
      string
    >;
  }
  const songView = settings.get("songs.activeView");
  if (moved(songView) !== songView) changed["songs.activeView"] = moved(songView);
  if (Object.keys(changed).length > 0) settings.setMany(changed);

  return { fixed: new Set([...files.keys(), ...folders.keys()]), kinds };
}
