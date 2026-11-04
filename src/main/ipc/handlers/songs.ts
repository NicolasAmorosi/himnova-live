import type { Handlers } from "../register";
import { getProgramsRepo, getSettingsRepo, getSongsRepo } from "../../services/repos";
import { removeSong } from "../../services/song-removal";
import { importEasyWorshipFolder } from "../../services/song-import";
import { showOpenDialogFor } from "../open-dialog";
import fs from "node:fs";
import { IpcError } from "@shared/ipc/result";
import { isSongThemeUpsert, isSongTitle, isSongUpsert } from "@shared/song-validators";
import type { SongThemeUpsert, SongUpsert } from "@shared/types/song";
import { mt } from "../../i18n";

/** Where EasyWorship 6/7 keeps its default profile's databases on Windows
 *  («Default» is the profile, and can be moved). */
const EASYWORSHIP_DEFAULT_DATA = "C:\\Users\\Public\\Documents\\Softouch\\EasyWorship\\Default\\v6.1\\Databases\\Data";

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
  | "song:importEasyWorship"
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
  "song:importEasyWorship": async (_req, ev) => {
    const result = await showOpenDialogFor(ev.sender, {
      title: mt("songs.ewPickTitle"),
      properties: ["openDirectory"],
      ...(fs.existsSync(EASYWORSHIP_DEFAULT_DATA) ? { defaultPath: EASYWORSHIP_DEFAULT_DATA } : {}),
    });
    const folder = result.filePaths[0];
    if (result.canceled || !folder) return null;
    return importEasyWorshipFolder(folder);
  },
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
