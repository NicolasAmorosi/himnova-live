## A file dropped anywhere but a drop zone navigates the control window out of the app — and neither the CSP nor `webSecurity` stops it

**Area:** main (`windows/navigation-guards.ts`, `index.ts`) | renderer (`lib/drop-guard.ts`,
`main.tsx`, `projection.tsx`)
**Trigger:** Adding a `new BrowserWindow`, adding or moving a drop zone, any report of "the app
disappeared / turned into a video / went white and I had to restart it", or any review of this
app's Electron hardening.

Found in the 2026-09-13 session, closing `C1` of
the internal general audit of 2026-09-13.

### What was believed, and what is true

The app looked hardened: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
`webSecurity: true`, a CSP of `default-src 'self'`, a trusted-sender allowlist on every IPC
channel, and `worship://` handing out capability tokens instead of filesystem paths. The
assumption that follows from that list — that a stray file drop is somebody else's problem — is
wrong on all three counts:

- **The CSP does not govern top-level navigation.** The directive that did, `navigate-to`, was
  removed from the specification and never shipped. `default-src 'self'` governs what the
  document *fetches*, not where the document *goes*.
- **`webSecurity: true` has no opinion either.** Navigating to a dropped file is not a security
  violation; it is an ordinary navigation, and Chromium's default action for a file dropped on
  the document is exactly that.
- **There was no `will-navigate` and no `setWindowOpenHandler` anywhere in `src/main`** —
  verified by grep across the whole directory, for three windows (control, projection, and the
  offscreen rasterizer).

Only two elements in the entire renderer called `preventDefault` on `dragover`/`drop`:
`SchedulePanel.tsx` and `media-browser.tsx`. Everything else — the `TopBar`, the monitors
column, the centre column, the gaps between panels — let the event reach the document. In an
app whose primary gesture is dragging files in from Finder, missing the panel by 30 px is the
ordinary mistake. The cost is the control window ceasing to be an application: React tree gone,
IPC subscriptions gone, the unsaved service order gone with them, and no way back but a restart
— during a service.

### The fix is three layers, and the renderer one is not optional

```ts
// main, once, for every window that will ever exist — src/main/index.ts
app.on("web-contents-created", (_event, contents) => installNavigationGuards(contents));
```

`installNavigationGuards` (`src/main/windows/navigation-guards.ts`) blocks `will-navigate`
unless the target matches the currently loaded page by **origin + pathname** (query and hash
ignored, because the dev server appends them and an HMR reload must still be allowed), denies
`setWindowOpenHandler`, and denies `will-attach-webview`. `loadURL`/`loadFile` are programmatic
and never emit `will-navigate`, so app startup and the projection window's rebuild are
unaffected. Note `new URL("file:///…").origin` is the string `"null"` for every `file://` URL,
so the origin test passes for two unrelated local files and the **pathname** test is what
actually blocks a dropped `file:///Users/…/video.mp4`.

### The non-obvious part: `defaultPrevented` at `document` tells you a drop zone already claimed it

React delegates its events to the **root container** (`#root`), which is a descendant of
`document`. So on the way up, a real drop zone's `onDragOver` runs *before* a listener attached
to `document` — and by then `event.defaultPrevented` is `true`. That makes the document-level
handler able to distinguish "over a drop zone" from "over dead space" with no coordination at
all, and dead space can be given a proper `dropEffect = "none"` cursor instead of lying to the
operator with a copy cursor over a region that will silently ignore the file.

`installDropGuard` (`src/renderer/src/lib/drop-guard.ts`, called from both `main.tsx` and
`projection.tsx`) is scoped to drags whose `dataTransfer.types` include `"Files"`. That scoping
is deliberate: every in-app drag uses a custom MIME type (`MEDIA_ASSET_MIME`, `BIBLE_VERSE_MIME`,
`SCHEDULE_INDEX_MIME`, `PROGRAM_ROW_MIME` in `lib/dnd.ts`), so none of the reorder flows can be
affected by this guard — including the ones rendered through a portal, where React's delegation
target is not `#root` and the `defaultPrevented` reasoning above would not hold.

### What must never be done again

Do not add a `BrowserWindow` and assume the sandbox covers navigation, and do not remove the
document-level drop guard on the grounds that "the drop zones already handle it" — the whole
point is the 95% of the window that is *not* a drop zone.

**Verification note:** the guards were verified by launching the app (renderer loads, no blocked
navigation on startup) and by unit-checking the origin+pathname rule against real dev-server and
packaged URL shapes. Confirming the *original* navigation bug requires physically dragging a
file onto dead space, which is still on the manual checklist of the audit's §9.2.

**Last updated:** 2026-09-13
