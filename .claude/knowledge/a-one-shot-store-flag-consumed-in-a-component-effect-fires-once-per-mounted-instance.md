## A one-shot flag in a global store, consumed by a `useEffect`, fires once per MOUNTED INSTANCE — and clearing it inside the effect does not help

**Area:** renderer / state (`src/renderer/src/stores/library.store.ts`,
`src/renderer/src/components/pages/resources/media-browser.tsx`,
`src/renderer/src/components/pages/resources/ResourcePanel.tsx`)
**Trigger:** any report of "the toast appears N times", "it saved twice", "it asked me twice"; or
before storing a *one-shot event* (as opposed to durable state) in a Zustand store; or before
changing a component from "one instance at a time" to "kept mounted".

Found on 2026-09-13, diagnosing a field bug: pressing **Remove** on a library asset used by a saved
program raised the same "Can't remove it" toast **four times**.

### The mechanism

`library.store` holds `blockedAssetId: number | null` — not state, an *event*: "this removal was
rejected, tell the operator once". `removeAsset` sets it; the consumer reads it, shows a toast and
calls `dismissBlocked()` to put it back to `null`.

The consumer was a `useEffect` **inside `MediaBrowser`**. That was correct while exactly one
`MediaBrowser` existed at a time. It stopped being correct in commit `2d9417e` (`M43` of the
media-chain audit), which made `ResourcePanel` keep every **visited** tab mounted instead of
unmounting it — for excellent reasons (scroll position, visible range, fetched deck statuses, the
whole `deck:statuses` + prewarm cycle re-running on every tab return). Four asset kinds means up to
four live `MediaBrowser` instances, each subscribed to the same store field.

**`dismissBlocked()` inside the effect saves nothing.** React has already dispatched the same commit
to all four instances; each one's effect closure captured `blockedAssetId === id` before the first
`set()` landed. Four effects run, four toasts are pushed. No instance can guard against the others
because none of them knows the others exist.

Measured against the real app over CDP:

```
5 resource panels mounted (Bible + 4 media kinds) → 4 toasts
2 resource panels mounted (Bible + Videos)        → 1 toast
```

Exactly one per mounted `MediaBrowser`. The "4" is not `MAX_TOASTS` capping something larger — it is
the instance count, and the two numbers being equal is a coincidence that makes this bug look like a
toast-store problem when it is not.

### Why it is worse than a cosmetic repeat

`toast.store`'s `MAX_TOASTS = 4` evicts the **oldest** on overflow. A burst of four therefore
**empties the toast stack**: whatever was on screen — typically `media.loadErrorToast`, "this file
could not be played" — is retired unread. A duplicated notification is not just noise; it is a
notification *deleter*.

### The rule

**A one-shot event stored in a global store must not be consumed by an effect in a component that
can be mounted more than once.** Put it in one of these instead:

- the **action** that produced it (`lib/actions/*`) — it runs once per operator gesture *by
  construction*, whatever the tree looks like. If the toast needs to open a modal, route that flag
  through `stores/ui.store.ts`, which exists for exactly this ("a toast action is a plain function
  with no component tree under it" — that file's own comment, written for `settingsOpen`);
- a module in `effects/`, mounted once from `App.tsx`;
- a component that is structurally single-instance (`App`, `TopBar`, `ResourcePanel`).

Swept the rest of the renderer while here: the other ten `toast.*` call sites all live in actions,
stores, or single-instance components. `blockedAssetId` was the only one.

### The second-order lesson

The regression was introduced by a **correct** fix. "This component is mounted once" is an invisible
assumption that a component never declares and the type system cannot check — and changing a
component's mounting lifetime silently rewrites the semantics of every effect inside it. When a fix
changes *how long* something stays mounted, the effects inside it need re-reading, not just its
render.

Full diagnosis, measurements and the fix options in
the internal field-bug report of 2026-09-13
(`F1`).

**Last updated:** 2026-09-13
