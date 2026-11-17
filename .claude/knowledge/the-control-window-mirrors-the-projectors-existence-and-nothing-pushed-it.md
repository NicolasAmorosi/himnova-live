## `presentationOpen` mirrors a window owned by main, and nothing was pushing it — so the projector could die with the control window never finding out

**Area:** projection / ipc (`src/renderer/src/stores/display.store.ts`, `src/main/ipc/handlers/projection.ts`, `src/shared/ipc/contract.ts`)
**Trigger:** "GO LIVE / BLACK / LOGO stopped doing anything", the on-air dot blinking with nothing
on screen, or before relying on `presentationOpen` for any decision.

Found on 2026-09-13 auditing feature #5. Latent since the projection window existed.

### The claim

`presentationOpen` reads like "is there a projector". It was only ever written by
`display.store.open()`, `openIfNeeded()` and `close()` — i.e. **only when the control window
itself caused the change**. Main knew when the window died (`projectionState.clearWindowIf`, from
`win.on("closed")`) and had no way to say so: `IpcEvents` had no such channel at all.

**The absence of an event is invisible.** Every other failure mode in this app leaves something to
grep for — a handler, a listener, a `catch`. A missing channel leaves nothing, which is why five
sessions of audit over this code never surfaced it.

### Why the window can die without being asked to

`Menu.setApplicationMenu` is never called anywhere in `src/main/` (verify with
`grep -rn "Menu" src/main/`). Electron's default application menu is therefore active, and on
macOS it binds **⌘W to Close Window** — including the focused projection window. A crash of the
projection renderer was believed to produce the same state; it does not (see the correction below).

### What that cost

`openIfNeeded()` short-circuits on the flag (`if (presentationOpen) return`), so once it was stuck
`true`:

- GO LIVE, BLACK and LOGO all stopped reaching any projector **in complete silence** —
  `projection:show` still travelled to main, where `projectionState.getWindow()` returned `null`,
  which is a mute drop;
- `MonitorsColumn`'s `broadcasting = presentationOpen && overlay === "none" && base !== null` kept
  the on-air dot blinking and `useLiveStatus()` returned `""` instead of "disconnected" — the
  monitors lying to the operator, which `CLAUDE.md` forbids outright;
- the only recovery was Settings → Screen → "close" (which closes nothing but resets the flag) →
  "open". Nothing on screen hinted at it.

### The rule

A renderer flag that mirrors a resource owned by main needs a push for **every** way that resource
can disappear, not only the ones the renderer initiates. And that push has to be gated on identity
— `clearWindowIf` now returns whether it actually cleared, and only then is `projection-closed`
broadcast, or a reopen would announce the *old* window's death over the live new one. That is the
same trap as
[`a-replaced-windows-closed-listener-must-check-identity.md`](a-replaced-windows-closed-listener-must-check-identity.md),
reached from a different direction.

This is the mirror image of
[`main-cannot-know-what-is-live-under-an-overlay.md`](main-cannot-know-what-is-live-under-an-overlay.md):
that one is about main not being able to answer a question the control owns; this one is about the
control not being told a fact only main can know. Both boundaries leak silently, and in opposite
directions.

### Correction (2026-11-15): a dead renderer does NOT close its window

Everything above assumed a crash reaches `win.on("closed")` like ⌘W does, and so did the contract of
`projection-closed`, two comments and `startatseconds-is-a-mount-time-seek-…`'s trigger. It never
did. Measured by the 2026-11-15 audit with a real crash (`forcefullyCrashRenderer`, `reason:
crashed`, exit 11) in a sandboxed window: `closed=false isDestroyed=false isCrashed=true`, and
`webContents.send()` to it does not throw. So `projection-closed` never fired, `presentationOpen`
stayed `true`, every GO LIVE went to a dead page without an error, the LIVE monitor went on showing
what it «projected», and EN VIVO could not revive it (`openIfNeeded` short-circuits). The room saw a
black or frozen projector while the engine's sound went on. Only `crash.log` heard of it.

The fix makes the assumption true instead of rewriting the callers: the projector's
`webContents.on("render-process-gone")` (`ipc/handlers/projection.ts`) calls `win.destroy()`, which
takes the tested ⌘W path, with `projection-closed` now carrying `{ reopen }` so the control window
reopens it at once onto what was live. A `loadURL` or `reload()` on the crashed window also revives
it; it was not chosen because the destroy path already folds the positions in
(`freezeLivePositions`) and is covered. The stage window reloads instead (it never sounds), and the
NDI copy already did; all three are capped by `windows/crash-limit.ts` (3 a minute), or a deck that
crashes the renderer on every load reloads in a loop.

**Rule:** a window's renderer can die and leave the `BrowserWindow` alive. Anything that reacts to "the
projector is gone" has to hear about `render-process-gone` too, not only `closed`.

**Last updated:** 2026-11-15
