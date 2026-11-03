# 06 — UI and design system

## Origin: copied from `libretto-villaaurora`

The architecture of `src/renderer/src/components/` (not the palette) is a deliberate copy of
`libretto-villaaurora/apps/web/src/components`: `ui/` (primitives), `shared/` (cross-feature
compositions), `pages/` (one folder per feature). See the "Component reuse" section in
`CLAUDE.md` — it's the rule that isn't negotiable in this repo.

Pieces copied almost verbatim because they solve a non-obvious problem:

- `lib/utils.ts` → `cn()` with `extendTailwindMerge` extending the `shadow` group with
  `surface`/`raised`/`overlay` — without this, `tailwind-merge` doesn't know that
  `shadow-surface` and `shadow-none` conflict with each other.
- `components/ui/button.tsx` → the reference pattern for every new primitive.
- `components/shared/modal/` → global stack + portal, so that only the top modal paints the
  backdrop when more than one is open.

## Identity: Lumina Live

Since 2026-10-22 the product is called **Lumina Live** and has its own identity, which replaced
the Adventist palette (ALPS/Denim) of earlier versions. The source is the «Identidad App Lumina
Live» sheet (an Illustrator PDF, two pages: palette per mode, and logo + wordmark). Three things
about that sheet that aren't visible at a glance and were found by reading the PDF's internals:

- The **light mode Secondary** is labeled `#2f557f` (same as the Primary) but drawn
  `#213c59`. The drawn value wins.
- The sheet's typeface is **Noto Sans ExtraCondensed** (ExtraBold for titles and the wordmark,
  SemiBold for labels). It's the same family as the app's text, in another width.
- The logo is vector: a rounded rectangle `#162231` (radius 7.3%), a radial glow `#f7931e` at 8%,
  and four flames — `#ffad40` at 31%, `#ffa92d`, `#e36520`, `#d14600`. «Live» is in `#d14600`.
  It's traced as-is in `src/renderer/src/assets/brand/lumina-live-mark.svg`.

### The palette and its roles

`src/renderer/src/styles/globals.css` defines **two physical palettes** (`--wa-*`, in `:root`/
`[data-theme="dark"]` and in `[data-theme="light"]`) mapped to **a single set of semantic
tokens** via `@theme inline`. Components only reference the semantic ones — never `--wa-*`
directly — so the theme toggle doesn't require touching any component.

| Sheet | Light | Dark | Token |
|---|---|---|---|
| Background | `#ffffff` | `#162231` | `background`, `surface` (panels, bar, fields) |
| Dialog box | `#f5f6f9` | `#1b2c41` | `card` (dialogs, menus, tooltips, thumbnails) |
| Borders | `#c8d2dc` | `#2e4155` | `border` |
| Primary | `#2f557f` | `#203651` | `primary` — the main button |
| Secondary | `#213c59` | `#8299b2` | `secondary` — the secondary button |
| Primary / secondary text | `#182a40` / `#5c7089` | `#eef2f6` / `#9aa9b8` | `foreground` / `muted-foreground` |
| Accent | `#3e8391` | `#3e8391` | `accent` — selected, focus, on |
| Indicators | `#448d21` `#ffa92d` `#e36520` `#dd1f1f` | same | `success`, `warning`, `badge-ppt`, `danger` and `on-air` |

The roles were decided by the identity's owner (2026-10-22): **Primary = main button,
Secondary = secondary button, Accent = selection/focus**, and **live = red** (tally convention;
the orange of the logo's «Live» was kept for the brand and the presentations badge).

Consequences that matter when touching the palette:

1. **The dark Primary is at 1.31:1 against the background.** A main button without a border is a
   label floating in the void, so it carries `border-primary-border` (`#384f69`, Primary →
   Secondary at 25%). In light that token equals the fill and adds nothing. It's understated on
   purpose —the booth is dark—, and for the same reason the Secondary (light steel) stands out
   more than the Primary in dark: it's the literal reading of the sheet, accepted as such.
2. **What the sheet doesn't define is MIXED, not invented.** `muted` and `hover` are Dialog →
   Borders at 35% and 65%; the strongest light border is Borders → Secondary text at 20%; the
   selected row (`active`) is Background + 26% accent in dark, which is the most it can take
   before `text-subtle` on top of it drops below 4.5:1.
3. **Selection is teal everywhere**: the border of the chosen thumbnail, the active tab's rail,
   a pressed toggle (fill), switch, slider, progress, drag indicator. Selected rows and tabs also
   carry a `ring-accent/40` hairline: the tint alone, in light, is barely one shade below the
   dialog.
4. **Tertiary text doesn't exist in light.** The sheet has two grays and `#5c7089` is already at
   4.57:1 on `bg-muted`: a third, lighter gray fails AA. `text-subtle` equals `muted-foreground`
   in light; the hierarchy comes from size and weight.
5. The per-content-type badges come from the sheet: presentations = orange, video = amber,
   image = green, audio = teal, Bible = Primary (light) / Secondary (dark). They're painted as a
   20% tint with `text-foreground` on top.

### Fill, ink and AA — the `-ink` ramp

A color token has **two incompatible roles**: as a **fill** (`bg-danger` with white on top) it
has to be dark so the white is readable; as **text** on `bg-card` it has to be light to be
readable itself. That's why there's a second family, `--color-<tone>-ink`, for the five tones
that appear as standalone text or icon. Each one is its sheet color lightened (dark) or darkened
(light) just enough to pass 4.5:1 on the worst surface it lands on:

| Token | Dark | Light |
|---|---|---|
| `danger-ink` | `#eb7979` (red + 40% white, 5.09) | `#dd1f1f` as-is (4.53 on `#f5f6f9`) |
| `accent-ink` | `#78a8b2` (teal + 30%, 5.42) | `#356f7b` (teal − 15%, 5.24) |
| `success-ink` | `#7caf64` (green + 30%, 5.51) | `#3a781c` (green − 15%, 5.00) |
| `warning-ink` | `#ffa92d` as-is (7.39) | `#8c5d19` (amber − 45%, 5.26) |
| `badge-audio-ink` | = `accent-ink` | = `accent-ink` |

(`accent-ink` was called `primary-ink` when blue was both action and selection.)

The other direction is measured too: **a fill with white text on top has to pass 4.5:1**. The
sheet's green gives 4.14 and the teal 4.32, so `success` is `#3f821e` (−8%) and `accent` is
`#3a7b88` (−6%) — to the eye they're the same color. Amber never carries white (1.92:1): its
`warning-foreground` is the sheet's dark text (7.59:1). The monitor's «No logo set» banner
violated this the first time this palette was applied, because it wrote `text-white` for any
tone.

Dark is the default (`DEFAULT_SETTINGS['ui.theme']` in `shared/types/settings.ts`) — meant to be
operated in a dark projection booth.

### Shape, focus, elevation and motion

- **Pill** for everything that acts or marks: `Button`, `IconButton` (circle), `Badge`, `Switch`,
  the segments and the sidebar of `Tabs`. Dialogs `rounded-2xl`; cards, groups (`FieldGroup`),
  menus and popovers `rounded-xl`; fields, thumbnails and rows `rounded-lg`. A surface never
  contains a radius larger than its own.
- **Focus = `outline`** with the `focus-ring` / `focus-ring-inset` utilities from `globals.css`,
  never `ring` + `ring-offset`: Tailwind paints the offset gap with an explicit color (white by
  default), and in the dark theme every focused control had a 1 px white halo. The gap of an
  `outline-offset` is transparent on any surface. `-inset` is for what lives inside something
  that clips (tabs, thumbnail grids, lists).
- **A pressed toggle is FILLED with accent** (`toggled` on `Button`/`IconButton`). It used to be
  a ring in the focus color: «it's on» and «it has the keyboard» looked the same. The TopBar's
  three projector states (LOGO / BLACK / LIVE) are `outline` and the active one fills with teal.
- **Resting surfaces are flat** (`shadow-surface` = nothing): the sheet draws its boxes with a
  border and no shadow. `raised` and `overlay` remain, in navy and softer in the light theme.
- **Motion**: `--ease-enter`/`--ease-exit`; the modal and its scrim enter in 150 ms
  (`wa-modal-enter`/`wa-backdrop-enter`), with no exit animation on purpose — a dialog that's
  closing shouldn't keep taking focus or clicks. Everything decorative goes through
  `motion-safe:` (the pulse of the LIVE dot, the linked audio's pulse, the skeleton, the
  spinner). The PROJECTOR's transitions don't: those are content, not interface (see the note in
  `globals.css`).
- A modal's scrim is `bg-scrim`: black at 60% in dark, navy at 40% in light.
- **Out of room, the text gives way, never the icon** (owner's rule, 2026-10-22). `Icon` and
  `Badge` are `shrink-0` by default; text truncates in its own `<span className="truncate">` —
  `Button` (`truncateText()`) and `Tabs` do it on their own. Equal-width tabs (`folder`,
  `segment`) show the full name as `title` on hover, only if it's cut off.

## Typography: Noto Sans and its ExtraCondensed cut

Noto Sans for everything the operator reads; **Noto Sans ExtraCondensed**
(`font-stretch-extra-condensed`, 62.5%) for titles — `Title` h1/h2 (the SCHEDULE / PREVIEW / LIVE
headers and the Settings groups), modal titles (`ModalTitle`) and the wordmark. A condensed cut
reads smaller than its size, which is why h2 goes up to 15 px where a text label would be 14.

Both come from the SAME variable file: `main.tsx` imports
`@fontsource-variable/noto-sans/wdth.css` (axes `wdth` 62.5–100% + `wght`), not the package's
default import, which only brings `wght` — with that one, `font-stretch` does nothing and the
browser synthesizes a fake condensed. The projection keeps the default import: the stage doesn't
use the condensed cut. All self-hosted, no Google Fonts: the app is usable without internet from
the first render.

## The brand inside the app

`components/ui/brand.tsx`: `BrandMark` (the logo SVG, as `<img alt="">` — it's an asset, its
colors are the logo's and not the theme's, and it's the only place where a hex is legitimate) and
`Wordmark` («Lumina / Live» in ExtraCondensed ExtraBold, line height 0.858 as on the sheet,
«Live» in `text-brand-live`). It appears in two places, by the owner's decision: the symbol to the
left of the TopBar and the header of **Settings ▸ About** (logo, name, version, logs). The logo's
square is `#162231`, the same background as the dark theme: without a border only the flame was
visible, floating. That's why `BrandMark` carries a 1 px inner outline in `brand-edge` (in dark,
the same `#384f69` as the primary button's border, for the same reason; in light, transparent).
Never on the projector: with LOGO and no logo chosen the stage stays black; the congregation sees
the church's brand and not the software's.

App icons, generated from the same SVG: `build/icon.icns` (macOS, Apple's grid: an 824 px body
with a ~22% radius and the template's shadow) and `build/icon.png` (Windows/Linux, the sheet's
shape with a 3% margin; electron-builder derives the `.ico` from it). They were rendered with an
offscreen Electron window (the `paint` event, which does keep the alpha) and `iconutil`.

## Forms: `FieldGroup`/`FieldRow`, and `ColorField`

`FieldGroup` + `FieldRow` (`components/ui/field.tsx`) are the shape of ANY options screen: a
title, a box with dividing lines and one row per option — label (with an optional description)
on the left, its control on the right, never wrapping. They were born inside Settings as
`SettingsGroup`/`SettingsRow` and moved up to `ui/` when the Timers scene editor became the
second consumer: it's literally the `CLAUDE.md` reuse rule firing. You add an option to an
existing group, or open a new group; never a flat list of rows.

`ColorField` is the color control. It picks from the Lumina Live sheet's swatches (neutrals,
blues, accent, indicators and the flame, with the sheet's EXACT values and not the interface's
AA-adjusted ones: on the projector the color belongs to the brand) or accepts a custom hex, and
**only emits `#rrggbb`** — a single canonical form, because two spellings of the same color in
the database is a comparison that fails over a value the operator never sees. It opens its
popover through a portal with `computeMenuPosition`, same as `Select` and `Menu`, because every
panel and every dialog in this app clips its overflow.

The hex values in `color-field.tsx`, in `DEFAULT_SCENE_STYLE` and in `DEFAULT_BIBLE_STYLE`
**don't violate** the "no hardcoded colors in a component" rule —and since 2026-10-22 they also
come from the Lumina Live sheet; a scene saved earlier keeps its own—: they're CONTENT values,
stored in a row and editable by the operator —the same category as a schedule's name—, and they
end up in an inline `style` on the projector's stage, which has no theme. An INTERFACE color
still always comes from a semantic token.

`Slider` (`components/ui/slider.tsx`) is the range with its value next to it. The number's width
is in **`ch`** and not in pixels (`readoutChars`): with `tabular-nums` one `ch` is exactly one
digit, so a box as long as the longest string that slider can produce carries no dead space —
and dead space inside the item adds to the row's `gap`, which is the bug measured in
[`.claude/knowledge/fixed-width-readout-inflates-flex-gap.md`](../../.claude/knowledge/fixed-width-readout-inflates-flex-gap.md).

### `components/shared/style-fields.tsx` — the knobs for everything that gets DRESSED

`SceneStyle` was designed to dress three things (timer scenes, the Overlays plates and the Bible
verse). The controls for what those three share —solid/gradient/image background, typography,
vertical alignment, and the four knobs of a text role— live here, not inside the scene editor
where they were born. Each one is a bare `FieldRow`: the `FieldGroup` is supplied by whoever uses
them, so one editor can give the background its own group and another can interleave it among
its rows.

The labels moved with them, from `scenes.*` to **`style.*`**. Two features spelling «Background
type» from two dictionary entries is exactly how the two spellings start to drift apart.

## The Bible verse — `BibleScene` and auto-fit

`components/shared/bible-scene.tsx` draws the `bible` variant of `ProjectionOutput`, which now
travels **dressed**: it carries its `BibleStyle` and its `backgroundUrl` resolved inside, for the
same reason a timer scene carries them — the projection window resolves nothing, and
`projection-state.ts` replays that value as-is in a window rebuilt on another screen.

It's a sibling of `TimerScene` and deliberately **not** a generalization of it: a countdown is a
short run of glyphs that never breaks a line, and a verse is a PARAGRAPH. Hence the four fields
`SceneStyle` doesn't have —`textAlign`, `lineHeight`, `maxWidthCqw` and `autoFit`— and two text
roles named for what they are (`text`, `reference`) instead of bent onto
`value`/`title`/`message`.

**Auto-fit is MEASURED, not computed.** Juan 11:35 is two words and Ester 8:9 is eighty: at a
fixed size, one gets lost in the middle of the frame and the other runs off the bottom — and the
confidence monitor, which renders the same component with the same aspect ratio, clips it the
same way, so it isn't visible from the booth either. `useFittedTextSize` runs a seven-step binary
search writing the `font-size` straight onto the element (a measurement needs the browser to have
already laid out; seven `setState` calls would be seven frames of shrinking text) and only
commits the ANSWER to state. Two details that aren't optional:

- the **block** is measured, not the paragraph: the reference is in the same bounded box and the
  verse can't push it off the stage;
- it's measured against the **space**, not against the block's own overflow. The block is bounded
  by `max-h-full`, so until it reaches that ceiling its height IS its content's height, and then
  `scrollHeight > clientHeight` no longer asks «it doesn't fit on the stage» but «there's ink
  outside its line boxes» — which a `line-height` below the font's content area (1.362 em in
  Noto Sans; the slider goes down to 0.8) makes true at ANY size. With that, the binary search
  never found a size that fit and always returned `minSizeCqw`: the verse shrank on its own and
  the four «Verses» sliders looked dead. It's compared against the stage's content box, with
  1 px of tolerance because `clientHeight`/`scrollHeight` are integers rounded from a fractional
  layout. `overflow-hidden` stays, but now only as the guard that prevents painting outside the
  frame. Diagnosis and measurements in
  [`.claude/knowledge/a-content-sized-box-never-fits-itself-so-scrollheight-is-not-a-fit-test.md`](../../.claude/knowledge/a-content-sized-box-never-fits-itself-so-scrollheight-is-not-a-fit-test.md);
- the `ResizeObserver` observes the **stage**, not the block. Observing the block is a loop by
  construction: the callback changes the font size, which changes the block, which fires the
  callback.

The block also keeps a fixed vertical margin (`EDGE_GUTTER_CQW`, the vertical equivalent of
`maxWidthCqw`): without it a shrunk verse fits the frame EXACTLY, and on a projector with
overscan that means the first and last lines cut in half.

## Control window layout — EasyWorship 2009

`components/pages/layout/AppShell.tsx` is the whole workspace, copied from EasyWorship 2009:

```
┌ TopBar (grid-cols-3, same as the main below) ──────────────────────────┐
│ ⚙ · [schedule name · saved · 💾 ✚ 📂]  │  ▷ GO LIVE  │ LOGO·BLACK·▷LIVE │
├───────────────┬──────────────┴────────┬─────────────────────────────────┤
│ SCHEDULE      │ PREVIEW               │  LIVE                           │
│ (schedule)    │ (monitor)             │  (monitor)                      │
│───────────────│ (+ media bar)         │  (+ deck/verse transport)       │
│ RESOURCES     │ slides/verses of the  │  (+ live media panel)           │
│ Bible|Media|  │ item in preview       │  slides/verses on air           │
│ Functions     │                       │                                 │
└───────────────┴───────────────────────┴─────────────────────────────────┘
```

The `TopBar` is a **3-column grid identical to the `<main>`'s** below it (`grid-cols-3`), so each
group of controls sits exactly above the column it acts on, regardless of the window's width:

- **Column 1** (above Schedule/Resources): the Lumina Live symbol, the gear icon (Settings) and
  the current schedule's card — name, Saved/Not saved badge, and three buttons (quick save, new
  schedule, manage saved schedules) that open `pages/programs/ProgramsModal.tsx`.
- **Column 2** (above Slides): a single **GO LIVE** button that calls
  `lib/actions/playback.ts::goLive()` — it sends what's in preview to the projector, replacing
  whatever was there. It's the only way to cross from preview to live; there's no second
  equivalent button anywhere else.
- **Column 3** (above Monitors): three mutually exclusive buttons — **LOGO**, **BLACK**,
  **LIVE** — that call `setOverlay('logo'|'black'|'none')` **directly** (not `toggleOverlay`:
  each one always forces its own state, it never "un-checks" when pressed again). They're the
  three possible states of what the projector shows on top of the base content. The B/L keyboard
  shortcuts still use `toggleOverlay` (behavior unchanged).

The three columns of the `<main>` are **`grid-cols-3`** — equal widths; none of the three tasks
(browse, assemble, broadcast) weighs visually more than the others. The line between columns is
the `bg-border` background showing through a `gap-px`, **never `divide-x`**: a divider is a border
INSIDE the column and only two of the three carry it, so the PREVIEW monitor ended up 1 px
narrower than the LIVE one and everything below it misaligned with its twin
([diagnosis](../../.claude/knowledge/monitor-stage-must-size-by-width-not-flex.md)). There's no
StatusBar or "projector connected/disconnected" indicator in the TopBar — CLEAR, screen
selection and opening/closing the projection, the light/dark theme and the language all moved to
`pages/settings/SettingsModal.tsx`, behind the gear icon that replaces the app's title.

That modal is a category panel in the style of macOS System Settings, not a flat list: `Modal
size="2xl" height="tall"` (a large fixed height — switching category never resizes the dialog)
with `Tabs variant="sidebar"` on the left (`components/ui/tabs.tsx`, the same primitive as
`resources/`, with a third, vertical variant) and, on the right, a scrollable panel with one
`sections/<name>-section.tsx` per category. Inside each section, `FieldGroup` + `FieldRow`
(in `components/ui/`, promoted there when the scene editor became the second user) group related
rows into a card with dividers; each row follows the usual rule: label (+ optional description)
on the left, control(s) on the right, no wrap. Today's categories: **Projection** (screen,
open/close the window, logo, clear live content, transition, starting volume), **Slides** (the slides'
text fallback face, the cache and PDF rasterizing quality), **Verses** (how a verse is DRESSED, with its 16:9 preview on top),
**Bible** (which versions are installed: import, rename, default, delete), **System** (theme,
language, folders, performance) and **About** (logo, version and logs folder). A new setting goes
into an existing group or creates one inside its section — a category isn't added without need.

«Verses» and «Bible» are two categories and not one with tabs, which is how they started: the
style is a single `settings` key with a preview that wants the whole panel, and the versions are
a table. The version list is drawn with the SAME `FieldRow`s as the rest of Settings (wrapped in
`<li>` inside a `<ul class="divide-y">`), not with the dense `ListRow` of the resource panels: a
32 px row among 60 px rows is what made that screen read like a different application. That's
why `FieldRow` accepts a `label` that is a node (the rename `<Input>` takes the name's place,
without changing the row's height) and a `leading` for the icon. The badges («Included»,
«Default») go next to the name, never in the actions column: they're variable-width, and from
there they shifted the three buttons to a different `x` on each row.

`go-live-bar.tsx` no longer exists: the `GO LIVE` that used to live between the LIVE and PREVIEW
monitors is now the button in column 2 of the TopBar, and that's why the preview paging arrows
it had (manual ↑/↓) don't exist either — the center column already lets you click any slide or
verse, and the keyboard arrows (↑/↓, global shortcut) cover the same thing.

### Screen and projection startup

`stores/display.store.ts` replaces the old `use-displays.ts` hook: it lists the screens, resolves
which one to use (the one persisted in `settings['projection.displayId']`, if it's still
connected; otherwise, the first non-primary one) and exposes `open()/close()`. The app calls
`open()` automatically at startup (`app/App.tsx`) — **the projection window opens on its own and
starts on BLACK**, never showing the last content from a previous service. The operator
cuts/restarts it from Settings, not manually from the TopBar.

- **`schedule/`**: the order of service. Click = preview, double click = live, drag = reorder.
- **`resources/`**: a single tabbed browser for **everything** projectable, Bible included
  (`variant="folder"` of `Tabs`). An asset can be previewed and projected without being in the
  schedule — that's what EW's resources area does.
- **`slides/`**: the grid of what the item in preview can put on screen — the slides of a deck,
  the verses of a chapter, or the file itself if it's a single one. It's also the only place that
  triggers conversions (`useDeck`). Everything that can grow —a deck's slides, a chapter's
  verses— is painted with **`VirtualGrid`**, with the geometry in
  `components/ui/slide-grid.geometry.ts`: gap 12, minimum width 144 for verses and **2 fixed
  columns** for a deck (`columns`, mutually exclusive with `minItemWidth`), so that a PPT's slides
  look large instead of a small N-column grid. `SlideGrid` (`slide-grid.tsx`) remained only for
  single-tile grids that never grow: the scheduled verse, a text item, a standalone asset.
- **`monitors/`**: the LIVE monitor on top (the `Monitor` primitive; the PREVIEW one moved to the
  center column, next to what it previews), below it the `deck-transport.tsx` and
  `verse-transport.tsx` transports and `live-media-panel.tsx` as sibling rows —never as the
  monitor's footer, so they can't shrink the stage, and never inside the scrolling body: the row
  right under each monitor has to land on the same pixel as its twin across, for every kind of
  content, which `media.spec.ts` asserts. The media panel caps itself at 40% of the column and
  scrolls on its own—, and at the end `live-content-grid.tsx`: the same grid as the center, but of
  what **is on air**. Clicking a tile calls `gotoSlide()`/`projectVerse()` and jumps there
  instantly (this is live, not preview: there's no second stage), and the grid **follows** the
  projector on its own (`scrollToIndex` of `VirtualGrid`), auto-advance included — virtualized, a
  tile outside the mounted window doesn't exist, so without that a long deck would leave the
  operator looking at a part of the service that has already passed. It's a different component
  from `deck-slides.tsx`, which navigates the deck *in preview*, not the one on air.

### Two-stage flow (strict)

Selecting **never** projects. `lib/actions/preview.ts` moves the preview target and
`lib/actions/playback.ts::goLive()` is the only path to `projection.store`. The preview cursor
(`stores/preview.store.ts`) is independent from the live cursor, so you can set up slide 7 while
slide 3 is still on screen.

The shortcuts follow the same split: ←/→ move **what's live**, ↑/↓ move **the preview**, Enter
crosses from one to the other.

### `OutputView`, the primitive that keeps a monitor from lying

`components/shared/output-view.tsx` renders a `ProjectionOutput` and is used by **all three**
places where content is shown: the projection window (`mode="live"`) and the LIVE and PREVIEW
monitors (`mode="monitor"`). Text sizes are in `cqw` over a container (`@container`), not in
`vw`, so the same markup scales from a 240px monitor to a 4K projector without variants. The
preview monitor is literally the projection renderer fed with a different input
(`lib/hooks/use-preview.ts::usePreviewOutput`).

## `presentation.html` → `ProjectionApp.tsx`

The same 6 relevant content types from the legacy (`black`, `logo`, `image`, `video`, `bible`,
`text`) plus `slide` (an already-rasterized image of the deck). The legacy `text` type had no
caller — here it does (`ProgramItemDTO` with `kind:'text'`), so it stopped being a dead feature.
