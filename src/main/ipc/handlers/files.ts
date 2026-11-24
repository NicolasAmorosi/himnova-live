import fs from "node:fs";
import path from "node:path";
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

/** Folders being asked about, so a second «Agregar» waits on the same question. */
const asking = new Map<string, Promise<boolean>>();

/**
 * Whether `candidate` is a folder, asked off main's thread and answered `false` after a second. A folder on a share
 * that does not answer (a NAS turned off) held a synchronous stat 21 s on Windows (2.7 s for a name that does not
 * resolve; measured 2026-11-16), with main and so the projector's files frozen (2026-11-15 audit, A26). One question
 * per folder at a time: each one hung holds a thread of the pool the app's own file reads share.
 */
function isDirectory(candidate: string): Promise<boolean> {
  let answer = asking.get(candidate);
  if (!answer) {
    answer = fs.promises
      .stat(candidate)
      .then((stat) => stat.isDirectory(), () => false)
      .finally(() => asking.delete(candidate));
    asking.set(candidate, answer);
  }
  return Promise.race([answer, new Promise<boolean>((resolve) => setTimeout(resolve, 1000, false))]);
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
async function defaultFolderFor(kind: AssetKind): Promise<string | undefined> {
  const override = getSettingsRepo().get("files.defaultFolders")[kind];
  if (override && (await isDirectory(override))) return override;
  const system = systemMediaFolder(kind);
  return (await isDirectory(system)) ? system : undefined;
}

export const filesHandlers: Pick<
  Handlers,
  "files:pick" | "files:setLogo" | "files:pickFolder" | "files:systemFolders"
> = {
  "files:pick": async ({ kind, multiple, startIn }, ev) => {
    // `"all"` accepts video, image, audio and presentations at once, so there
    // is no one kind's folder it belongs in. The order of service's own "+"
    // (no `startIn`) is the one exception to `defaultFolderFor`'s rule: it
    // opens where it last added from (`files.scheduleFolder`, owner,
    // 2026-11-24), because a service's files live in one folder the operator
    // goes back to every week; until then, or once that folder is gone, the
    // OS decides. A Media tab's «Agregar» also takes every kind but still
    // opens where that tab's files live.
    const forSchedule = kind === "all" && !startIn;
    const folderKind = kind === "all" ? startIn : kind;
    const last = forSchedule ? getSettingsRepo().get("files.scheduleFolder") : null;
    const defaultPath =
      last && (await isDirectory(last)) ? last : folderKind ? await defaultFolderFor(folderKind) : undefined;
    const result = await showOpenDialogFor(ev.sender, {
      properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
      filters: filtersFor(kind),
      ...(defaultPath ? { defaultPath } : {}),
    });
    if (result.canceled || result.filePaths.length === 0) return [];
    if (forSchedule) getSettingsRepo().setMany({ "files.scheduleFolder": path.dirname(result.filePaths[0]!) });
    return result.filePaths;
  },

  "files:pickFolder": async ({ defaultPath }, ev) => {
    const result = await showOpenDialogFor(ev.sender, {
      properties: ["openDirectory"],
      ...(defaultPath && (await isDirectory(defaultPath)) ? { defaultPath } : {}),
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
    const defaultPath = await defaultFolderFor("image");
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
