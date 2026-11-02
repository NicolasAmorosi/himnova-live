import { invoke } from "./ipc";
import type { AssetKind } from "@shared/constants";
import type { InternalsPage } from "@shared/types/system";
import type {
  AudioTrackPush,
  MediaCommand,
  PreviewEngineVideo,
  ProjectionMediaError,
  ProjectionOutput,
} from "@shared/types/projection";
import type {
  ProgramDraft,
  ProgramDuplicateInput,
  ProgramMetaUpsert,
  ProgramUpsert,
} from "@shared/types/program";
import type { SettingsMap } from "@shared/types/settings";
import type { UtilitySceneUpsert } from "@shared/types/utility";
import type { PlateUpsert } from "@shared/types/overlay";
import type { CloseDecision } from "@shared/types/window";
import type { DecoderSupport } from "@shared/types/media";

/** Thin per-domain facade over `invoke` — pure readability sugar in the
 *  renderer, not a second definition of the contract: every method's types
 *  are inferred straight from `IpcContract`. */
export const api = {
  displays: {
    list: () => invoke("displays:list", undefined),
  },
  projection: {
    open: (displayId: number) => invoke("projection:open", { displayId }),
    close: () => invoke("projection:close", undefined),
    show: (output: ProjectionOutput) => invoke("projection:show", output),
    mediaCommand: (command: MediaCommand) => invoke("projection:mediaCommand", command),
    setAudioTracks: (tracks: AudioTrackPush[]) => invoke("projection:setAudioTracks", tracks),
    getSnapshot: () => invoke("projection:getSnapshot", undefined),
    reportMediaError: (error: ProjectionMediaError) => invoke("projection:reportMediaError", error),
    wantVideoFrame: (key: string) => invoke("projection:wantVideoFrame", { key }),
  },
  preview: {
    setVideo: (video: PreviewEngineVideo | null) => invoke("preview:setVideo", video),
    seekVideo: (seconds: number) => invoke("preview:seekVideo", { seconds }),
  },
  files: {
    pick: (kind: AssetKind | "all", multiple: boolean) => invoke("files:pick", { kind, multiple }),
    setLogo: () => invoke("files:setLogo", undefined),
    pickFolder: (defaultPath?: string) => invoke("files:pickFolder", { defaultPath }),
    systemFolders: () => invoke("files:systemFolders", undefined),
  },
  deck: {
    get: (assetId: number) => invoke("deck:get", { assetId }),
    ensure: (assetId: number, force?: boolean) =>
      invoke("deck:ensure", { assetId, ...(force !== undefined ? { force } : {}) }),
    cancel: (assetId: number) => invoke("deck:cancel", { assetId }),
    environment: (force = false) => invoke("deck:environment", { force }),
    locateSoffice: () => invoke("deck:locateSoffice", undefined),
    openSofficeDownload: () => invoke("deck:openSofficeDownload", undefined),
    prewarm: (assetIds: number[], scope: "program" | "explicit" | "visible") =>
      invoke("deck:prewarm", { assetIds, scope }),
    prewarmBatch: (assetIds: number[], label: string) => invoke("deck:prewarmBatch", { assetIds, label }),
    cancelPrewarmBatch: (jobId: string) => invoke("deck:cancelPrewarmBatch", { jobId }),
    statuses: (assetIds: number[]) => invoke("deck:statuses", { assetIds }),
    cacheStats: () => invoke("deck:cacheStats", undefined),
    clearCache: () => invoke("deck:clearCache", undefined),
  },
  bible: {
    versions: () => invoke("bible:versions", undefined),
    books: (versionId: number) => invoke("bible:books", { versionId }),
    chapter: (bookId: number, chapter: number) => invoke("bible:chapter", { bookId, chapter }),
    search: (versionId: number, query: string, limit?: number) =>
      invoke("bible:search", { versionId, query, ...(limit !== undefined ? { limit } : {}) }),
    import: () => invoke("bible:import", undefined),
    rename: (id: number, name: string) => invoke("bible:rename", { id, name }),
    delete: (id: number, force?: boolean) =>
      invoke("bible:delete", { id, ...(force !== undefined ? { force } : {}) }),
    usages: (id: number) => invoke("bible:usages", { id }),
    reorder: (ids: number[]) => invoke("bible:reorder", { ids }),
  },
  engine: {
    assets: () => invoke("engine:assets", undefined),
    reportDecoders: (support: DecoderSupport) => invoke("engine:reportDecoders", support),
    duration: (id: number) => invoke("engine:duration", { id }),
  },
  library: {
    list: (kind: AssetKind) => invoke("library:list", { kind }),
    get: (id: number) => invoke("library:get", { id }),
    add: (paths: string[], kind: AssetKind) => invoke("library:add", { paths, kind }),
    remove: (id: number, force?: boolean) =>
      invoke("library:remove", { id, ...(force !== undefined ? { force } : {}) }),
    usages: (id: number) => invoke("library:usages", { id }),
    relocate: (id: number) => invoke("library:relocate", { id }),
    setLinkedAudio: (id: number, path: string | null) =>
      invoke("library:setLinkedAudio", { id, path }),
    listFolder: (kind: AssetKind, path: string) => invoke("library:listFolder", { kind, path }),
  },
  programs: {
    list: () => invoke("programs:list", undefined),
    load: (id: number) => invoke("programs:load", { id }),
    /** Read-only: use this anywhere the operator is looking at a program
     *  rather than opening one. `load` adopts it in main. */
    peek: (id: number) => invoke("programs:peek", { id }),
    save: (input: ProgramUpsert) => invoke("programs:save", input),
    delete: (id: number) => invoke("programs:delete", { id }),
    releaseCurrent: () => invoke("programs:releaseCurrent", undefined),
    updateMeta: (input: ProgramMetaUpsert) => invoke("programs:updateMeta", input),
    duplicate: (input: ProgramDuplicateInput) => invoke("programs:duplicate", input),
    setFavorite: (input: { id: number; favorite: boolean }) => invoke("programs:setFavorite", input),
    reorder: (ids: number[]) => invoke("programs:reorder", { ids }),
  },
  /** The unsaved schedule, mirrored to disk — see `effects/draft-autosave.ts`. */
  draft: {
    save: (draft: ProgramDraft | null) => invoke("program:saveDraft", draft),
    load: () => invoke("program:loadDraft", undefined),
  },
  window: {
    /** Answers main's `close-requested` — see `CloseDecision`. */
    closeDecision: (decision: CloseDecision) => invoke("window:closeDecision", { decision }),
  },
  /** Saved time scenes — the countdowns, the clock and the stopwatch of
   *  Functions ▸ Timers. `remove` rather than `delete` for the same reason
   *  `library` uses it: a reserved word reads badly as a method. */
  utility: {
    list: () => invoke("utility:list", undefined),
    create: (input: UtilitySceneUpsert) => invoke("utility:create", input),
    update: (input: UtilitySceneUpsert & { id: number }) => invoke("utility:update", input),
    duplicate: (id: number, name: string) => invoke("utility:duplicate", { id, name }),
    remove: (id: number, force = false) => invoke("utility:delete", { id, force }),
    usages: (id: number) => invoke("utility:usages", { id }),
    reorder: (ids: number[]) => invoke("utility:reorder", { ids }),
  },
  overlays: {
    list: () => invoke("overlay:list", undefined),
    create: (input: PlateUpsert) => invoke("overlay:create", input),
    update: (input: PlateUpsert & { id: number }) => invoke("overlay:update", input),
    duplicate: (id: number, name: string) => invoke("overlay:duplicate", { id, name }),
    remove: (id: number, force = false) => invoke("overlay:delete", { id, force }),
    usages: (id: number) => invoke("overlay:usages", { id }),
    reorder: (ids: number[]) => invoke("overlay:reorder", { ids }),
  },
  settings: {
    get: () => invoke("settings:get", undefined),
    set: (partial: Partial<SettingsMap>) => invoke("settings:set", partial),
  },
  system: {
    gpuStatus: () => invoke("system:gpuStatus", undefined),
    openInternals: (page: InternalsPage) => invoke("system:openInternals", { page }),
    probeBegin: () => invoke("system:probeBegin", undefined),
    probeEnd: (src: string) => invoke("system:probeEnd", { src }),
    openLogsFolder: () => invoke("system:openLogsFolder", undefined),
  },
  updates: {
    getStatus: () => invoke("updates:getStatus", undefined),
    check: () => invoke("updates:check", undefined),
    download: () => invoke("updates:download", undefined),
    install: (when: "now" | "onQuit") => invoke("updates:install", { when }),
    openReleaseNotes: () => invoke("updates:openReleaseNotes", undefined),
  },
};
