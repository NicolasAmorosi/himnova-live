# CLAUDE.md — Lumina Live (WorshipApp)

Working guide for Claude Code in this repository. Read it before touching code.

WorshipApp — the product has been called **Lumina Live** since 2026-10-22 and is open source
(GPL-3.0-or-later) in the `lumina-live` repo; the packages and the internal identifiers stay as
`worship*` — is a desktop projection app for churches, built with **Electron + TypeScript + React +
Vite + Tailwind**, with **embedded SQLite** as its backend, meant as a replacement for EasyWorship.
It drives two windows — control and projection — to show PowerPoint slides (a `.pptx` drawn by the
app itself, the rest converted with headless LibreOffice), video, images, audio and Bible verses (it
ships the RV1909, in the public domain; any other version is imported) during a service. Visual identity: Lumina Live's (navy + teal accent +
the flame, identity sheet of 2026-10-22), with a switchable light/dark theme (dark by default, meant
to be operated from a dark booth).

It is the direct successor of the vanilla JS version of this same repo (retired on
2026-10-22, see the **Legacy** section at the end) and, further back, of `church-presenter`
(an earlier, archived project).

---

## Interaction rules

- **All code, comments and names in ENGLISH.** No exceptions.
- **The UI is in Spanish, English, Italian and Brazilian Portuguese** (2026-10-22). `es` is the
  reference: the `en`/`it`/`pt` dictionaries carry its type (`Messages`), so a key that is missing
  from or extra in any of them doesn't compile. UI text always goes through `useT()`
  (`src/renderer/src/lib/i18n/`), never hardcoded; **a new string goes into all four
  dictionaries in the same change**. What main says (menu, dialogs, errors that reach a
  toast) goes through `mt()` and its own dictionary (`src/main/i18n/`), which follows the chosen
  language. A new install starts in the operating system's language (`--lang` wins, which is how
  the E2E suite pins Spanish); an existing one keeps its own.
- **Don't create documentation files (`.md`, README, docs) unless explicitly asked.**
- Be concise. Give code directly, no filler.

## Certainty before code — 99% or ask

**Before writing non-trivial code you have to reach ~99% certainty about what the user
wants.** Don't assume: ask. This project has too many invisible decisions
(what happens on the projector, what happens to the deck's audio, what the operator sees on the
monitor) to guess them.

The protocol, in order:

1. **Read before asking.** Questions are about what the repo does *not* answer. If the
   answer is in `CLAUDE.md`, in `docs/knowledge/`, in `.claude/knowledge/` or in the code,
   it isn't a question: it's a pending read.
2. **List the assumptions** the request leaves open. An assumption is open when two
   reasonable readings of the request lead to different implementations.
3. **Ask with `AskUserQuestion`**, not in prose: concrete, mutually exclusive options,
   with the recommended one first and the trade-off explicit in each. Batch as much as you can
   into a single round of questions instead of trickling them out.
4. **Only then implement**, and say up front under which assumptions whatever wasn't asked
   was resolved.

Questions that almost always need asking in this project, because the request almost never
answers them:

- Does the change affect **what is projected** (`ProjectionOutput`) or only the control window?
- What happens if that is **live** at that moment? And with BLACK/LOGO on top?
- Does it need a **new IPC channel**, or is renderer state enough?
- Does the behavior go in a **store**, in an **effect** (`effects/`) or in an **action**
  (`lib/actions/`)?
- Does it go to `components/ui/` (reusable visual) or stay in the feature?

**Exceptions — here you execute directly, without asking:** typos, obvious renames, formatting,
read-only requests (explain, search, audit), and following an instruction the user already
gave explicitly and completely in the same message. If the user already answered something, **don't
ask again**: that's friction, not rigor.

If a doubt comes up mid-implementation: first do everything that doesn't depend on the
answer, and ask about what does. Nothing is delivered half-done in silence.

## Stack

| Layer | Technology |
|---|---|
| Build | `electron-vite` (main + preload + renderer in a single config, HMR, correct dev-server URL) |
| Language | TypeScript 5.9 strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| UI | React 19 + Tailwind v4 (`@theme inline`, no `tailwind.config.js`) |
| Identity | Lumina Live: palette from the identity sheet (`styles/globals.css`), Noto Sans + its ExtraCondensed cut for titles, logo in `assets/brand/` |
| UI utilities | `clsx` + `tailwind-merge` (`cn()`), `lucide-react` — **no cva, no Radix** |
| State | Zustand (slices per domain) |
| DB | `better-sqlite3` (Node-API, no native rebuild) + Drizzle ORM + FTS5 for the Bible |
| Packaging | `electron-builder` (nsis / ad-hoc signed dmg / AppImage + deb) |
| Updates | `electron-updater` 6.8.9, from the GitHub release marked Latest; on macOS the app downloads and opens the `.dmg` itself |
| Media conversion | FFmpeg 9.0.2 (`ffmpeg` + `ffprobe`) **bundled**, pinned by sha256 and downloaded by `scripts/fetch-ffmpeg.ts` (GPLv3, see `resources/ffmpeg-NOTICE.txt`) |
| E2E | Playwright 1.63 (`_electron`) against the built app or the installed one — `tests/e2e/` |

## Folder structure

```
src/
├── shared/                    # the ONLY source of truth for main↔renderer types
│   ├── ipc/contract.ts        # IpcContract — one entry per channel, grouped by domain
│   ├── ipc/result.ts          # Result<T> / IpcError
│   ├── style-validators.ts    # what ALL styles share (color, SceneTextStyle, background)
│   ├── scene-validators.ts    # what is specific to a timer scene; bible-style-validators.ts, the verse's
│   ├── types/                 # DTOs: display, media, bible, bible-style, projection, program, settings
│   ├── constants.ts           # AssetKind, extensions, PPT timeouts
│   └── urls.ts                # assetUrl()/slideUrl() — capability tokens, not paths
├── main/
│   ├── index.ts                # entry: DB, migrations, seed, IPC, windows
│   ├── paths.ts                 # dev vs. packaged, ALL paths resolved here
│   ├── windows/                 # control-window.ts, projection-window.ts
│   ├── db/
│   │   ├── schema.ts             # Drizzle tables
│   │   ├── client.ts             # SQLite opening + pragmas
│   │   ├── migrate.ts            # backup + migrate() on startup
│   │   ├── seed/                 # Bible seed (FTS5 rebuild) + bible-formats/ (JSON,
│   │   │                         #   Zefania, USFX, OSIS, SQLite modules; 66-book canon)
│   │   └── repositories/         # one repo per aggregate (settings, media, bible, programs, history, slides)
│   ├── ipc/
│   │   ├── register.ts           # registerHandlers<Handlers> — exhaustiveness enforced by TS
│   │   ├── index.ts               # assembles every *.ts in handlers/
│   │   └── handlers/              # one file per domain, same grouping as the contract
│   ├── protocol/worship-protocol.ts   # worship:// — serves files by id, never by path
│   ├── slides/                    # libreoffice.ts (discovery+soffice), pptx-metadata.ts (OOXML),
│   │                              # rasterizer.ts (hidden window+pdfjs), deck-service.ts (queue+cache),
│   │                              # ppt-binary.ts + native-deck.ts (legacy decks read with no LibreOffice),
│   │                              # pptx/ + pptx-deck.ts (a .pptx read into a SlideModel per slide,
│   │                              #   on the pptx-worker.ts thread)
│   ├── media/                     # media-compat.ts (what Chromium plays: PURE, tested), ffmpeg.ts
│   │                              #   (processes), conversion-service.ts (queue + cache of playable copies),
│   │                              #   deck-clips.ts (video/audio embedded in a .pptx), thumbnail-service.ts,
│   │                              #   media-engine.ts (one libmpv process per file) + engine-sessions.ts (live video, slide clip and audio, PREVIEW)
│   ├── windows/projector-screen.ts # the projector bound to its screen: anti-sleep and reconnection
│   ├── updates/                   # updater.ts (owns UpdateStatus, wraps electron-updater), mac-dmg.ts
│   │                              #   (macOS without Squirrel), update-status.ts (PURE, tested)
│   ├── logging.ts                 # main.log and crash.log, rotated
│   └── services/                  # repos.ts (registry), projection-state.ts, broadcast.ts
├── preload/
│   ├── index.ts                  # GENERIC invoke/on bridge — never edited when adding channels
│   └── index.d.ts                # declare global { interface Window { worship: WorshipBridge } }
└── renderer/
    ├── index.html                 # control window
    ├── projection.html            # projection window
    └── src/
        ├── main.tsx / projection.tsx    # entries
        ├── app/App.tsx                   # control window shell
        ├── projection/ProjectionApp.tsx  # projection window shell (no domain logic)
        ├── components/
        │   ├── ui/          # design system primitives — barrel index.ts
        │   ├── shared/      # cross-feature: modal, panel, output-view (renders a ProjectionOutput),
        │   │                #   timer-scene + bible-scene (the two generated scenes), style-fields
        │   └── pages/       # one folder per feature:
        │       ├── layout/     # AppShell (EasyWorship-style grid), TopBar
        │       ├── schedule/   # the order of service (left column, top)
        │       ├── resources/  # tabbed browser: Bible | Media (videos, images, audio, presentations) | Functions
        │       ├── slides/     # center: PREVIEW monitor + grid of slides/verses of the item in preview
        │       ├── monitors/   # right column: LIVE monitor, live grid, deck transport
        │       ├── settings/   # Settings; sections/bible/ = verse style + version manager
        │       └── programs/   # saved programs modal
        ├── stores/          # Zustand: program, toast, preview, projection, deck, bible,
        │                    #   library, settings, audio, display, ui
        ├── effects/         # projection-sync.ts + deck-autoplay.ts + deck-sounds.ts +
        │                    #   end-of-playback.ts — the "order-dependent" logic
        └── lib/             # api.ts, ipc.ts, i18n/, utils.ts, hooks/, actions/ (crosses stores),
                             #   utility-output.ts + bible-output.ts (the two builders shared
                             #   between selectOutput and the PREVIEW monitor)
```

## Component reuse — non-negotiable

This is the core rule of the component system:

- **No component in `components/pages/**` writes a Tailwind color, shadow,
  radius or typography class by hand.** Everything comes from a primitive in `components/ui/`. If
  you need a button, you use `<Button>`; if you need an accent color, it's a semantic token
  (`bg-primary`, `text-danger-ink`, …), never a hex or a `bg-[#2b6cb5]` class.
- **If something visual repeats in two features → it moves up to `components/ui/`.** If something
  with domain logic repeats in two features → it moves up to `components/shared/`. Once doesn't
  justify moving it up; the second time does.
- **Primitive pattern** (see `components/ui/button.tsx` as the canonical reference):
  `type Props = HTMLAttributes<...> & { ... }` (never `interface`), a module-level
  `Record<Variant, string>` for the variants, `ref` as a normal prop (React 19, no `forwardRef`),
  and `cn(base, variants[variant], className)` to compose.
- **All colors/shadows/radii come from `styles/globals.css`** (`@theme inline` +
  `:root`/`[data-theme]`). Never a hardcoded color value in a component — not even
  "just for now". See the semantic tokens table below.
- **A primitive that can live inside a grid cell carries `h-full` AND `w-full`.** One isn't
  enough: a `<button>` sizes *shrink-to-fit* even when it is `display:flex`, so
  as soon as it stops being the grid item (e.g. wrapped by `VirtualGrid`'s `role="listitem"`)
  its width becomes that of its own content. And if a grid also computes
  offsets from its height, that number goes in `components/ui/thumb-tile.geometry.ts`,
  imposed on the CSS — never estimated from it. Full diagnosis in
  [`.claude/knowledge/tile-height-uniformity-flex-min-height-and-grid-auto-rows.md`](.claude/knowledge/tile-height-uniformity-flex-min-height-and-grid-auto-rows.md).
- **When there's no room, text truncates; an icon never shrinks.** `Icon` already carries
  `shrink-0` (no need to repeat it). And text that truncates goes in its own
  `<span className="truncate">`: on a `flex`/`inline-flex`, loose text is an anonymous item and
  gets cut mid-letter with no «…» (`Button` and `Tabs` already wrap it themselves). Diagnosis and
  detector in
  [`.claude/knowledge/a-shrinking-icon-hides-labels-that-never-fit-and-truncate-needs-a-span.md`](.claude/knowledge/a-shrinking-icon-hides-labels-that-never-fit-and-truncate-needs-a-span.md).
- **Barrel exports**: `components/ui/index.ts` re-exports everything with named exports. No default
  exports in components.
- **Naming**: `kebab-case` files in `ui/` and loose files; `PascalCase` for components inside
  `shared/`/`pages/` subfolders; hooks `use-x.ts`; types `x.types.ts`.
- Before writing a new component, **check `components/ui/index.ts`** — the primitive you need very
  likely already exists.

### Semantic tokens (don't use the `--wa-*` values directly)

| Token | Use |
|---|---|
| `bg-background` / `text-foreground` | the app's base background/text |
| `bg-surface` / `bg-card` | panels / cards |
| `bg-muted` / `text-muted-foreground` | secondary backgrounds and text |
| `text-subtle` | tertiary text (hints, placeholders) |
| `bg-primary` / `bg-primary-hover` / `border-primary-border` | the primary button (the sheet's Primary). In dark it's navy at 1.31:1 against the background: the border isn't optional |
| `bg-secondary` / `bg-secondary-hover` | the secondary button (the sheet's Secondary: navy in light, steel `#8299b2` with dark text in dark) |
| `bg-accent` / `ring-accent` / `bg-active` | the teal: **selected / focused / on** — selection, focus ring, switch, slider, progress, active tab, pressed toggle. Never decoration |
| `bg-danger` / `bg-success` | states |
| `bg-on-air` / `border-on-air` | **reserved**: this is on the projector NOW (LIVE monitor, the active row's rail) |
| `bg-badge-{ppt,video,image,audio,bible}` | color per content type in the playlist/library |
| `text-{danger,accent,success,warning,badge-audio}-ink` | **that color as TEXT or an ICON** on an app surface. It isn't the same as the bare token, which is a FILL (`bg-danger` + white on top): in the dark theme a red that reads on `bg-card` is a light red, and white on a light red doesn't read. The two roles pull in opposite directions and **can't be a single value** |
| `shadow-surface` / `shadow-raised` / `shadow-overlay` | the ONLY 3 elevation levels — cards / dropdowns-tooltips / modals-toasts |

The theme (`ui.theme` in `settings`, `data-theme` on `<html>`) redefines the `--wa-*`; the
components never need to know which theme they're in.

**Derived rule, non-negotiable: a color written as text always goes through its `-ink`.**
`text-danger`, `text-accent`, `text-success`, `text-warning` and `text-badge-audio` **don't exist**
as text classes: the sheet's red gives 2.89:1 on `bg-card` in the dark theme, below
the 3:1 WCAG asks for even for an icon. Only the five hues that appear as loose text or icons
have an `-ink`; the rest of the badges only paint `Badge`'s tint, which already carries
`text-foreground`. Each `-ink` is its own sheet color lightened (dark) or darkened (light)
just until it passes 4.5:1. And conversely, a fill with white text on top has to pass 4.5:1: that's
why `success` and `accent` are 6–8% darker than the sheet's value (invisible, measured), and the
amber carries dark text, never white.

Every color value comes from the Lumina Live identity sheet, or is a mix of two of
its colors — never invented. Before adding one, read the palette table in
`docs/knowledge/06-ui-and-theme.md`. Shapes come from the identity too: buttons, badges,
switches and segments are **pills** (`rounded-full`), a dialog `rounded-2xl`, a card or a
group `rounded-xl`, a field or a thumbnail `rounded-lg` — a surface never contains a radius
larger than its own. Focus is the `outline` of the `focus-ring` utility (or `focus-ring-inset` inside
something that clips), **never** `ring-offset-*`: its gap is painted white, and in the dark theme it
drew a white halo around every focused control.

## Knowledge base — read it according to the task

| File | When to read it |
|---|---|
| [`docs/knowledge/01-architecture.md`](docs/knowledge/01-architecture.md) | electron-vite, the two windows, dev vs. packaged, `paths.ts` |
| [`docs/knowledge/02-ipc-contract.md`](docs/knowledge/02-ipc-contract.md) | `IpcContract`, how to add a channel, why the preload never changes |
| [`docs/knowledge/03-slides-libreoffice.md`](docs/knowledge/03-slides-libreoffice.md) | headless LibreOffice, OOXML parsing (timings/audio), rasterizing, deck cache |
| [`docs/knowledge/04-renderer-state.md`](docs/knowledge/04-renderer-state.md) | Zustand, `selectOutput`, the effects layer |
| [`docs/knowledge/05-data-and-persistence.md`](docs/knowledge/05-data-and-persistence.md) | SQLite schema, FTS5, legacy data migration, missing files |
| [`docs/knowledge/06-ui-and-theme.md`](docs/knowledge/06-ui-and-theme.md) | design system, tokens, panel layout |
| [`docs/knowledge/07-roadmap-and-debt.md`](docs/knowledge/07-roadmap-and-debt.md) | what's missing, what was left out of scope, known debt |

Also check [`.claude/knowledge/INDEX.md`](.claude/knowledge/INDEX.md) — specific findings
that pile up session after session.

### The two knowledge bases — the boundary

There are two, and they aren't the same. Writing in the wrong one is how a finding gets lost.

| | `docs/knowledge/` | `.claude/knowledge/` |
|---|---|---|
| What it is | curated **structural** documentation: how the system works today | **atomic**, dated findings: what surprised us and what we learned |
| Shape | 7 thematic, numbered documents, **rewritten** when the system changes | one file per finding, `kebab-case`, they **accumulate** (append-only) + `INDEX.md` |
| When it's read | when starting work in an area | when the symptom or the file matches an entry's **Trigger** |
| Example | "this is how the slides pipeline works" | "hidden slides aren't exported to the PDF, and `advTm` isn't where it seems" |

**Promotion** rule: a finding that stops being an anecdote and becomes a rule of the
system moves up to `docs/knowledge/` (and to this file's conventions section if it's
non-negotiable). The atomic entry stays as it is, as the detailed diagnosis — which is what already
happened with the `Range` header of `worship://`.

`HANDOFF.md` is neither: it's the state of an ongoing task, not knowledge.

## Self-improvement cycle — mandatory, not optional

Every session has to leave the project better documented than it found it, or confirm
explicitly that there was nothing to document.

**When closing a non-trivial task, decide whether a durable finding came up and record it with
`/learn`** (`.claude/skills/learn/SKILL.md`, which already carries the format and updates `INDEX.md`).

A finding qualifies if it meets **all three**:

1. **It isn't derivable** from the code, from `git log` or from this file.
2. **It was costly to discover**: a wrong assumption, a misleading error, a tool that
   behaved differently from its documentation, a fix that took several attempts.
3. **It will matter again**: it conditions a whole area (protocol, slides, projection, DB,
   packaging), not a line.

Not recorded: what a file does, structure git already versions, a rule that's already
here or in `docs/knowledge/`, or task state (that's `HANDOFF.md`). **Closing the cycle without
writing anything is a valid outcome** — never invent an entry to have something to show.

Two automations sustain this (`.claude/settings.json` → `.claude/hooks/`):

- `SessionStart` injects into the context the certainty protocol, the minimum verification bar and
  the index of the findings already recorded.
- `Stop` warns the user when there are changes in `src/` and nothing new in `.claude/knowledge/`.
  It's only a `systemMessage`; it never blocks the turn.

## Claude configuration in this repo

| Path | What it is |
|---|---|
| `.claude/settings.json` | versioned: allowlist of verification/read-only commands, `deny` of `rm -rf`, and the cycle's two hooks |
| `.claude/settings.local.json` | personal preferences, not versioned |
| `.claude/hooks/` | the scripts the hooks run (testable by hand: `echo '{}' \| ./.claude/hooks/<script>.sh`) |
| `.claude/skills/` | `/add-ipc`, `/audit-page`, `/commit`, `/learn` |
| `.claude/knowledge/` | atomic findings + `INDEX.md` |

Destructive or outward-facing commands (`git commit`, `git push`, `npm install`,
`db:generate`, deleting files) **still ask for confirmation on purpose**. Don't add them to the
allowlist.

## Essential commands

```bash
npm install              # installs deps — better-sqlite3 ships prebuilt binaries, nothing compiles.
                          #   The `postinstall` also downloads the Electron binary: since v42 the
                          #   package NO longer does it by itself, and without it `npm run dev` dies with
                          #   `Error: Electron uninstall` while build/typecheck/lint still pass.
                          #   It also downloads this platform's FFmpeg (`resources/ffmpeg/`, ~130 MB
                          #   on macOS, ~210 MB on Windows), verified by sha256
npm run dev               # electron-vite dev (HMR in the renderer, main restarts on watch)
npm run typecheck          # tsc --noEmit over node (main+preload+shared) and web (renderer+shared)
npm run lint                # eslint .
npm run test                 # vitest run — 484 cases in two projects: `main` (Node: migrations, seed,
                              #   FTS5, repos and the library sweep, draft, settings and scene validators, WAL backup,
                              #   zip reader, the legacy-deck reader against an OLE2 file built in the test
                              #   (`tests/fixtures/legacy-ppt.ts`: pictures, master inheritance, what it refuses),
                              #   slide transitions from OOXML, native deck rows, linked audio, urls, history prune, timer functions,
                              #   dragging a countdown, timer scenes as an order-of-service item,
                              #   video embedded in a slide: geometry, external rels and node by `spid`,
                              #   verse style, the update errors and launch check, and the Bible format
                              #   readers against real files written on the fly: Zefania, USFX, OSIS,
                              #   SQLite modules, Latin-1 and .zip)
                              #   and `renderer` (jsdom: selectOutput —including slide video under
                              #   BLACK and a slide's own way in, forward only—, the LibreOffice gate per deck,
                              #   the dressed verse and its live restyling,
                              #   freezeLivePositions, live-intent, transport
                              #   of timer scenes, the «Test video» verdict, the size of the
                              #   frozen frame, toast store, utils). Nothing imports `electron`: that's
                              #   the suite's boundary
npm run test:watch            # the same suite in watch mode, while working on a module
npm run test:e2e              # build + Playwright: 132 walkthroughs of the real app (~7 min) with a
                              #   throwaway profile and media generated on the fly with the bundled FFmpeg (videos, AVI,
                              #   WMA, PDF, a legacy .pps made of pictures read with no LibreOffice, and .pptx with
                              #   auto-advance and with an embedded WMV if LibreOffice is there):
                              #   live, library, LOGO, decks, Bible, Functions, programs, keyboard, Settings,
                              #   updates against a local fake of GitHub, robustness and an entire service
                              #   (`service.spec.ts`). Native dialogs are
                              #   answered with `answerOpenDialog`. With WORSHIP_E2E_EXECUTABLE=<path to the installed
                              #   executable> it runs against the PACKAGED app — the only way to test what
                              #   resolves from `resources/` —, and with WORSHIP_E2E_HYMNAL=<folder with 522.pps>
                              #   it also runs the real hymnal (`hymnal.spec.ts`). The suite runs the app in
                              #   Spanish on purpose (`--lang=es`, `tests/e2e/support/app.ts`): its locators are
                              #   the `es.ts` strings, so they stay in Spanish
npm run fetch:ffmpeg          # FFmpeg for this machine (the postinstall and every package:* also do it)
npm run db:generate            # drizzle-kit generate — new migration after editing db/schema.ts
npm run slides:smoke -- x.pptx # conversion + OOXML parsing (timings/audio) WITHOUT Electron
npm run build                 # electron-vite build
npm run package:win|mac|linux  # build + electron-builder for that platform
```

## Conventions that are NOT negotiable

- **Adding an IPC channel = one line in `src/shared/ipc/contract.ts` + one entry in the
  `Handlers` of `src/main/ipc/index.ts`.** If the handler is missing or has the wrong signature, it
  doesn't compile — "forgetting a file" isn't possible. The preload (`src/preload/index.ts`) is
  generic and **is never touched** when adding a channel.
- **`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`** in
  both windows. Don't change them. Never `require()` in the renderer.
- **Local files are served through `worship://`** (`src/main/protocol/worship-protocol.ts`),
  resolving by `media_assets` id or by slides session — never by a filesystem path
  embedded in the URL. Don't reintroduce a hand-built `file:///`.
- **`serveFile()` MUST honor `Range` (206 + `Accept-Ranges`).** Don't "simplify" it back to
  `net.fetch(file://…)`: that ignores the headers, leaves every video/audio **without seek** and
  breaks playback with `PIPELINE_ERROR_DECODE (-12909)` from misaligned data. Full diagnosis in
  [`.claude/knowledge/worship-protocol-range-and-video-lifecycle.md`](.claude/knowledge/worship-protocol-range-and-video-lifecycle.md).
- **Canceling a queued job ALWAYS settles its promise.** Taking a `Job` out of a queue without
  `inFlight.delete()` + `reject(CANCELED)` doesn't cancel it: it leaves a promise that never
  resolves and, worse, a zombie in the dedupe map that returns that same dead promise forever —
  skipping even the cache hit, which is guarded by `!inFlight.has()`. A **running** job
  needs none of that (`pump` settles it). Diagnosis in
  [`.claude/knowledge/canceling-a-queued-job-must-settle-it-or-it-poisons-the-dedupe-map.md`](.claude/knowledge/canceling-a-queued-job-must-settle-it-or-it-poisons-the-dedupe-map.md).
- **A `jsx-a11y` error on a container that delegates the keyboard is suppressed with its reason, not
  "fixed".** `Tabs`, `VirtualGrid`, `Select` and `Modal`'s sentinels handle keys on
  the container on purpose: the tab stop is the selected tab, the focused tile or the
  trigger, and the rule reads **one element at a time**. Making the container focusable adds a tab
  stop that leads nowhere, and a keyboard handler on a `role="option"` can never
  fire. See
  [`.claude/knowledge/jsx-a11y-reads-one-element-so-every-delegated-keyboard-pattern-is-an-error.md`](.claude/knowledge/jsx-a11y-reads-one-element-so-every-delegated-keyboard-pattern-is-an-error.md),
  which also has the two traps of the directive's `-- reason` syntax.
- **No `dangerouslySetInnerHTML`, ever.** To highlight matches, the primitive receives
  **segments** (`{text, match}[]`), not a string with markup inside — so the unsafe version can't
  even be written. The case that motivated it: FTS5's `snippet()` wraps the raw text
  of the verse, which comes from a JSON the user imports, and the renderer has the generic IPC
  bridge. See
  [`.claude/knowledge/fts5-snippet-is-markup-wrapped-around-user-supplied-text.md`](.claude/knowledge/fts5-snippet-is-markup-wrapped-around-user-supplied-text.md).
- **The unsaved order of service is mirrored to SQLite on its own (`program_draft`), and closing the
  window is decided by the control window, not by main.** `effects/draft-autosave.ts` writes the
  draft with a debounce and `App` recovers it on startup; it was the only user data without a
  backup. Main **never** infers whether there's unsaved work or what's on air:
  `windows/close-guard.ts` vetoes the first `close`, emits `close-requested` and waits for a
  `window:closeDecision`, with a 4 s grace period so a hung renderer can't make the app unclosable.
  The control window asks for two reasons: unsaved changes, or something on the projector (content,
  overlays, BLACK/LOGO), because an accidental ⌘Q mid-service can't turn off the screen without
  asking. A quit is held ENTIRELY in `before-quit` (`holdQuitUntilAnswered`), before any window
  closes: vetoing only the control window's `close` came too late, Electron had already closed the
  projection window and «Cancel» left the app alive and the projector off. Resuming it is
  `app.quit()` and not `win.close()`; diagnosis in
  [`.claude/knowledge/vetoing-a-close-during-a-quit-cancels-the-quit.md`](.claude/knowledge/vetoing-a-close-during-a-quit-cancels-the-quit.md).
- **An update's question comes BEFORE its installer starts, and that quit skips the close guard.**
  Once launched, the Windows installer kills the app within ~1.3 s whatever anyone answers, so a
  question asked after it offers a «Cancel» that cancels nothing, with the projector on.
  «Restart and update» asks `quitRisks()` (the same answer `close-requested` gets), and only with
  the OK does `installUpdate` start the installer and then call `releaseForUpdate()` + `app.quit()`.
  The rest of the updater follows from the same idea: nothing about it reaches the projector, a
  failed launch check only goes to `main.log`, and `autoInstallOnAppQuit` stays `false`. See
  «In-app updates» in `01-architecture.md` and
  [`.claude/knowledge/the-update-installer-kills-the-app-so-the-question-goes-before-it.md`](.claude/knowledge/the-update-installer-kills-the-app-so-the-question-goes-before-it.md).
- **The backup before a migration is taken with `VACUUM INTO` + `PRAGMA integrity_check`, never
  with `copyFileSync`.** The database runs in WAL: copying only `worship.db` silently loses everything
  after the last checkpoint — measured, 5000 rows against 4977 with a hot `-wal`. And the database
  is closed in `will-quit` (`closeDatabase()`), which is what empties the `-wal` instead of letting it
  grow between sessions.
- **A timer scene's transport lives in the ROW, and the row next to it can't show
  a different number.** `UtilityTrackRow` (`components/shared/`) is the same control in PREVIEW and
  in LIVE — value, start/pause, reset, and the draggable bar only for the countdown,
  the only tool with a total to be a position of. A scene's clock lives in two
  places (`base.clock`, what's projected; `utility.store.run`, what's armed but not projected) and
  both rows can be on screen at once: `clockForScene` reads them **in that order — what's projected
  wins** and `commitClock` (`lib/actions/utility.ts`) writes them in the same order, which is the only
  thing that keeps a timer from having two values. That's why no transport action decides its
  transition and its destination at the same time: the transition is pure (`shared/timer.ts`), the
  destination belongs to `commitClock`. And pausing what's live does **not** disarm the timer the
  operator prepared for another scene.
- **Editing what's already live patches `base` in place; it's never a new scene.**
  `setTimerClock` (pause, resume, reset) and `setLiveScene` (the operator edited the scene that's
  being projected) write over `base` without touching `sceneEpoch`, just like `setVideoResumeAt`.
  Calling `beginScene()` there would make the projector fade into an almost identical copy of
  itself mid-service, and in the clock's case it would also restart the count. There are tests that
  assert it in `tests/renderer/select-output.test.ts`.
- **A JSON column is VALIDATED on write and NORMALIZED field by field on read.** The two
  halves aren't interchangeable: main rejects a `utility:create` that doesn't describe a whole
  scene (`isUtilitySceneUpsert`) because the operator is still looking at the form; and the repo
  normalizes on read (`normalizeSceneStyle`) because a row that's ALREADY saved still has to be shown,
  and a broken color has to cost the color and not the scene — much less the startup. Same
  discipline as `DraftRepo.load` and the Bible seed. And whatever comes out of a normalizer always
  passes the validator, with a test that asserts it. **A new field that SPLITS an existing one falls
  back to the row's sibling value, not to the app's default**: `SceneEnd.message` (the type style of
  the final message) is normalized against that same row's `style.message`, because every scene written
  before drew that line that way — falling back to the default would have silently restyled every
  already-dressed scene the first time this build read it.
- **The projection window has no domain logic.** It's a pure function of the last
  `ProjectionOutput` received (`src/shared/types/projection.ts`). If you need it to "know" something
  about the service, compute it in the control window and send it through `projection:show`.
- **Main doesn't know what's live either, and no second source of truth is invented for it.**
  `selectOutput` is a **lossy** projection: a deck covered by BLACK/LOGO and "nothing is
  live" reach main as the same `ProjectionOutput`. Any decision main makes about "what's
  live" (eviction pins, history attribution, rejecting an operation) either travels inside
  the output because the projector itself needs it —like `videoUnderlay`— or belongs to the control
  window. A guard in main that's right 95% of the time is worse than none: the 5% is a rejection the
  operator can neither explain nor bypass mid-service. Diagnosis in
  [`.claude/knowledge/main-cannot-know-what-is-live-under-an-overlay.md`](.claude/knowledge/main-cannot-know-what-is-live-under-an-overlay.md).
- **Selecting NEVER projects.** The flow has two stages, like EasyWorship: a click (on the
  program, on a resource, on a verse or on a slide) moves the preview target
  (`lib/actions/preview.ts` + `stores/preview.store.ts`), and `goLive()`
  (`lib/actions/playback.ts`) is the **only** path from there to the projector — shared by the GO LIVE
  button, Enter and double-click. Don't add a second path to `projection.store`.
- **The monitors use the same renderer as the projector.**
  `components/shared/output-view.tsx` (`OutputView`) is what paints the projection window AND
  the LIVE and PREVIEW monitors. If the preview and what's projected paint differently, a monitor can
  lie to the operator — that's why there's a single component and sizes go in `cqw`.
- **A content grid that can grow goes through `VirtualGrid`, and if it reflects something live it
  has to follow it.** A deck's slides and a chapter's verses (176 in Psalm 119,
  mounted twice: preview and live) use `VirtualGrid` with the geometry from
  `components/ui/slide-grid.geometry.ts`; `SlideGrid` remained only for single-tile grids. The
  second half isn't optional: virtualizing turns "the tile is out of view" into "the tile doesn't
  exist", so the live grid follows the projector and the center one follows the preview cursor
  (`scrollToIndex`), and it only moves when that index changes — a manual scroll by the operator is
  respected until the next slide. Watch the keyboard: a jump that crosses the mounted window
  remounts the focused tile, see
  [`.claude/knowledge/a-keyboard-jump-across-the-mounted-window-remounts-the-tile-it-focused.md`](.claude/knowledge/a-keyboard-jump-across-the-mounted-window-remounts-the-tile-it-focused.md).
- **A file the projector can't play is reported, never painted there.** The
  projection window's `<video>`/`<audio>`/`<img>` has `onError` and sends
  `projection:reportMediaError`; the warning (a red band over the stage, a toast, a flagged row in the
  media panel) is painted **only** by the control window — `OutputView` in `mode === "live"` doesn't
  receive `errorLabel` because the congregation can't see an error sign. And the warning does **not**
  change what's projected: what to do with a broken file is decided by the operator, not the app. It's
  the "monitors never lie to the operator" rule applied to the case where the lie would be a
  black, silent stage.
- **A legacy `.ppt`/`.pps`'s auto-advance timings are read from the source binary, not from the
  converted `.pptx`.** LibreOffice's PPTX exporter only writes `<p:transition>` when the
  slide has a visual effect, and `advTm` is an attribute of that element: without an effect, the
  timing disappears (222 of 1226 files of the real hymnal). `ppt-binary.ts` reads them, and
  `mergeBinaryTimings` **only fills gaps and abandons the whole merge on a single discrepancy**
  with what the `.pptx` did bring — advancing with another slide's timing mid-service is worse
  than not advancing. Diagnosis in
  [`.claude/knowledge/libreoffice-pptx-export-drops-advtm-without-a-transition-effect.md`](.claude/knowledge/libreoffice-pptx-export-drops-advtm-without-a-transition-effect.md).
- **A PDF is a deck and is NOT converted with LibreOffice.** It's the pipeline's intermediate format,
  so `runConversion` sends it straight to the rasterizer (`containerKind === "pdf"`) and
  `warmBatchPdfCache` takes it out of the batch. `--convert-to pdf` on a `.pdf` imports it into
  **Draw** and redraws it — measured, 157 KB → 1.76 MB. It follows that **a PDF is projected without
  LibreOffice installed**: the question is `deckRequiresSoffice(ext)` and it's asked per deck, never per
  environment. In the renderer it goes through `sofficeBlocks(environment, ext)` (`deck.store.ts`), and
  every block also asks whether the deck already has slides: a converted one is projected without
  LibreOffice. Background work isn't even queued if the last sweep didn't find it
  (`cachedSofficeError`); whatever the operator opens looks for it again. See «Without LibreOffice» in
  `03-slides-libreoffice.md`. It lives in the `ppt` `AssetKind` on purpose, because throughout the
  renderer `kind === "ppt"` already means "this is a deck". Diagnosis in
  [`.claude/knowledge/a-pdf-source-breaks-two-assumptions-the-pipeline-made-about-its-own-output.md`](.claude/knowledge/a-pdf-source-breaks-two-assumptions-the-pipeline-made-about-its-own-output.md).
- **Never read a whole `.pptx` to get its XML parts out.** A zip is random access: everything
  goes through `readZipEntries` (`src/main/slides/zip-reader.ts`), which reads the central directory
  and only the requested ranges. `unzipSync` with `filter` does **not** avoid the 200 MB
  `readFileSync`, only the inflate. And if you add a new entry-reading path, pass `inflateSync` its `out`
  buffer with the size the central directory already carries. Diagnosis and measurements in
  [`.claude/knowledge/a-pptx-is-random-access-and-inflatesync-needs-its-out-buffer.md`](.claude/knowledge/a-pptx-is-random-access-and-inflatesync-needs-its-out-buffer.md).
- **Nothing asynchronous runs in `before-quit`.** Not a `setTimeout`, not a callback, not a promise:
  the process is already gone. Exit cleanup is synchronous, period — that's why `soffice`'s fallback
  SIGKILL goes in the same call as the SIGTERM. See
  [`.claude/knowledge/nothing-asynchronous-survives-before-quit.md`](.claude/knowledge/nothing-asynchronous-survives-before-quit.md).
- **Whatever the projector applies ONCE on mount has to be recomputed before rebuilding the
  window.** `startAtSeconds` (from `AudioTrackPush` and from `VideoUnderlay`) is a mount-time seek, not
  a position: replaying main's snapshot into a new window remounts every element at the point
  the operator chose at the start. `freezeLivePositions()` (`lib/actions/live-positions.ts`)
  folds the last reported `mediaStatus` into it, and it's called by the three paths that destroy
  the window (`projection-closed`, `display.store.close()`, `setDisplayId`'s reopen). Without it
  a deck with a soundtrack didn't just restart the music: "synced" mode derives the
  slide cursor from the audio clock, so it went back to **slide 1** mid-service. Diagnosis
  in
  [`.claude/knowledge/startatseconds-is-a-mount-time-seek-so-a-rebuilt-projector-restarts-everything.md`](.claude/knowledge/startatseconds-is-a-mount-time-seek-so-a-rebuilt-projector-restarts-everything.md).
- **Everything the projector has to SUSTAIN travels inside the `ProjectionOutput`; a
  `MediaCommand` is only for what happens once.** `paused`, `startAtSeconds` and `volume` are
  state (`VideoUnderlay`/`AudioTrackPush`); `seek` and `restart` are commands. The proof is in the
  remount: a command is lost on every new epoch and every window rebuild, and leaves
  the operator with a panel showing a level the room doesn't hear. That's why `M2`'s volume
  wasn't implemented on top of the `setVolume` that already existed — that command was deleted.
- **A video embedded in a slide travels as `slideVideo`, at the TOP of `ProjectionOutput` and
  not inside the `slide` variant.** Under BLACK the `kind` becomes `"black"`, so a video that
  lived inside the variant would vanish from the push right when it's covered — unmounting the
  element, losing the position and recreating the decoder on every toggle. It's covered with opacity
  and paused, just like `videoUnderlay`. Its `rect` is in fractions of the SLIDE, not of the stage: the slide's
  `<img>` is `object-contain` and letterboxes, so the overlay rebuilds that box with
  `min(100cqw, ratio * 100cqh)` inside its own `container-type: size` container — the
  view's `@container` is `inline-size` and gives no block axis, so a loose `cqh`
  silently resolves against something else. Diagnosis in
  [`.claude/knowledge/an-overlay-on-a-slide-must-rebuild-the-object-contain-box-and-cqh-needs-container-type-size.md`](.claude/knowledge/an-overlay-on-a-slide-must-rebuild-the-object-contain-box-and-cqh-needs-container-type-size.md).
  The feature is `.pptx`/`.ppsx` only: a legacy `.ppt`/`.pps` loses the video entirely.
- **BLACK/LOGO pauses what the projector plays and keeps its position; a standalone audio keeps
  playing.** The `<video>` isn't unmounted when covered (`videoUnderlay` in `ProjectionOutput` +
  `LiveVideo` in `output-view.tsx`): it's only hidden and paused, and when uncovered it resumes where
  it was. Since 2026-09-09 a deck's audio track does the same, and it also freezes auto-advance,
  or else on uncovering the slide would be ahead of its music. See
  [`.claude/knowledge/deck-soundtrack-negro-logo-pause-and-autoplay-freeze.md`](.claude/knowledge/deck-soundtrack-negro-logo-pause-and-autoplay-freeze.md).
  The deliberate exception is an audio sent live on its own: it's background music, not
  projector content.
- **The verse travels DRESSED, and its style is a `settings` key, not a row.** The `bible`
  variant of `ProjectionOutput` carries its resolved `BibleStyle` and `backgroundUrl` inside it, for
  the same reason a timer scene carries them: the projector resolves nothing and
  `projection-state.ts` replays that value as is. The style lives in `settings["bible.style"]`,
  `App` mirrors it to `projection.store` (as it already does with the two transition keys) and that's
  why `selectOutput` can stay a pure function of that store. Editing it while a verse is
  live reaches the projector instantly and **without a transition**: none of that touches `sceneEpoch`.
  It's built by `bibleOutputFor`, shared with the PREVIEW monitor just like `timerOutputFor`.
- **The verse's size is MEASURED against the stage; the testament comes from the POSITION; a
  file's format comes from its BYTES.** All three are the same rule: it isn't deduced from a
  name. Auto-fit measures the whole block (the reference is inside it) and its `ResizeObserver`
  observes the STAGE, never the block —observing the block is a loop by construction—; the testament
  is `index <= 39` and not a list of abbreviations, which is how 23 Old Testament books
  were stored as `"NT"` since the first commit; and `detectBibleFormat` sniffs magic
  numbers and the root element, because a renamed module is the norm. The two findings:
  [`a-book-code-namespace-is-per-format-and-testament-was-never-derived-right.md`](.claude/knowledge/a-book-code-namespace-is-per-format-and-testament-was-never-derived-right.md)
  and
  [`a-bible-module-is-milestoned-xml-or-latin-1-or-sqlite-and-never-what-its-name-says.md`](.claude/knowledge/a-bible-module-is-milestoned-xml-or-latin-1-or-sqlite-and-never-what-its-name-says.md).
- **Never a `cqh` under `OutputView`.** Its root is an `inline-size` container: with no block
  axis, a `cqh` doesn't fail — it silently resolves against the small viewport, which on a 240 px
  confidence monitor is the whole control window. It has already bitten twice (a slide's video
  overlay, and `TimerScene`'s vertical margin). If the vertical axis is really needed,
  it goes inside a wrapper of its own with `container-type: size`.
- **`selectOutput` (`src/renderer/src/stores/projection.store.ts`) is the only source of what gets
  projected.** It's an exhaustive `switch` over `BaseContent` — adding a new content type
  without handling it there is a compile error, not a runtime bug like the legacy
  `restorePrevious()`.
- **If Chromium can't play a video or an audio file, it's converted; it's never decided by the
  extension or by waiting for `error`.** Measured: ProRes, MPEG-4 part 2 or MJPEG inside a
  `.mp4`/`.mov` play sound over black without any `error`, and AC3/DTS/ALAC give a picture WITH NO
  SOUND. `media-compat.ts` decides from ffprobe's streams (and HEVC depending on the GPU, which the control window reports), and
  `conversion-service.ts` converts in the background, on import or when watching a linked folder, to
  H.264/AAC capped at 1080p, without touching the original. `worship://asset/<id>?v=<copy>` serves the
  copy and the URL without `v` ALWAYS serves the original. **The video/audio URL comes from
  `playableAssetUrl`**, for two reasons: Chromium reuses a URL's data across elements (when the bytes
  change the string has to change), and an element that started with the original can't receive the
  copy's bytes in the middle of a song. That's why the video URL travels resolved in `BaseContent`. A
  `.pptx`'s clips carry their file (`?f=`) for the same reason.
  GO LIVE on something that's still being converted is refused with a warning. **Since 2026-10-30 a
  library VIDEO is not converted: the media engine plays it** (libmpv in its own process,
  `native/engine/`). `conversion-service` marks it `engine`, `playableAssetUrl` gives
  `worship://engine/<id>`, and `OutputView` draws the engine's frames in a canvas instead of a
  `<video>` — the same frame in the projector and the monitors. Main drives the live session from the
  `ProjectionOutput` it already forwards (`media/engine-sessions.ts`), never from a record of its own;
  PREVIEW has a muted engine of its own (`preview:setVideo`). **A library AUDIO too** (step 1.2, same
  day): one engine per live track, driven from the `AudioTrackPush[]` main already keeps; the projector
  mounts no `<audio>` for it, and closing the projector pauses it as it silenced an `<audio>` (owner).
  **A deck's clips and sounds too** (step 1.3, same day): `deck-clips.ts` marks such a clip for the
  engine in memory (re-decided every launch, like the library's) and the DTO names it
  `worship://engine/deck-{audio,video}/<id>`; the slide's clip is a `slideVideo` engine session drawn
  in a canvas inside its rect, and a clip an earlier build converted goes back to its original. Only a
  build with no engine still converts. Diagnoses in
  [`.claude/knowledge/chromium-plays-sound-over-black-for-a-codec-it-cannot-decode.md`](.claude/knowledge/chromium-plays-sound-over-black-for-a-codec-it-cannot-decode.md)
  and
  [`.claude/knowledge/chromium-reuses-a-media-urls-data-across-elements-so-changed-bytes-need-a-changed-url.md`](.claude/knowledge/chromium-reuses-a-media-urls-data-across-elements-so-changed-bytes-need-a-changed-url.md).
- **A resource that changes per platform goes in that platform's block of `build`** (`win`, `mac`,
  `linux`), never at the top with `${platform}`: that macro is the building machine's, and the
  Windows installer built on the Mac came out without FFmpeg and without any error. See
  [`.claude/knowledge/electron-builder-platform-macro-is-the-build-host-not-the-target.md`](.claude/knowledge/electron-builder-platform-macro-is-the-build-host-not-the-target.md).
- **If the projector's screen disappears, its window is HIDDEN — not closed — and comes back on its
  own** when there's a second screen again. The same happens if the projector is turned on after
  opening the app: the window moves from the laptop to that screen. Main does it
  (`windows/projector-screen.ts`, pure rule in `projector-display-choice.ts`), without rebuilding the
  window. Closing it silenced the room: every `<audio>` of the service lives in that window. The
  control window only lists the screens again (`display.store.refresh`) and shows the warning; it
  never moves the window, and nothing sends it to the main screen on its own. While it exists, a
  `powerSaveBlocker` keeps the screens from turning off mid-sermon.
- **A slide is content, not a controlled slideshow — and a `.pptx` is drawn, not converted.** A
  `.pptx` (any OOXML presentation) is read by `src/main/slides/pptx/` into a `SlideModel` per slide
  that `SlideView` draws in the renderer (`image_format = 'model'`, no LibreOffice, see «Model
  decks» in `03-slides-libreoffice.md`). The owner's call (2026-10-26): the switch is **total** —
  never a deck drawn half by the model and half by LibreOffice — and what the model can't draw
  exactly is **approximated, never refused**; only a file that won't open as a presentation goes to
  LibreOffice. A model slide's `url`/`thumbUrl` serve no image: whatever draws a slide checks
  `modelUrl` first. A legacy `.ppt`/`.pps` made of pictures — the hymnal — is not converted either:
  `ppt-binary.ts` reads which pictures make up each slide and `worship://` serves them straight from
  the file (`image_format = 'native'`, no cache folder, see «Native decks»); **a legacy deck the
  native reader cannot draw exactly is refused whole and goes to LibreOffice** — never half a deck
  each way, never a slide drawn wrong in silence. What's left (an `.odp`, a legacy deck with text) is
  converted only once (LibreOffice → PDF → WebP per slide) and cached in `userData/slides-cache` +
  SQLite, addressed by **content hash**. BLACK/LOGO never hide the projection window: they are
  normal results of `selectOutput`. Don't reintroduce COM, PowerShell or `assertWindows()`.
- **A slide enters the way its file says, and only moving forward.** `DeckSlide.transition` comes
  from the deck (fade, fade through black and random bars drawn as themselves, anything else a
  crossfade of its length); `setSlideIndex` keeps it only when the index grows, and a new scene
  forgets it — back is a cut and the deck's first slide gets the scene fade (owner, 2026-10-26). It
  reaches the projector as the `slide` output's `enter`, whose `seq` (`slideVideoEpoch`) is what
  `OutputView` compares, so a push re-sending the same slide plays nothing.
- **The `name` in `package.json` (`worship-app`) and the `appId` (`com.worshipapp.app`) aren't
  touched, even though the product is called Lumina Live.** Electron names the data folder after
  `name` —the `productName` lives in `build`, belongs to electron-builder and doesn't reach the
  packaged `package.json`—, so the profile is `<appData>/worship-app` in dev and in the installer.
  Changing `name` leaves the church's service (programs, library, Bibles, settings) in a folder
  nobody opens; changing `appId` makes the new installer install NEXT TO the old one instead of
  replacing it. Any reasoning about the default path is verified by launching the package WITHOUT
  `--user-data-dir` (the E2E tests always pass it). See
  [`.claude/knowledge/electron-userdata-follows-package-name-not-build-productname.md`](.claude/knowledge/electron-userdata-follows-package-name-not-build-productname.md).
- **Never write user data inside the app bundle.** The DB lives in
  `app.getPath('userData')/worship.db`; the packaged resources (`resources/bibles/*.json`,
  `drizzle/*.sql`) are read-only in production — always access them through `src/main/paths.ts`.
- `kebab-case` filenames (`PascalCase.tsx` components inside their folders). Vars and
  functions `camelCase`.

## Legacy

The vanilla JS version (Electron without a bundler, `main.js`/`preload.js`/`src/js/app.js`) lived in
`legacy/` until 2026-10-22, when it was retired from the repo before publishing it: the two conditions
for deleting it were already met (LibreOffice replaced COM, and
`src/main/services/migrate-legacy-data.ts` migrates its data on its own at first startup). To see how
something behaved before: `git show 90d3821:legacy/src/js/app.js`.

## Operational notes

- It's developed and verified on macOS: there are no Windows-only features anymore. On an Apple
  Silicon Mac with Rosetta, `npm run package:win` produces the complete NSIS installer;
  always check `release/win-unpacked/resources/ffmpeg/` afterwards.
- Requires **LibreOffice installed** to convert an `.odp` or a legacy `.ppt`/`.pps` with text
  (`brew install --cask libreoffice`); a `.pptx`, a PDF and the hymnal don't need it. It isn't
  bundled; the app detects it and guides the installation if it's missing.
- `git` is active; commit/push only if the user asks.
- Plans, audits and the brand sources are maintainer notes and **aren't published**:
  they live in the maintainer's workspace, outside this repo (`../docs/plans/`, `../docs/auditorias/`).
- There's no CI configured — that's the user's decision, not a pending item.
  `npm run typecheck && npm run lint && npm run test` is the minimum bar before calling
  a task done, and it runs by hand. Before a release, also `npm run test:e2e` and the same suite against
  the package (`WORSHIP_E2E_EXECUTABLE`).
- A release is published as **Latest, never as a prerelease**, and it carries the three
  `latest*.yml` and the `.blockmap` files next to the installers, uploaded in the same
  `gh release create`. Without them no install updates; with a stale one, every install downloads
  an update and then rejects it. Releases are immutable once published, so a mistake is fixed with
  a new version.
