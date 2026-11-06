import type { Handlers } from "../register";
import { getProgramsRepo, getSettingsRepo, getSongsRepo } from "../../services/repos";
import { removeSong } from "../../services/song-removal";
import { importSongFiles } from "../../services/song-import";
import { listSongFolder, writeSongFile } from "../../services/song-files";
import { exportSongUsage } from "../../services/song-usage";
import { showOpenDialogFor } from "../open-dialog";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, type OpenDialogOptions } from "electron";
import { IpcError } from "@shared/ipc/result";
import { isSongThemeUpsert, isSongTitle, isSongUpsert } from "@shared/song-validators";
import { SONG_IMPORT_EXTENSIONS, type SongThemeUpsert, type SongUpsert } from "@shared/types/song";
import { mt } from "../../i18n";

/** Where EasyWorship 6/7 keeps its default profile's databases on Windows
 *  («Default» is the profile, and can be moved). */
const EASYWORSHIP_DEFAULT_DATA = "C:\\Users\\Public\\Documents\\Softouch\\EasyWorship\\Default\\v6.1\\Databases\\Data";

/** Where OpenLP keeps `songs.sqlite` unless it was moved (its manual). */
function openLpDefaultFolder(): string {
  if (process.platform === "win32") return path.join(app.getPath("appData"), "openlp", "data", "songs");
  if (process.platform === "darwin") return path.join(app.getPath("appData"), "openlp", "Data", "songs");
  return path.join(os.homedir(), ".local", "share", "openlp", "songs");
}

/** The first of `folders` this machine has, to open a picker in. */
function defaultPathAmong(...folders: string[]): Partial<OpenDialogOptions> {
  const folder = folders.find((candidate) => fs.existsSync(candidate));
  return folder ? { defaultPath: folder } : {};
}

function assertValidTheme(input: unknown): { name: string; style: SongThemeUpsert["style"] } {
  if (!isSongThemeUpsert(input)) {
    throw new IpcError({ code: "INVALID_SONG_THEME", message: mt("songs.invalidTheme") });
  }
  return { name: input.name.trim(), style: input.style };
}

/** Every write validated whole — `handlers/overlays.ts`'s reasoning. */
function assertValid(input: unknown): Omit<SongUpsert, "id"> {
  if (!isSongUpsert(input)) throw new IpcError({ code: "INVALID_SONG", message: mt("songs.invalid") });
  const { id: _id, ...song } = input;
  return song;
}

export const songsHandlers: Pick<
  Handlers,
  | "song:list"
  | "song:create"
  | "song:update"
  | "song:duplicate"
  | "song:delete"
  | "song:usages"
  | "song:search"
  | "song:listFolder"
  | "song:import"
  | "song:usageReport"
  | "songTheme:list"
  | "songTheme:create"
  | "songTheme:update"
  | "songTheme:delete"
> = {
  "song:list": () => getSongsRepo().list(),
  "song:create": (input) => getSongsRepo().create(assertValid(input)),
  // A song read from a file writes the file first: refused there, nothing changes.
  "song:update": (input) => {
    const song = assertValid(input);
    writeSongFile(input.id, song);
    return getSongsRepo().update(input.id, song);
  },
  "song:duplicate": ({ id, title }) => {
    if (!isSongTitle(title)) throw new IpcError({ code: "INVALID_SONG", message: mt("songs.invalidTitle") });
    return getSongsRepo().duplicate(id, title.trim());
  },
  "song:delete": ({ id, force }) => {
    removeSong(id, force ?? false);
  },
  "song:usages": ({ id }) => getProgramsRepo().findSongUsages(id),
  "song:search": ({ query, limit, folder }) =>
    getSongsRepo().search(query, limit, typeof folder === "string" ? folder : null),
  "song:listFolder": ({ path: folder }) => {
    if (typeof folder !== "string" || folder === "") throw new IpcError({ code: "INVALID_ARGUMENT", message: "Invalid folder." });
    return listSongFolder(folder);
  },
  // One picker for every format (owner, 2026-11-05). It opens where
  // EasyWorship or OpenLP keep their songs on this machine, when one does.
  "song:import": async (_req, ev) => {
    const result = await showOpenDialogFor(ev.sender, {
      title: mt("songs.importPickTitle"),
      properties: ["openFile", "multiSelections"],
      filters: [{ name: mt("songs.importFilter"), extensions: [...SONG_IMPORT_EXTENSIONS] }],
      ...defaultPathAmong(EASYWORSHIP_DEFAULT_DATA, openLpDefaultFolder()),
    });
    return result.canceled || result.filePaths.length === 0 ? null : importSongFiles(result.filePaths);
  },
  "song:usageReport": (req, ev) => exportSongUsage(ev.sender, Number(req?.from), Number(req?.to)),
  "songTheme:list": () => getSongsRepo().listThemes(),
  "songTheme:create": (input) => {
    const { name, style } = assertValidTheme(input);
    return getSongsRepo().createTheme(name, style);
  },
  "songTheme:update": (input) => {
    const { name, style } = assertValidTheme(input);
    return getSongsRepo().updateTheme(input.id, name, style);
  },
  "songTheme:delete": ({ id }) => {
    getSongsRepo().deleteTheme(id);
    const settings = getSettingsRepo();
    if (settings.get("songs.defaultThemeId") === id) settings.setMany({ "songs.defaultThemeId": null });
  },
};
