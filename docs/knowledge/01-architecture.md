# 01 — Architecture

## What it is

WorshipApp is an Electron 44 app with **TypeScript + React 19 + Vite**, bundled with
`electron-vite` (not vite+tsc wired by hand — see "Why electron-vite" below). Three processes:

- **Main** (`src/main/`) — windows, SQLite DB, IPC, reading decks (and drawing PDF pages on request), the
  media engine, in-app updates.
- **Preload** (`src/preload/index.ts`) — generic `contextBridge` bridge (`invoke`/`on` by
  channel string), ~35 lines that never change when features are added.
- **Control renderer** (`src/renderer/index.html` + `src/renderer/src/`) — the whole UI of the
  operator window: React + Zustand + Tailwind.
- **Projection renderer** (`src/renderer/projection.html` + `src/renderer/src/projection/`) —
  deliberately free of domain logic: a pure function of the last `ProjectionOutput` received.

## Why `electron-vite`

The reference scaffolding (`church-presenter`, archived) used bare Vite + `tsc --watch` +
`concurrently`, and had 3 build-chain bugs that were never fixed: `NODE_ENV` was never set
(dev always fell through to production), the renderer's `outDir` didn't match what main looked
for, and the Vite config was missing `root`. `electron-vite` fixes all three out of the box: it
detects the dev-server URL automatically (`process.env.ELECTRON_RENDERER_URL`), compiles the three
targets with their own `tsconfig`, externalizes `electron` and native modules, and restarts main
in watch mode. Full config in `electron.vite.config.ts` (repo root).

## Dev vs. packaged

`src/main/windows/control-window.ts` and `projection-window.ts` choose `loadURL` (dev, with HMR) vs.
`loadFile` (production) by looking at `app.isPackaged` + `process.env.ELECTRON_RENDERER_URL` — never
`NODE_ENV` by hand. **All** packaging-dependent paths (where the migrations, the Bible resources
and the user DB live) are resolved in a single file, `src/main/paths.ts` — don't repeat
`app.isPackaged ? ... : ...` anywhere else.

## The windows

As in the legacy version (removed from the repo on 2026-10-22; still in git history at
`90d3821`): `createControlWindow()` (1400×900, minimum 1000×700, background `#162231`) and
`createProjectionWindow(displayId?)`, which is **recreated** (not reused) on every
`projection:open` and falls back to 800×600, centered, without `alwaysOnTop` when only one monitor
is connected. The minimize/restore sync between both windows lives in `main/index.ts`
(`wireMinimizeRestoreSync`).

Because the projection window is destroyed and recreated, main keeps the last `ProjectionOutput`
sent (`src/main/services/projection-state.ts`) and replays it on `did-finish-load` — otherwise,
reopening the projection leaves it black even though the control believes it is projecting
something.

**The stage window** (2026-11-05, `main/windows/stage-window.ts`, page `stage.html` →
`StageApp`) is the musicians' screen: what is live, what comes next and the time, on the screen
chosen in Settings ▸ Projection (`stage.displayId`, `null` = none). Unlike the projector it exists
whenever that screen is connected — `syncStageWindow()` decides, called when the control window
opens, when its setting or the projector's changes and when a screen comes or goes — but never on the
projector's screen (`chooseStageDisplay`, owner 2026-11-06): fullscreen and on top it would cover it, and
before the first GO LIVE it would be what the room sees. A choice that becomes the projector's leaves the
stage off (Settings, which no longer lists that screen, reads «Ninguna») until the projector moves; the
operator's own screen takes both, as movable windows. It plays nothing: a video is
its poster (`OutputView`'s `videoStill`), so it has no audio, no media commands and no engine
session. The control window builds its picture (`lib/stage-output.ts`, pushed by
`effects/stage-sync.ts` through `stage:show`); main keeps the last one for a window that opens
later (`stage:getSnapshot`). On the operator's own screen it is a movable 800×450 window, never a
fullscreen one over the control window. Its keys are forwarded to the control window, like the
projector's.

## The NDI® output

Settings ▸ Projection «Salida NDI®» (`ndi.output.*`, off by default; name, 720p/1080p, 30/60) puts the projector's
picture on the network as an NDI source for OBS, vMix or Studio Monitor. **Video only**: the room's audio reaches a
stream from the mixing desk (owner, 2026-11-09). The NDI runtime is **the user's own**, installed for free from
ndi.video and loaded at run time; nothing of NDI ships but the SDK's MIT headers (`native/ndi/include/`). The SDK
licence asks for «NDI®», the trademark line (`NDI_TRADEMARK`, `shared/types/ndi.ts`) near its first use and in «About»,
and a link to ndi.video wherever NDI is used or chosen — the app, the landing and its guide.

- **Its own offscreen window, not a capture of the projector's.** `main/ndi/ndi-output.ts` loads
  `projection.html?role=ndi` at the output's size and registers it as a **mirror** in `projectionState`: it gets
  every `display-content` and `media-command` the projector gets, never the audio tracks, and reports nothing
  (`04-renderer-state.md`). The engine's videos reach it like any other window (`syncLiveEngine()`). It keeps
  working with the projector hidden, but with no projector open the videos pause as they always have, and NDI shows
  that (owner, 2026-11-09). It is created after the control window's `did-finish-load` (Playwright takes the first
  window that loads as the control one) and `userFacingWindows()` skips it.
- **Windows clamps even an offscreen window to the screen** (1920×1032 under a taskbar): `frame: false`,
  `useContentSize` and `setContentSize()` after creating it is what gives the whole picture.
- **Frames travel as shared GPU textures** (`offscreen: { useSharedTexture: true }`, experimental in Electron): main
  hands each painted texture to `media-engine --ndi-send` and only passes a handle, so a slow church PC keeps its
  main thread and an NDI crash takes down nothing else. The engine reads the pixels, queues them (up to 3) and sends
  every one, in order, at a steady rate (BGRX) — the last one again while the page is still — and answers `done`;
  main holds one texture in flight and drops the paints of that moment. Sending only the latest lost 0–27 % of a
  video's frames to the beat between Chromium's clock and the SDK's (see `.claude/knowledge`). How
  a texture crosses (`handles.node` exists on macOS and Linux only):

  | System | How it reaches the engine | How the engine reads it |
  |---|---|---|
  | Windows | its NT handle over stdin; the engine duplicates it out of main (`--parent`) | `OpenSharedResource1` → staging copy → `Map` (retried on another adapter) |
  | macOS | the IOSurface's mach port, to a launchd name the engine checked in (`machSendSurface`) — an IOSurface ID means nothing in another process | `IOSurfaceLock` |
  | Linux | the dmabuf fds over a `SOCK_SEQPACKET` socket (`sendFds`) | `mmap` between `DMA_BUF_IOCTL_SYNC` — an EGL import read zeros |

- **With no receivers, a frame at most every 500 ms**, encoded once: the SDK hands its last frame to every new
  receiver, and OBS reconnects on scene changes. A first receiver, or a paint dropped at the end of a fade, gets a
  fresh frame through `stopPainting(); startPainting()` (`invalidate()` paints no texture; painting left stopped
  freezes the page's clock).
- **Supervised like the media engine:** a crash restarts it after 2 s (`ndi-exit`); exit codes 2–4 (bad arguments,
  no runtime, NDI refused) wait for the user. Settings reads `ndi:getStatus` and listens to `ndi-status`:
  «Enviando · N», «Falta el runtime» with the download link, or the error code.
- **The OS gates the first network use, and only a packaged app shows how.** macOS asks for Local Network in the
  app's name (the engine is a child), with the `NSLocalNetworkUsageDescription` of `mac.extendInfo`; until it is
  answered, or once denied, receivers see the source with no picture and the sender can't tell; switched back on in
  System Settings › Privacy & Security › Local Network, the picture returns with no restart (measured 2026-11-09). A dev run
  from Terminal inherits Terminal's permission. Windows' firewall asks for `media-engine.exe`, named «Lumina Live
  media engine» by its version resource (`native/engine/media-engine.rc`); without «Allow» nobody can connect.
  Settings says each one beside the switch; the installer creates no firewall rule (per-user, no admin).
- **Testing:** `LUMINA_NDI_LIB=<path to libndi>` points at a runtime that isn't installed;
  `tests/e2e/ndi-output.spec.ts` runs with and without one.

Findings behind this:
[`an-offscreen-shared-texture-window-paints-a-texture-only-for-a-real-frame.md`](../../.claude/knowledge/an-offscreen-shared-texture-window-paints-a-texture-only-for-a-real-frame.md),
[`offscreen-textures-cross-to-another-process-differently-on-each-os.md`](../../.claude/knowledge/offscreen-textures-cross-to-another-process-differently-on-each-os.md),
[`the-first-network-use-is-gated-by-the-os-and-dev-runs-hide-it.md`](../../.claude/knowledge/the-first-network-use-is-gated-by-the-os-and-dev-runs-hide-it.md),
[`the-ndi-sdk-hands-its-last-frame-to-every-new-receiver.md`](../../.claude/knowledge/the-ndi-sdk-hands-its-last-frame-to-every-new-receiver.md).

## In-app updates

Main owns them (`src/main/updates/`): the control window asks for the state (`updates:getStatus`)
and listens to `update-status`. Nothing about updating reaches the projector, and the only thing
that starts without the operator asking is one check, 10 s after launch.

- **The feed is the GitHub release marked Latest**, the same one the landing's buttons resolve.
  electron-builder writes `app-update.yml` (`provider: github`) from `repository`; there is no
  `publish` block. `allowPrerelease` is set to `false` on purpose: electron-updater turns it on for
  any `-beta` version, and then the provider looks for a `beta.yml` that no release carries. That's
  why a beta is published as Latest and never as a prerelease.
- **A release has to carry `latest.yml`, `latest-mac.yml` and `latest-linux.yml`**, plus the
  `.blockmap` files for Windows' differential download. The `package:*` scripts write them to
  `release/` and don't publish anything. A release without them gives every install a 404 that only
  reaches `main.log`: nothing breaks, and nobody updates.
- **State.** `UpdateStatus` (`shared/types/updates.ts`) is a discriminated union. `unsupported` is a
  build that can't update itself: `npm run dev`, an AppImage started without `APPIMAGE`, a snap.
  Errors travel as a stable `UpdateErrorCode`, and the renderer words them. A failed launch check
  goes to `main.log` only; whatever the operator asked for says how it failed. The pure half (error
  → code, the installer each platform uses, whether to check at launch) lives in
  `update-status.ts`, which has unit tests.
- **When.** The launch check runs if `updates.autoCheck` is on and `--no-update-check` isn't on the
  command line (the E2E suite passes it). Downloading (~200 MB) waits for «Download», so it never
  competes with a livestream. Installing waits for «Restart and update» or «When the app closes».
  The launch toast (`effects/update-announcement.ts`) shows once per version
  (`updates.announcedVersion`), and its «View» opens Settings ▸ About.

| | Download | «Restart and update» | «When the app closes» |
|---|---|---|---|
| Windows (NSIS) | electron-updater, sha512 | silent install, reopens; UAC if installed for all users | silent install, doesn't reopen |
| macOS (ad-hoc) | `mac-dmg.ts`: `net.fetch`, sha512 against `latest-mac.yml` | opens the `.dmg` and quits; the operator drags it over the app | opens the `.dmg` on the way out |
| Linux AppImage / `.deb` | electron-updater, sha512 | replaces the file / `pkexec dpkg -i`, reopens | the same, on the way out |

- **macOS doesn't go through `MacUpdater`.** Squirrel.Mac rejects every new build of an ad-hoc
  signed app: see
  [`squirrel-mac-rejects-every-update-of-an-ad-hoc-signed-app.md`](../../.claude/knowledge/squirrel-mac-rejects-every-update-of-an-ad-hoc-signed-app.md).
  With a Developer ID, add the `zip` target and use `MacUpdater`; the macOS row becomes the
  Windows one and the interface doesn't change.
- **The question comes before the installer starts, never after.** «Restart and update» asks
  `quitRisks()` (`effects/draft-autosave.ts`), the same answer the close guard gets. Only with the
  OK does `installUpdate("now")` start the installer, and only once it's running does it call
  `releaseForUpdate()` and `app.quit()`. Once started, the Windows installer kills the app within
  ~1.3 s whatever the operator answers: see
  [`the-update-installer-kills-the-app-so-the-question-goes-before-it.md`](../../.claude/knowledge/the-update-installer-kills-the-app-so-the-question-goes-before-it.md).
- **«When the app closes» is not `autoInstallOnAppQuit`**, which stays `false`. With it on, any
  quit after a download would install in silence, and electron-updater only arms it when the
  download finishes anyway: see
  [`electron-updater-arms-install-on-quit-only-when-the-download-finishes.md`](../../.claude/knowledge/electron-updater-arms-install-on-quit-only-when-the-download-finishes.md).
  `updater.ts` registers its own `app.once("quit")` instead. It fires only after the close guard has
  let the quit through, so a «Cancel» installs nothing, and it does its work synchronously.
- **electron-updater is imported by default** (`import electronUpdater from "electron-updater"`).
  The named import passes `typecheck` and kills the app at launch: see
  [`a-named-import-from-a-commonjs-dependency-passes-typecheck-and-dies-at-launch.md`](../../.claude/knowledge/a-named-import-from-a-commonjs-dependency-passes-typecheck-and-dies-at-launch.md).
- **Testing.** `WORSHIP_UPDATE_FEED_URL` swaps the feed for a `generic` one and lets an unpackaged
  build update (`forceDevUpdateConfig`). It's honoured only on loopback (`loopbackFeedUrl`), so it
  can never point a real install at another host. `tests/e2e/updates.spec.ts` serves a fake
  `latest-mac.yml` and `.dmg` through it, and puts a fake `open` first on the app's `PATH`, so the
  macOS install path runs for real. The NSIS, AppImage and `.deb` installs are only tested by hand.

## Window security

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, **`webSecurity: true`** (unlike
common Electron shortcuts, it is not disabled here — see `02-ipc-contract.md` and the `worship://`
protocol for how local files are served without needing it). CSP declared in both HTML files.
