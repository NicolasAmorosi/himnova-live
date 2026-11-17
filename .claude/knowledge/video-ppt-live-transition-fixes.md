## Video↔PPT live-transition fixes (projection race + stale-state hang)
**Area:** renderer (stores/hooks/effects) | main (projection-state, deck-service)
**Trigger:** Touching `useMediaAsset`, `usePreviewContent`, `projection-state.ts`,
`ProjectionApp.tsx`, or anything in the go-live path for decks/video.

Two real bugs were found and fixed in the 2026-09-08 session (the maintainer's notes of that session have the
full investigation, including the CDP-driven live-reproduction technique used to pin them down
with certainty instead of guessing).

### 1. First `projection:show` after `projection:open` could be silently dropped

`projection-state.ts` used to replay the last output to a freshly (re)opened projection window
via a **one-shot `webContents.once("did-finish-load", ...)`**. `did-finish-load` reliably fires
*before* the renderer's React bundle finishes executing and mounts its
`onIpc("display-content", ...)` listener — and `goLive()` runs immediately after
`openIfNeeded()` resolves, with no wait for the window to actually be ready. `webContents.send()`
to a renderer with no listener registered yet is a **silent drop, not a queued delivery** — so
the very first content pushed to a newly-opened projector could vanish.

**Fixed by pulling instead of pushing-and-hoping**: added `projection:getSnapshot` (IPC); the
projection window calls it once on mount (`ProjectionApp.tsx`) in addition to still listening
for live pushes, with a `sawPush` guard so a late-resolving snapshot never clobbers a push that
already landed. No timing assumption needed either way.

### 2. Stale `useState` in a hook fed a video's assetId into a PPT conversion → 10-minute queue block

**This was the actual user-reported hang** ("switch from live video to live PPT freezes the
app"). Root cause was **not** a GPU/Electron crash — the
`sysctlbyname for kern.hv_vmm_present failed with status -1` log line the user flagged is
routine benign Chromium noise on Apple Silicon (present on every launch, unrelated).

`useMediaAsset(id)` kept its return value in a `useState` set only inside a `useEffect` — one
render tick behind an `id` change, since React doesn't run effects until after a render
commits. Switching the schedule preview from a live video (assetId 7) to a PPT (assetId 4)
meant `usePreviewContent()` read the **stale video object under the new ppt id** for one render,
producing `{kind:"deck", assetId: 7}`. `useDeck(7)`'s effect fired on that and called
`ensure(7)` for real — main tried to LibreOffice-convert a 2.36 GB **video** file as a
presentation. `convertTimeoutFor` gives a file that size a ~10-minute timeout, and
`deck-service.ts`'s `pump()` processes exactly **one conversion job at a time** — so this bogus
job blocked the real PPT's conversion behind it, which is what read to the operator as
"Converting slides… N of N" stuck forever.

**Fixed** by rewriting `useMediaAsset` (`src/renderer/src/lib/hooks/use-media-asset.ts`) to
always derive its return value **synchronously from the module-level cache during render**,
never from a state variable that can lag a render behind an id change. A `useReducer`
force-rerender only notifies React once an uncached id's fetch populates the cache. This makes
it structurally impossible for the hook to return a different id's data under a new id.

**Generalize:** any hook that derives a value from a changing `id`/key prop and stores it in
`useState` updated only inside `useEffect([id])` has this same one-tick staleness window. Prefer
reading straight from a cache/ref during render and using an effect only to populate that cache
and trigger a rerender, as done here — checked (via grep) that no other hook in
`src/renderer/src/lib/hooks/` has this pattern as of this fix.

**Last updated:** 2026-09-08
