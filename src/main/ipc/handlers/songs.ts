import type { Handlers } from "../register";
import { getProgramsRepo, getSettingsRepo, getSongsRepo } from "../../services/repos";
import { removeSong } from "../../services/song-removal";
import {
  importEasyWorshipFolder,
  importOpenLpDatabase,
  importOpenLyricsFiles,
  importSongTextFiles,
} from "../../services/song-import";
import { exportSongUsage } from "../../services/song-usage";
import { showOpenDialogFor } from "../open-dialog";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, type OpenDialogOptions } from "electron";
import { IpcError } from "@shared/ipc/result";
import { isSongThemeUpsert, isSongTitle, isSongUpsert } from "@shared/song-validators";
import { SONG_IMPORT_SOURCES, type SongThemeUpsert, type SongUpsert } from "@shared/types/song";
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

/** The sources picked as one or more files. A ChordPro file may be a `.txt`
 *  too: the reader tells it from SongSelect's by its words. */
const FILE_SOURCES = {
  openlyrics: {
    title: "songs.openLyricsPickTitle",
    filter: { name: "OpenLyrics", extensions: ["xml"] },
    read: importOpenLyricsFiles,
  },
  songselect: { title: "songs.songSelectPickTitle", filter: { name: "SongSelect", extensions: ["txt"] }, read: importSongTextFiles },
  chordpro: {
    title: "songs.chordProPickTitle",
    filter: { name: "ChordPro", extensions: ["cho", "chordpro", "chopro", "crd", "pro", "txt"] },
    read: importSongTextFiles,
  },
} as const;

const defaultPathIfThere = (folder: string): Partial<OpenDialogOptions> =>
  fs.existsSync(folder) ? { defaultPath: folder } : {};

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
  | "song:import"
  | "song:usageReport"
  | "songTheme:list"
  | "songTheme:create"
  | "songTheme:update"
  | "songTheme:delete"
> = {
  "song:list": () => getSongsRepo().list(),
  "song:create": (input) => getSongsRepo().create(assertValid(input)),
  "song:update": (input) => getSongsRepo().update(input.id, assertValid(input)),
  "song:duplicate": ({ id, title }) => {
    if (!isSongTitle(title)) throw new IpcError({ code: "INVALID_SONG", message: mt("songs.invalidTitle") });
    return getSongsRepo().duplicate(id, title.trim());
  },
  "song:delete": ({ id, force }) => {
    removeSong(id, force ?? false);
  },
  "song:usages": ({ id }) => getProgramsRepo().findSongUsages(id),
  "song:search": ({ query, limit }) => getSongsRepo().search(query, limit),
  "song:import": async (req, ev) => {
    const from = req?.from;
    if (!SONG_IMPORT_SOURCES.includes(from)) throw new IpcError({ code: "INVALID_ARGUMENT", message: "Invalid import source." });
    if (from === "easyworship") {
      const result = await showOpenDialogFor(ev.sender, {
        title: mt("songs.ewPickTitle"),
        properties: ["openDirectory"],
        ...defaultPathIfThere(EASYWORSHIP_DEFAULT_DATA),
      });
      const folder = result.filePaths[0];
      return result.canceled || !folder ? null : importEasyWorshipFolder(folder);
    }
    if (from === "openlp") {
      const result = await showOpenDialogFor(ev.sender, {
        title: mt("songs.openLpPickTitle"),
        properties: ["openFile"],
        filters: [{ name: "OpenLP", extensions: ["sqlite", "db"] }],
        ...defaultPathIfThere(openLpDefaultFolder()),
      });
      const file = result.filePaths[0];
      return result.canceled || !file ? null : importOpenLpDatabase(file);
    }
    const files = FILE_SOURCES[from];
    const result = await showOpenDialogFor(ev.sender, {
      title: mt(files.title),
      properties: ["openFile", "multiSelections"],
      filters: [{ name: files.filter.name, extensions: [...files.filter.extensions] }],
    });
    return result.canceled || result.filePaths.length === 0 ? null : files.read(result.filePaths);
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
