import path from "node:path";
import fs from "node:fs";
import { ASSET_EXTENSIONS } from "@shared/constants";
import { IpcError } from "@shared/ipc/result";
import type { Handlers } from "../register";
import { getMediaRepo, getProgramsRepo } from "../../services/repos";
import { removeMediaAsset } from "../../services/media-asset-removal";
import { importPaths } from "../../services/library-import";
import { broadcast } from "../../services/broadcast";
import { notifyMediaChanged } from "../../media/engine-assets";
import { showOpenDialogFor } from "../open-dialog";
import { mt } from "../../i18n";

/** What a deck's linked soundtrack may be: every audio the picker offers (A11: it offered a `.wma`
 *  and then refused it). What Chromium cannot play goes to the media engine (`slides.repo.ts`). */
const LINKABLE_AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(ASSET_EXTENSIONS.audio);

export const libraryHandlers: Pick<
  Handlers,
  | "library:list"
  | "library:get"
  | "library:add"
  | "library:remove"
  | "library:usages"
  | "library:relocate"
  | "library:setLinkedAudio"
  | "library:listFolder"
> = {
  // A pure read: the "is this file still there?" sweep no longer runs inline
  // on every list — see `services/library-sweeper.ts`. `missingSince` can lag
  // a sweep's debounce/throttle window, which is fine: dragging a truly gone
  // file to GO LIVE is still caught downstream (`SOURCE_MISSING` in
  // `deck-service.ts`, the 410 from `worship-protocol.ts`).
  "library:list": ({ kind }) => getMediaRepo().list(kind),

  "library:get": ({ id }) => getMediaRepo().getById(id),

  "library:add": ({ paths, kind }) => importPaths(paths, kind, { inLibrary: true }),

  "library:remove": ({ id, force }) => {
    removeMediaAsset(id, force ?? false);
  },

  "library:usages": ({ id }) => getProgramsRepo().findUsages(id),

  /**
   * Points an existing row at the file the operator moved, keeping its id —
   * and with it the programs that reference it, its linked audio track and
   * its place in the unsaved order of service. Re-importing the file instead
   * would create a different asset and leave all of that behind.
   *
   * The dialog is filtered to the row's own kind and the choice is checked
   * again afterwards, because a filter is a hint: every platform lets the
   * operator type a name or switch to "All files". Without the check, a `.mp4`
   * chosen for a deck would be stored as a `ppt` row pointing at a video, and
   * the failure would surface much later, as a conversion error in the middle
   * of a service.
   */
  "library:relocate": async ({ id }, ev) => {
    const asset = getMediaRepo().getById(id);
    if (!asset) return null;

    const result = await showOpenDialogFor(ev.sender, {
      properties: ["openFile"],
      filters: [{ name: asset.kind, extensions: [...ASSET_EXTENSIONS[asset.kind]] }],
      defaultPath: path.dirname(asset.path),
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const chosen = result.filePaths[0]!;
    const ext = path.extname(chosen).replace(/^\./, "").toLowerCase();
    if (!ASSET_EXTENSIONS[asset.kind].includes(ext)) {
      throw new IpcError({
        code: "INVALID_ASSET_FILE",
        message: mt("library.relocateKindMismatch"),
      });
    }
    if (!fs.existsSync(chosen)) {
      throw new IpcError({ code: "SOURCE_MISSING", message: mt("library.relocateMissing") });
    }

    const relocated = getMediaRepo().relocate(id, chosen);
    // The grids, the preview and the schedule all read `missingSince`, and
    // none of them asked for this — the operator repaired the file from
    // whichever one happened to be on screen.
    if (relocated) broadcast("library-changed", { kind: asset.kind });
    // Other bytes, so another probe — and maybe a conversion.
    if (relocated) notifyMediaChanged();
    return relocated;
  },

  "library:setLinkedAudio": ({ id, path: audioPath }) => {
    if (audioPath !== null) {
      if (!fs.existsSync(audioPath)) {
        throw new IpcError({ code: "SOURCE_MISSING", message: mt("library.audioMissing") });
      }
      const ext = path.extname(audioPath).replace(/^\./, "").toLowerCase();
      if (!LINKABLE_AUDIO_EXTENSIONS.has(ext)) {
        throw new IpcError({
          code: "INVALID_AUDIO_FILE",
          message: mt("library.audioUnsupported"),
        });
      }
    }
    return getMediaRepo().setLinkedAudio(id, audioPath);
  },

  "library:listFolder": async ({ kind, path: folderPath }) => {
    let entries: fs.Dirent[];
    try {
      // Asynchronous on purpose: a linked folder is routinely a USB stick or
      // an SMB share, where a directory listing can take seconds. Done
      // synchronously it froze the main process — which means it froze the
      // PROJECTION — for as long as the drive took to answer.
      entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
    } catch {
      // Not `[]`: an unplugged USB stick, or one that came back as F: instead
      // of E:, looked exactly like an empty folder, with nothing to say the
      // folder itself was gone.
      throw new IpcError({ code: "FOLDER_MISSING", message: mt("library.folderMissing") });
    }
    const extensions = new Set<string>(ASSET_EXTENSIONS[kind]);
    const matched = entries
      .filter((entry) => entry.isFile() && extensions.has(path.extname(entry.name).slice(1).toLowerCase()))
      .map((entry) => path.join(folderPath, entry.name));
    // Read-only from the caller's point of view: it returns the fresh list
    // directly, so it must never broadcast `library-changed` — see the
    // block comment on `importPaths` for why that would loop.
    return importPaths(matched, kind, { inLibrary: false, emitChanged: false });
  },
};
