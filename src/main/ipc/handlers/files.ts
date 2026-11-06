import fs from "node:fs";
import type { Handlers } from "../register";
import { ASSET_EXTENSIONS, ASSET_KINDS, type AssetKind } from "@shared/constants";
import { IpcError } from "@shared/ipc/result";
import { systemMediaFolder } from "../../paths";
import { getSettingsRepo } from "../../services/repos";
import { showOpenDialogFor } from "../open-dialog";
import { canDecodeImage } from "../../media/thumbnail-service";
import { mt, type MainMessageKey } from "../../i18n";

const FILTER_NAME_KEYS = {
  all: "filters.all",
  video: "filters.video",
  image: "filters.image",
  audio: "filters.audio",
  ppt: "filters.ppt",
} as const satisfies Record<AssetKind | "all", MainMessageKey>;

function filtersFor(kind: AssetKind | "all") {
  const name = mt(FILTER_NAME_KEYS[kind]);
  if (kind === "all") {
    return [{ name, extensions: ASSET_KINDS.flatMap((k) => [...ASSET_EXTENSIONS[k]]) }];
  }
  return [{ name, extensions: [...ASSET_EXTENSIONS[kind]] }];
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where the file dialog opens for one kind of asset: the operator's override
 * (Settings → System → File folders) or, when there is none, the OS's own folder
 * for that kind.
 *
 * Deliberately NOT the last folder used. A dialog that opens wherever the
 * previous pick happened to end is unpredictable in exactly the moment it
 * matters — the operator adding a hymn deck minutes before a service should
 * land in the same place every time, whatever he opened last.
 *
 * An override that no longer resolves to a directory (an unplugged drive, an
 * unmounted share, a renamed folder) falls back to the system folder rather
 * than being handed to the dialog: `defaultPath` pointing at nothing behaves
 * differently on every platform, from "ignored" to "opens an empty parent".
 */
function defaultFolderFor(kind: AssetKind): string | undefined {
  const override = getSettingsRepo().get("files.defaultFolders")[kind];
  if (override && isDirectory(override)) return override;
  const system = systemMediaFolder(kind);
  return isDirectory(system) ? system : undefined;
}

export const filesHandlers: Pick<
  Handlers,
  "files:pick" | "files:setLogo" | "files:pickFolder" | "files:systemFolders"
> = {
  "files:pick": async ({ kind, multiple, startIn }, ev) => {
    // `"all"` accepts video, image, audio and presentations at once (the
    // order of service's own "+"), so there is no one folder it belongs in:
    // it opens wherever the OS decides rather than anchoring five kinds to
    // whichever one happened to win — unless the caller names one: a Media
    // tab's «Agregar» takes every kind (each file goes to its own tab) but
    // still opens where that tab's files live.
    const folderKind = kind === "all" ? startIn : kind;
    const defaultPath = folderKind ? defaultFolderFor(folderKind) : undefined;
    const result = await showOpenDialogFor(ev.sender, {
      properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
      filters: filtersFor(kind),
      ...(defaultPath ? { defaultPath } : {}),
    });
    if (result.canceled || result.filePaths.length === 0) return [];
    return result.filePaths;
  },

  "files:pickFolder": async ({ defaultPath }, ev) => {
    const result = await showOpenDialogFor(ev.sender, {
      properties: ["openDirectory"],
      ...(defaultPath && isDirectory(defaultPath) ? { defaultPath } : {}),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0]!;
  },

  // Synchronous: `app.getPath` is a memoized OS lookup, and `Handlers` allows
  // a plain value.
  "files:systemFolders": () =>
    Object.fromEntries(ASSET_KINDS.map((kind) => [kind, systemMediaFolder(kind)])) as Record<
      AssetKind,
      string
    >,

  "files:setLogo": async (_req, ev) => {
    // The logo is an image like any other, so it starts where images start.
    const defaultPath = defaultFolderFor("image");
    const result = await showOpenDialogFor(ev.sender, {
      properties: ["openFile"],
      filters: [{ name: mt("filters.image"), extensions: [...ASSET_EXTENSIONS.image] }],
      ...(defaultPath ? { defaultPath } : {}),
    });
    if (result.canceled || result.filePaths.length === 0) return getSettingsRepo().get("logo.path");
    const chosen = result.filePaths[0]!;

    // A logo that cannot be decoded is persisted-then-invisible: LOGO becomes a
    // black projector with no explanation, and the operator only finds out
    // mid-service. Decoded here, in main, with no window involved, so the
    // previous logo survives a bad pick.
    if (!(await canDecodeImage(chosen))) {
      throw new IpcError({ code: "LOGO_UNREADABLE", message: `Cannot decode image: ${chosen}` });
    }

    getSettingsRepo().setMany({ "logo.path": chosen });
    return chosen;
  },
};
