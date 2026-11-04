import type { AssetKind } from "../constants";
import type { DisplayInfo } from "../types/display";
import type {
  DecoderSupport,
  EngineAssetUpdate,
  ImportProgress,
  MediaAsset,
  MediaAssetUsage,
} from "../types/media";
import type {
  BibleBookDTO,
  BibleSearchHit,
  BibleVerseDTO,
  BibleVersionDTO,
  BibleVersionUsage,
} from "../types/bible";
import type {
  AudioTrackPush,
  MediaCommand,
  MediaStatus,
  PreviewEngineVideo,
  PreviewVideoStatus,
  ProjectionMediaError,
  ProjectionOutput,
} from "../types/projection";
import type {
  DeckCacheStats,
  DeckDTO,
  DeckProgress,
  DeckStatusSummary,
  PrewarmProgress,
} from "../types/deck";
import type {
  ProgramDTO,
  ProgramDraft,
  ProgramDuplicateInput,
  ProgramMetaUpsert,
  ProgramSummary,
  ProgramUpsert,
} from "../types/program";
import type { SettingsMap } from "../types/settings";
import type { GpuStatus, InternalsPage, VideoDecoderReport } from "../types/system";
import type { UtilityScene, UtilitySceneUpsert, UtilitySceneUsage } from "../types/utility";
import type { Plate, PlateUpsert, PlateUsage } from "../types/overlay";
import type { Song, SongSearchHit, SongThemeRow, SongUpsert, SongUsage } from "../types/song";
import type { CloseDecision } from "../types/window";
import type { UpdateStatus } from "../types/updates";

/**
 * The single source of truth for every main<->renderer call. Add a channel here
 * and `registerHandlers` (src/main/ipc/register.ts) forces every handler to exist
 * with the right signature — the old "touch 3 files in lockstep" convention is now
 * a compile error instead of a runtime `undefined`.
 */
export type IpcContract = {
  "displays:list": { req: void; res: DisplayInfo[] };

  /** `false` when the window closed before its page mounted: `projection-closed`
   *  has already told the control, which must not then mark the projector open. */
  "projection:open": { req: { displayId: number }; res: boolean };
  "projection:close": { req: void; res: void };
  "projection:show": { req: ProjectionOutput; res: void };
  "projection:mediaCommand": { req: MediaCommand; res: void };
  /** The full set of audio tracks that should exist in the projection window
   *  right now — a deck's soundtrack (if any) plus every standalone audio
   *  asset sent live. Replaces the old single-soundtrack channel: audio going
   *  live no longer means "the one audio", it means "one more track". */
  "projection:setAudioTracks": { req: AudioTrackPush[]; res: void };
  /** Pulled once by the projection window on mount so its first paint can
   *  never race the "display-content"/"audio-tracks" pushes that follow a
   *  fresh `projection:open` — see `docs/knowledge/01-architecture.md`. */
  "projection:getSnapshot": {
    req: void;
    res: { output: ProjectionOutput | null; audioTracks: AudioTrackPush[] };
  };
  /** Projection window -> main -> control window. The projection window is
   *  describing its own <video>/<audio> element, not making a decision. */
  "projection:reportMediaStatus": { req: MediaStatus; res: void };
  /** Same direction and same rule as `reportMediaStatus` — the element is
   *  describing its own failure. The projector itself never paints a notice
   *  (the congregation must not see one); it reports, and the control window
   *  is what tells the operator. */
  "projection:reportMediaError": { req: ProjectionMediaError; res: void };
  /** A canvas for the media engine's frames (`liveEngineFrameKey`,
   *  `previewEngineFrameKey`) just mounted. A paused engine sends no frames, so
   *  main has it draw the current one again — a projector rebuilt onto another
   *  screen, or a monitor remounted, would otherwise stay black until play. */
  "projection:wantVideoFrame": { req: { key: string }; res: void };

  /** The PREVIEW monitor's video when the media engine plays it, or `null`
   *  when it shows anything else. Declarative: main loads a new url, and only
   *  pauses or resumes the same one. */
  "preview:setVideo": { req: PreviewEngineVideo | null; res: void };
  "preview:seekVideo": { req: { seconds: number }; res: void };

  /** `kind: "all"` combines every `AssetKind`'s extensions into one filter, for
   *  a single file dialog that accepts any supported media at once — the
   *  caller then classifies each returned path by its own extension. */
  "files:pick": { req: { kind: AssetKind | "all"; multiple: boolean }; res: string[] };
  "files:setLogo": { req: void; res: string | null };
  /** Opens a native directory picker. `null` means the user canceled.
   *  `defaultPath` is where it opens — the folder being replaced, when there
   *  is one, so "change" starts from what is being changed. */
  "files:pickFolder": { req: { defaultPath?: string | undefined }; res: string | null };
  /** The OS's own folder per asset kind (Music, Videos, Pictures, Documents).
   *  Read-only and platform-resolved in main, so Settings can SHOW the path a
   *  kind falls back to instead of just saying "the system one" — the
   *  operator has to be able to tell whether that is where his files are. */
  "files:systemFolders": { req: void; res: Record<AssetKind, string> };

  /** Cache lookup only — never reads or draws anything, so it is safe to
   *  call while merely rendering a list or selecting an item. */
  "deck:get": { req: { assetId: number }; res: DeckDTO | null };
  /** Reads the deck from its source if needed (a PDF: its page sizes; its
   *  pages are drawn when asked for). Idempotent per assetId: a second call
   *  while one is in flight joins it. */
  "deck:ensure": { req: { assetId: number; force?: boolean }; res: DeckDTO };

  /** Fire-and-forget: reads in the background the decks not read yet — the
   *  order of service, the library tiles on screen. */
  "deck:prewarm": { req: { assetIds: number[] }; res: void };
  /** Starts one tracked, cancelable batch — the "Prepare folder/view"
   *  button. `assetIds` is whatever the caller already has on screen (the
   *  library tab or linked-folder view's current list); already-converted
   *  ones are skipped and counted separately. Progress comes back on
   *  `prewarm-progress`, keyed by the returned `jobId`. */
  "deck:prewarmBatch": { req: { assetIds: number[]; label: string }; res: { jobId: string; total: number } };
  "deck:cancelPrewarmBatch": { req: { jobId: string }; res: void };
  /** One round-trip instead of one `deck:get` per tile — which of these
   *  assets already have a ready deck (so the "Prepare folder" button can
   *  show how many are actually left to convert) and where each ready deck's
   *  first-slide thumbnail lives (so the library grid can draw a PPT tile
   *  without asking for its whole `DeckDTO`). Omits ids with no deck row at
   *  all; check `statuses[id] !== undefined` before assuming "ready". */
  "deck:statuses": { req: { assetIds: number[] }; res: Record<number, DeckStatusSummary> };

  /** How much disk the slide cache is using against its budget. Read-only and
   *  cheap (one aggregate query plus a setting), so Settings can poll it on
   *  open. */
  "deck:cacheStats": { req: void; res: DeckCacheStats };
  /** Deletes EVERY cached deck — rows and extracted files alike — and answers
   *  with the usage that is left. Nothing is spared, including a deck that is
   *  on the projector right now: main deliberately has no way to know what is
   *  live (see `.claude/knowledge/main-cannot-know-what-is-live-under-an-overlay.md`),
   *  so the confirmation belongs to the control window, which does. */
  "deck:clearCache": { req: void; res: DeckCacheStats };

  "bible:versions": { req: void; res: BibleVersionDTO[] };
  "bible:books": { req: { versionId: number }; res: BibleBookDTO[] };
  "bible:chapter": { req: { bookId: number; chapter: number }; res: BibleVerseDTO[] };
  "bible:search": {
    req: { versionId: number; query: string; limit?: number };
    res: BibleSearchHit[];
  };
  "bible:import": { req: void; res: BibleVersionDTO | null };
  /** The name is the only editable field, and it is what the projector prints
   *  when the style asks for the version — see `BibleRepo.renameVersion` for
   *  why `code` is not editable. */
  "bible:rename": { req: { id: number; name: string }; res: BibleVersionDTO };
  /** `force` means exactly "the operator has read which programs lose their
   *  version link and said yes anyway" — never a flag the UI sets on its own.
   *  Unlike a time scene's, this delete cannot fail on an FK (it is `set
   *  null`), so `force` is purely about informed consent. */
  "bible:delete": { req: { id: number; force?: boolean }; res: void };
  "bible:usages": { req: { id: number }; res: BibleVersionUsage[] };
  /** `ids` is the whole list in the order it should appear — the order the
   *  version picker then offers, not just the order Settings shows. Answers
   *  with the re-sorted list, so the caller replaces its state with what was
   *  actually persisted instead of trusting its optimistic guess. */
  "bible:reorder": { req: { ids: number[] }; res: BibleVersionDTO[] };

  "library:list": { req: { kind: AssetKind }; res: MediaAsset[] };
  "library:get": { req: { id: number }; res: MediaAsset | null };
  "library:add": { req: { paths: string[]; kind: AssetKind }; res: MediaAsset[] };
  /** `force: true` bypasses the "in use by a saved program" guard: it also
   *  deletes the referencing `program_items` rows, in the same transaction as
   *  the asset itself. Without it, an asset still in use throws
   *  `MEDIA_ASSET_IN_USE` (see `MediaRepo.remove`). */
  "library:remove": { req: { id: number; force?: boolean }; res: void };
  /** Which saved programs (if any) still reference this asset — used to show
   *  the operator what a forced delete would remove before they confirm it. */
  "library:usages": { req: { id: number }; res: MediaAssetUsage[] };
  "library:relocate": { req: { id: number }; res: MediaAsset | null };
  /** Manual override for a `ppt` asset's linked soundtrack — `path: null`
   *  clears it back to automatic resolution (`linked-audio.ts`). Never
   *  triggers a deck reconversion: the linked audio is served by reference,
   *  not baked into the deck cache. */
  "library:setLinkedAudio": { req: { id: number; path: string | null }; res: MediaAsset | null };
  /** Top-level files of `path` matching `kind`'s extensions, registered the
   *  same way `library:add` does but never marked `inLibrary` — a linked
   *  folder is browsed live, not imported. Throws `FOLDER_MISSING` when the
   *  folder is gone or unreadable (moved, unmounted, a drive letter that
   *  changed), which the panel must not show as an empty folder. */
  "library:listFolder": { req: { kind: AssetKind; path: string }; res: MediaAsset[] };

  /** The library videos and audios the media engine plays, to seed `engine-assets.store`;
   *  `engine-asset-changed` keeps it current from then on. Any other one plays in Chromium. */
  "engine:assets": { req: void; res: number[] };
  /** Whether this machine's Chromium decodes HEVC, which only a renderer can
   *  ask. Nothing is decided before the first report. */
  "engine:reportDecoders": { req: DecoderSupport; res: void };
  /** A file's length as ffprobe read it, for an audio the media engine plays: no `<audio>` in the
   *  control window can open it to ask (`useMediaDuration`). `null` while it has not been probed. */
  "engine:duration": { req: { id: number }; res: number | null };

  "programs:list": { req: void; res: ProgramSummary[] };
  /** ADOPTS the program: main starts attributing `projection_history` to it and
   *  moves the anti-eviction deck pins onto its decks, and the row's
   *  `lastOpenedAt` is bumped. Only the operator actually opening a service
   *  may call this — see `programs:peek` for merely looking at one. */
  "programs:load": { req: { id: number }; res: ProgramDTO };
  /** The same rows, read-only: no `setCurrentProgramId`, no `pinDecks`, no
   *  `lastOpenedAt`. Exists because one click on a row in the programs modal
   *  opens a side panel that lists its items, and doing that through
   *  `programs:load` silently handed the open service's eviction pins and its
   *  history attribution to a program the operator had only glanced at. */
  "programs:peek": { req: { id: number }; res: ProgramDTO };
  "programs:save": { req: ProgramUpsert; res: ProgramSummary };
  "programs:delete": { req: { id: number }; res: void };
  /** "New schedule": the schedule is no longer any saved program, so history
   *  rows must stop being attributed to the last one and its decks stop being
   *  pinned against eviction. Deleting the open program is handled by
   *  `programs:delete` itself — main knows there which id it just removed. */
  "programs:releaseCurrent": { req: void; res: void };
  /** Renames/edits a program's metadata without touching its items or
   *  rewriting their ids — unlike `programs:save`, which always replaces the
   *  full item list. */
  "programs:updateMeta": { req: ProgramMetaUpsert; res: ProgramSummary };
  /** Copies a program's header + items in one transaction on the main side;
   *  never touches the currently loaded program. */
  "programs:duplicate": { req: ProgramDuplicateInput; res: ProgramSummary };
  /** Flips just the favorite flag — deliberately separate from `updateMeta`,
   *  which requires `name` and would clobber `notes` if called partially. */
  "programs:setFavorite": { req: { id: number; favorite: boolean }; res: ProgramSummary };
  /** Applies the operator's manual list order: `ids` is the whole list in the
   *  order it should appear. Returns the re-sorted list so the caller can
   *  replace its state with what actually got persisted instead of trusting
   *  its optimistic guess. */
  "programs:reorder": { req: { ids: number[] }; res: ProgramSummary[] };

  /** Mirrors the unsaved schedule to disk. `null` clears it — sent as soon as
   *  the schedule is saved or emptied, so a stale draft never comes back over
   *  a service the operator already filed. */
  "program:saveDraft": { req: ProgramDraft | null; res: void };
  /** Read once at launch. Already filtered to items whose media assets still
   *  exist (`DraftRepo.load`). */
  "program:loadDraft": { req: void; res: ProgramDraft | null };

  /** The control window's answer to `close-requested`. Main never decides on
   *  its own whether unsaved work may be discarded — `CLAUDE.md`: that
   *  decision belongs to the control window. See `CloseDecision`. */
  "window:closeDecision": { req: { decision: CloseDecision }; res: void };

  /** The saved time scenes, in the operator's manual order. Read once at boot
   *  by `utility.store`, and re-read after every write — the list is small and
   *  main is the only writer, so the store mirrors it rather than patching it. */
  "utility:list": { req: void; res: UtilityScene[] };
  /** `id` is ignored on create and required on update — the two are separate
   *  channels rather than one upsert so main never has to guess which one the
   *  editor meant. Both validate the whole scene (`isUtilitySceneUpsert`)
   *  before writing: `registerHandlers` casts from `unknown`, and a row is
   *  durable. */
  "utility:create": { req: UtilitySceneUpsert; res: UtilityScene };
  "utility:update": { req: UtilitySceneUpsert & { id: number }; res: UtilityScene };
  "utility:duplicate": { req: { id: number; name: string }; res: UtilityScene };
  /** Without `force`, a scene a saved program still uses is refused with
   *  `UTILITY_SCENE_IN_USE` — the FK's job, surfaced as an error code. With
   *  it, the referencing `program_items` go first, in the same transaction.
   *  Exactly `library:remove`'s shape, for exactly its reason: the operator
   *  has to be told what else this breaks before it breaks. */
  "utility:delete": { req: { id: number; force?: boolean }; res: void };
  /** Which saved programs reference a scene, for that confirmation — the FK
   *  violation itself does not name them. Mirrors `library:usages`. */
  "utility:usages": { req: { id: number }; res: UtilitySceneUsage[] };
  /** `ids` is the whole list in the order it should appear. Answers with the
   *  re-sorted list, so the caller replaces its state with what was actually
   *  persisted instead of trusting its optimistic guess. */
  "utility:reorder": { req: { ids: number[] }; res: UtilityScene[] };

  /** The saved overlay plates, in manual order — the same shape as
   *  `utility:*`, validated whole on every write (`isPlateUpsert`). A plate
   *  can be a row of a saved program, so deleting one is refused with
   *  `OVERLAY_PLATE_IN_USE` unless `force`, exactly like a scene. */
  "overlay:list": { req: void; res: Plate[] };
  "overlay:create": { req: PlateUpsert; res: Plate };
  "overlay:update": { req: PlateUpsert & { id: number }; res: Plate };
  "overlay:duplicate": { req: { id: number; name: string }; res: Plate };
  "overlay:delete": { req: { id: number; force?: boolean }; res: void };
  "overlay:usages": { req: { id: number }; res: PlateUsage[] };
  "overlay:reorder": { req: { ids: number[] }; res: Plate[] };

  /** The whole song library, read at boot and after every write — the
   *  renderer previews and projects from it without a round trip. Every
   *  write is validated whole (`isSongUpsert`). Deleting a song a saved
   *  program uses is refused with `SONG_IN_USE` unless `force`, like a plate. */
  "song:list": { req: void; res: Song[] };
  "song:create": { req: SongUpsert; res: Song };
  "song:update": { req: SongUpsert & { id: number }; res: Song };
  "song:duplicate": { req: { id: number; title: string }; res: Song };
  "song:delete": { req: { id: number; force?: boolean }; res: void };
  "song:usages": { req: { id: number }; res: SongUsage[] };
  /** Title, number, authors and lyrics, without accents (FTS5), best first. */
  "song:search": { req: { query: string; limit?: number }; res: SongSearchHit[] };
  "songTheme:list": { req: void; res: SongThemeRow[] };

  "settings:get": { req: void; res: SettingsMap };
  "settings:set": { req: Partial<SettingsMap>; res: void };

  "system:gpuStatus": { req: void; res: GpuStatus };
  /** Opens the folder holding `main.log` and `crash.log` in the OS's file
   *  manager — what an operator sends along when something failed. */
  "system:openLogsFolder": { req: void; res: void };
  /** Opens `chrome://<page>` in its own window, child of the caller's. */
  "system:openInternals": { req: { page: InternalsPage }; res: void };
  /** Starts listening to the caller's media pipeline (CDP `Media` domain).
   *  `false` when it can't — the probe then reports frames only. */
  "system:probeBegin": { req: void; res: boolean };
  /** Stops listening and answers for the player that loaded `src`, or `null`
   *  when none reported anything. */
  "system:probeEnd": { req: { src: string }; res: VideoDecoderReport | null };

  "updates:getStatus": { req: void; res: UpdateStatus };
  /** The operator pressed «Check now»: unlike the launch check, its failure
   *  is shown. */
  "updates:check": { req: void; res: void };
  "updates:download": { req: void; res: void };
  /** `"now"` quits and installs. The control window asks first (on air,
   *  unsaved changes) and only then calls this: once the installer is running
   *  there is no «Cancel» left — it kills the app within seconds. */
  "updates:install": { req: { when: "now" | "onQuit" }; res: void };
  /** Opens the available version's release page in the system browser. The
   *  URL is main's. */
  "updates:openReleaseNotes": { req: void; res: void };
};

export type IpcChannel = keyof IpcContract;
export type Req<K extends IpcChannel> = IpcContract[K]["req"];
export type Res<K extends IpcChannel> = IpcContract[K]["res"];

/** Push events: main -> renderer, never invoked by the renderer. */
export type IpcEvents = {
  /** -> projection window */
  "display-content": ProjectionOutput;
  "media-command": MediaCommand;
  "audio-tracks": AudioTrackPush[];
  /** -> control window */
  /** The projection window is gone and the control window did not ask for it:
   *  the OS closed it (the default Electron menu binds Cmd+W and nothing calls
   *  `Menu.setApplicationMenu`), the projection renderer crashed, or it was
   *  force-closed. Without this the control keeps `presentationOpen: true`
   *  forever, and that flag is what `openIfNeeded()` short-circuits on — so GO
   *  LIVE, BLACK and LOGO would all stop reaching any projector in complete
   *  silence while the LIVE header kept claiming to be on air. */
  "projection-closed": void;
  /** A screen was connected or disconnected (`windows/projector-screen.ts`):
   *  the control window re-reads `displays:list`. Main itself moves the
   *  projection window. */
  "displays-changed": void;
  /** The projection window's screen went away (it is hidden, still playing)
   *  or came back (it is fullscreen on it again). */
  "projector-screen": { connected: boolean };
  "media-status": MediaStatus;
  "media-error": ProjectionMediaError;
  /** The PREVIEW monitor's engine (`preview:setVideo`), ~4/s. */
  "preview-video-status": PreviewVideoStatus;
  "preview-video-error": { url: string };
  "deck-progress": DeckProgress;
  "prewarm-progress": PrewarmProgress;
  /** What `deck:statuses` would answer changed for reasons that are not a
   *  conversion finishing — today, the startup content-hash backfill teaching
   *  main which already-cached deck an asset's bytes belong to. The library
   *  is untouched, so this is deliberately NOT `library-changed`: the grid
   *  must re-ask for statuses without re-listing files. */
  "deck-statuses-changed": { kind: AssetKind };
  "library-changed": { kind: AssetKind };
  /** A library asset started or stopped being played by the media engine. */
  "engine-asset-changed": EngineAssetUpdate;
  /** A deck's embedded clip turned out playable, by Chromium or by the media
   *  engine (`media/deck-clips.ts`): the deck's DTO now lists a video or
   *  soundtrack it did not before, so a renderer holding it must read it again. */
  "deck-updated": { deckId: number };
  /** Only fired for a batch large enough to need a progress bar
   *  (`library-import.ts`'s `PROGRESS_THRESHOLD`), throttled to a few per
   *  second — never one event per file. */
  "library-import-progress": ImportProgress;
  /** A key pressed while the PROJECTION window had the keyboard — macOS focuses
   *  it when it opens, and a click on its screen does on any system. Forwarded
   *  by `windows/projection-window.ts` so the shortcuts answer from either
   *  window; only keys without Ctrl/⌘/Alt, so the menu's own still work there. */
  "projector-key": { key: string; repeat: boolean };
  /** The operator asked to close the control window and the schedule has
   *  unsaved changes. Main has already vetoed the close and is asking the
   *  control window what to do; the answer comes back as
   *  `window:closeDecision`, or never, in which case main closes anyway after
   *  a short grace — a wedged renderer must not make the app unquittable. */
  "close-requested": void;
  /** Every change of `updates:getStatus`; download progress at most 4/s. */
  "update-status": UpdateStatus;
};

export type IpcEventName = keyof IpcEvents;
