# 02 — IPC contract

## A single source of truth

The whole contract lives in **`src/shared/ipc/contract.ts`**: an `IpcContract` type with one entry
per channel (`{ req, res }`), grouped by domain prefix (`displays:`, `projection:`,
`files:`, `deck:`, `bible:`, `library:`, `engine:`, `programs:`, `program:`, `window:`,
`utility:`, `overlay:`, `settings:`, `system:`). Push events (main → renderer without invoke)
are kept separately, in `IpcEvents`.

This replaces the old "3-file lockstep" (`main.js` + `preload.js` + `app.js`, all by
hand, with no verification). Now:

1. **`src/main/ipc/handlers/<domain>.ts`** implements a subset of `Handlers`
   (`src/main/ipc/register.ts`), typed as `Pick<Handlers, "channel-a" | "channel-b">`.
2. **`src/main/ipc/index.ts`** assembles all the handlers into a single object typed as the full
   `Handlers` — **if a channel is missing or has the wrong signature, it doesn't compile.**
3. **`src/preload/index.ts`** never changes: it exposes generic `invoke(channel, req)` /
   `on(channel, cb)`. It isn't a security hole — `ipcRenderer.invoke` to a channel without an
   `ipcMain.handle` simply rejects; the real surface is defined by what gets registered in step
   2, not by the preload.
4. **`src/renderer/src/lib/ipc.ts`** has the `invoke<K>`/`onIpc<K>` typed from the
   contract, and **`src/renderer/src/lib/api.ts`** is a per-domain facade
   (`api.bible.search(...)`) — pure readability sugar; its types are inferred from
   `invoke`, they are not a third declaration of the contract.

## How to add a channel

1. Add the line to `IpcContract` in `shared/ipc/contract.ts`.
2. Implement it in the matching domain handler (or create a new one in
   `main/ipc/handlers/`).
3. If it's a new handler, add it to the spread in `main/ipc/index.ts`.
4. (Optional) Add the matching method to the facade in `renderer/src/lib/api.ts`.

The compiler warns you at step 3 if you forgot step 2.

## `Result<T>` — typed errors end to end

Every `ipcMain.handle` registered by `registerHandlers` wraps the response in
`{ok:true,data}` / `{ok:false,error:{code,message}}` (`shared/ipc/result.ts`). `invoke<K>` in the
renderer unwraps this exactly once and rethrows as `IpcError` if `ok:false` — the rest of the
renderer code calls `await api.domain.method(...)` as if it could never fail on the
transport side, and catches business errors with a normal try/catch.

## Push events

`display-content`, `media-command` and `audio-tracks` go from main to the projection window;
`projection-closed`, `displays-changed`, `projector-screen`, `media-status`, `media-error`,
`deck-progress`, `prewarm-progress`, `deck-statuses-changed`, `library-changed`,
`engine-asset-changed`, `deck-updated`, `library-import-progress`, `close-requested` and
`update-status` go to the control window. `window.worship.on(channel, cb)` returns a cleanup function — unlike the legacy
preload, which had no way to unsubscribe. `onIpc` (`renderer/src/lib/ipc.ts`) is its typed
wrapper; the control window subscribes in `renderer/src/effects/` (`*-sync.ts`).

## Legacy → new channel mapping

| Legacy | New | Note |
|---|---|---|
| `get-displays` | `displays:list` | same |
| `open/close-presentation` | `projection:open`/`projection:close` | same |
| `show-content`/`show-black`/`show-logo` | `projection:show` (a single one) | they collapse into `ProjectionOutput` variants |
| `presentation-show/hide`, `ppt-show/hide-overlay` | removed | the overlay dance went away with PowerPoint (2026-09-07): a slide is content sent through `projection:show` |
| `read-file-url` | removed | replaced by `worship://` |
| `load-bible` (the whole 4MB JSON) | `bible:books` + `bible:chapter` + `bible:search` | the full JSON no longer crosses IPC |
| `load/save-media-library` | `library:list`/`library:add`/`library:remove` | incremental writes, not the whole file |
| `import-bible` | `bible:import` | no longer writes inside the app bundle |
