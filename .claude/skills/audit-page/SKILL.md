---
name: audit-page
description: Full end-to-end auditor for one WorshipApp feature (IPC contract → main handlers → React/Zustand renderer → design-system usage). Checks correctness, unhandled states (loading/empty/error), projection-output coverage, slide-deck and BLACK/LOGO overlay correctness, and style/token uniformity. Writes a severity-rated report to the maintainer workspace (../docs/auditorias/reports/) and updates the status index. Report-only — never fixes unless asked. Use when asked to audit, review in depth, or QA a complete feature (playlist, library, bible, ppt, black/logo controls, programs).
user-invocable: true
tools: Read, Write, Edit, Bash, Glob, Grep
---

# /audit-page — Full-stack Feature Auditor (WorshipApp)

You audit **one feature end-to-end** across all WorshipApp layers and produce a single,
severity-rated report under `../docs/auditorias/reports/`, then update the status table in
`../docs/auditorias/README.md`. `npm run typecheck` already catches missing/mis-typed IPC handlers and
non-exhaustive `selectOutput` switches — don't re-derive what the compiler already guarantees.
Reports are maintainer notes and are not published: `../docs/auditorias/` is the maintainer
workspace next to this repo. If it does not exist, write under `.scratch/auditorias/` (gitignored).
Focus your manual tracing on what TypeScript can't see: runtime behavior, error handling, UX
states, slides pipeline safety, and design-system consistency. Run `npm run typecheck && npm run lint`
first and fold any failures into the report as Critical findings.

Arguments: `$ARGUMENTS` — the feature to audit (`playlist`, `library`, `bible`, `ppt`,
`black-logo`, `display`). If empty, ask which feature to audit before proceeding.

**You report findings; do not fix anything** unless the user explicitly asks after reading the
report. The deliverable is the report + the updated index.

---

## Phase 0 — Read project knowledge first

1. Read `CLAUDE.md` and the relevant `docs/knowledge/` entries for the target feature:
   `01-architecture.md` (windows/processes), `02-ipc-contract.md` (channels), `03-slides.md`
   (if the feature touches PPT), `04-renderer-state.md` (state/flags), `05-data-and-persistence.md`
   (if it touches settings/library/bible data), `06-ui-and-theme.md` (styling).
2. Scan `.claude/knowledge/INDEX.md` for prior findings on this feature — don't re-report a known
   issue as new; instead confirm it's still present and reference the existing entry.
3. Re-read the non-negotiable rules in `CLAUDE.md`: the typed IPC contract, `contextIsolation:
   true`/`nodeIntegration: false`/`sandbox: true`/`webSecurity: true`, `selectOutput` as the single
   arbiter of what's projected, no hardcoded design-system values outside `components/ui`. These
   are what you audit compliance against.

---

## Phase 1 — Map the feature surface

Locate every file that belongs to the feature:

| Layer | Where to look |
|-------|----------------|
| IPC contract | `src/shared/ipc/contract.ts` — the channels this feature owns |
| IPC handlers | `src/main/ipc/handlers/<domain>.ts` |
| Data layer | `src/main/db/repositories/<domain>.repo.ts` if the feature persists anything |
| Renderer state | `src/renderer/src/stores/<domain>.store.ts` |
| Renderer UI | `src/renderer/src/components/pages/<feature>/` |
| Shared primitives used | cross-check against `src/renderer/src/components/ui/index.ts` |
| Projection rendering | `src/renderer/src/projection/ProjectionApp.tsx` if the feature pushes content to the projection window |

Build a **surface inventory** (every file + function/handler found). List every IPC channel this
feature owns and confirm each has a handler in `main/ipc/index.ts`'s assembled `Handlers` object
— `npm run typecheck` already proves this is complete, so just note the channel list, don't
re-verify by hand.

---

## Phase 2 — Backend audit (main/ipc/handlers, db/repositories)

For every handler this feature owns:

- **Error handling.** Does a failure (missing file, a deck no reader opens, a PDF that won't
  rasterize, malformed OOXML, a FK constraint from `program_items.media_asset_id` restrict) surface as a clear
  `IpcError` the renderer can show, or does it throw something opaque? Empty `catch {}` blocks are
  only acceptable for genuinely best-effort operations — flag any that hide a failure the user
  should see.
- **Slides pipeline safety.** A deck is read on the worker thread, never on main; a part is read
  through `readZipEntries`, never the whole file; any process spawned (FFmpeg, the media engine)
  gets an argument array, never a shell string; and any path is resolved through
  `src/main/paths.ts`, never built by concatenation (see `docs/knowledge/03-slides.md`).
- **Range support.** If the handler or protocol path serves media, confirm `serveFile()` still
  honors `Range` (206 + `Accept-Ranges`) — see
  `.claude/knowledge/worship-protocol-range-and-video-lifecycle.md`.
- **Window lifecycle.** If the handler touches the projection window, confirm it goes through
  `projectionState` (`src/main/services/projection-state.ts`) rather than a raw `BrowserWindow`
  reference that could be stale/destroyed.
- **Persistence correctness.** If the handler touches `media_assets`, confirm it never treats a
  missing file as a reason to delete the row (see `05-data-and-persistence.md` on
  `missing_since`). If it touches `program_items`, confirm the `CHECK` constraint's shape
  (exactly one of `media_asset_id`/`bible_text`/`utility_scene_id`/`overlay_plate_id` populated
  per kind) is respected.

## Phase 3 — Renderer audit (stores, components/pages)

- **Store consistency.** Does every store action that changes one field also update every other
  field that should move with it (e.g. `program.store.ts`'s `selectedIndex` after `removeAt`)? A
  stale field here is the most common bug class.
- **`selectOutput` coverage.** If this feature introduces a new `BaseContent`/`ProjectionOutput`
  variant, `npm run typecheck` already forces a branch in `selectOutput`
  (`stores/projection.store.ts`) — confirm the branch's *behavior* is correct, not just present.
- **Design-system compliance.** Every color/shadow/radius in the feature's `components/pages/**`
  files must come from a `components/ui` primitive or a semantic token (`bg-primary`,
  `shadow-surface`, …) — `grep -n "bg-\[#\|#[0-9a-fA-F]\{3,6\}\"" <feature-dir>` should return
  nothing. Flag any raw hex/rgb.
- **Orphaned IPC calls.** Every method on `src/renderer/src/lib/api.ts`'s domain object this
  feature could plausibly need should have a caller somewhere in `components/pages/<feature>/`.
- **Event wiring.** Every interactive element renders through a `components/ui` primitive
  (`Button`, `IconButton`, …) with its handler actually wired — not a raw `<div onClick>` bypass.

## Phase 4 — State coverage (loading / empty / error)

For each user-facing action in the feature, confirm:
- **Loading:** slow operations (PPT export, PPT open, file dialogs) show *some* feedback
  (`LoadingState`, `LinearLoader` or a progress row, disabled button, etc.) rather than a frozen
  UI with no indication anything is happening.
- **Empty:** lists (playlist, library, bible search results) render an explicit empty state
  (the `EmptyState` primitive, the «No files»/«No results» messages) rather than a
  blank area.
- **Error:** a failed PPT open/export, a missing file, or a malformed Bible import degrades to a
  visible message, not a silently broken feature.

## Phase 5 — Style & UI consistency

- No hardcoded colors/shadows/radii that duplicate an existing semantic token from
  `src/renderer/src/styles/globals.css` — flag any value that should reuse `bg-primary`,
  `shadow-surface`, `rounded-lg`, etc. (see the token table in `CLAUDE.md`).
- New buttons/panels/inputs reuse an existing `components/ui` primitive instead of ad-hoc markup
  — if a genuinely new primitive is needed, confirm it was added to `components/ui/` (not
  inlined in the feature) and exported from `components/ui/index.ts`.
- All UI copy goes through `useT()` against `lib/i18n/messages/es.ts` — flag any hardcoded
  string in a `.tsx` file, and any key added to `es.ts` without its `en`/`it`/`pt` counterpart.
  Copy in all four locales (`es` is the reference) is consistent in tone/casing with the rest of
  the UI (e.g. `EN VIVO`/`LIVE`, `NEGRO`/`BLACK`, `LOGO` are all-caps action verbs; labels are
  sentence case).
- Both themes render correctly — spot-check the feature with `data-theme="light"` and
  `data-theme="dark"` on `<html>` (devtools), since a semantic-token violation often only shows
  in one theme.

---

## Phase 6 — Cross-cutting

- **A deck that won't open.** If the feature touches presentations, confirm a file no reader opens
  (password, PowerPoint 95, not a presentation) fails with its code and a reason that says what the
  operator can do — never an uncaught exception, never a message about installing something — per
  «A deck that won't open» in `docs/knowledge/03-slides.md`.
- **Dead/duplicate code.** Any handler, method, or render function this feature made redundant.

---

## Phase 7 — Manual verification checklist

The Playwright E2E suite (`tests/e2e/`, `npm run test:e2e`) drives the built app through
`_electron`: note which of the feature's paths its specs already cover. For the rest, hand the user
(or run yourself with `npm run dev` if the platform allows it) a concrete manual checklist for the
audited feature — concrete steps, not generic advice. Example shape for the `bible` feature:

1. Open the app, go to the Bible tab, pick a version — confirm the book dropdown shows real
   names.
2. Search a chapter with 1 verse and one with 30+ — confirm both render without layout breakage.
3. Double-click a verse with the projection window closed — confirm it auto-opens the screen.
4. Toggle BLACK then LOGO then click Stop — confirm the live preview panel matches what the
   projection window actually shows at each step.

Mark this phase **"Not run"** in the report if you didn't actually execute it, with why (e.g. "needs
a second screen; audited with one").

---

## Phase 8 — Write the report + update the index

1. Get today's date: `date +%F`.
2. Write a single markdown file to **`../docs/auditorias/reports/AUDIT-<feature>-<YYYY-MM-DD>.md`** using
   the structure below. Every finding gets a **severity**, a **`file:line`** anchor, and a
   concrete **recommendation**.
3. **Update the row** for this feature in `../docs/auditorias/README.md`: set Estado (🔵 en progreso /
   🟡 hallazgos abiertos / 🟢 limpia), the Hallazgos counts, the date, and a relative link to the
   report. Refresh the "última actualización" footer line.
4. If you found something durable enough to matter next session (a real bug, a gotcha), also add
   or update an entry in `.claude/knowledge/` per the format in `CLAUDE.md` — don't duplicate
   what the report already covers verbatim, capture the *lesson*, not the finding itself.

```markdown
# Audit — <Feature> (<YYYY-MM-DD>)

## Summary
- Scope: <files/functions/IPC channels audited>
- Verdict: <one line>
- Findings: 🔴 <n> Critical · 🟠 <n> High · 🟡 <n> Medium · 🔵 <n> Low · ⚪ <n> Info
- Manual verification: <done / not run — why>

## Surface inventory
<files grouped by layer>

## Findings

### 🔴 Critical
#### [MAIN/PRELOAD/RENDERER/UI] <short title>
- **Where:** `path/to/file.js:42`
- **Issue:** <what's wrong / which case fails>
- **Impact:** <crash, silent data loss, broken projection state, …>
- **Fix:** <concrete, minimal change>

### 🟠 High
…
### 🟡 Medium
…
### 🔵 Low
…
### ⚪ Info / Nice-to-have
…

## Coverage matrix
| Case | Main | Renderer |
|------|------|----------|
| Contract ↔ `Handlers` parity (`npm run typecheck`) | … | n/a |
| Orphaned `window.worship.*` calls | n/a | … |
| `selectOutput` exhaustiveness for this content type | n/a | … |
| Two-stage flow honored (select ≠ project; only `goLive()`) | n/a | … |
| BLACK/LOGO over a live video (pause + resume; deck audio pauses too, standalone audio keeps playing) | … | … |
| Loading / empty / error states | … | … |
| `worship://` `Range` / 206 support | … | n/a |
| A deck that won't open → its reason, nothing to install | … | … |
| Semantic tokens only (no hardcoded color/shadow/radius) | n/a | … |

## Not verified / assumptions
<anything you couldn't check and why — needs a real projector / second display, a deck too large
to convert here, etc.>
```

Severity rubric:
- 🔴 **Critical** — crash, data loss (settings/library/bible overwritten badly), the projection
  window ends up out of sync with what the operator thinks is live.
- 🟠 **High** — missing error/empty/loading feedback on a real path, a stale flag that breaks a
  later action, an orphaned IPC method that should be wired, a `selectOutput` branch that
  projects the wrong thing.
- 🟡 **Medium** — hardcoded color duplicating a token, inconsistent copy/casing, minor UI drift.
- 🔵 **Low** — naming, ordering, small inconsistencies.
- ⚪ **Info** — suggestions, refactors that aren't bugs.

---

## Output to the user (in the user's language)

After writing the file and updating the index, give a short summary in the user's language: the verdict, the
finding counts by severity, the 2–3 most important issues, and the report path. Do not paste the
whole report into chat.
