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

## Identity: Himnova Live

Since 2026-11-11 the product is called **Himnova Live** (*himno* + *nova*, «a new song», Ps 96:1); it was
**Lumina Live** from 2026-10-22 to 2.7.2, whose identity replaced the Adventist palette (ALPS/Denim) of earlier
versions. The rename changed the **mark and the wordmark**; the **UI palette stays the one of the 2026-10-22
identity sheet** (an Illustrator PDF: palette per mode, logo + wordmark), with what reading its internals found:

- The **light mode Secondary** is labeled `#2f557f` (same as the Primary) but drawn `#213c59`. The drawn value wins.
- The sheet's typeface is **Noto Sans ExtraCondensed** (ExtraBold for titles, SemiBold for labels): the same family
  as the app's text, in another width. It still sets the app's titles.

**The mark (2026-11-11, «Colofón»):** Literata's capital H re-cut by hand — the crossbar raised to 73 % and its
underside an arch, so the letter is a door («Castillo fuerte es nuestro Dios», Ps 100:4); optical corrections (a
crossbar thinner than the stems, the arch overshooting like Literata's «O»). Foil gold `#c6a15b` on navy (6.6:1); on
white old gold `#8c6a2e` (5.0:1) — foil gold there is 2.4:1. The **wordmark** is «[H]imnova Live»: the mark is the
name's raised initial, then «imnova Live» in Literata, outlined, in the text's colour. Two more drawings, hinted to the
pixel: a 20 px one (the toolbar) and a 32 × 24 one (16/32/48 px, the OS icons). Red and teal never enter the brand.
The sources (every variant, the round-by-round concepts, the OS icons' generator) are maintainer notes, outside
this repo.

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

1. **The dark Primary is the sheet's navy `#2f557f`, the light theme's** (owner, 2026-11-05): the
   dark theme's own `#203651` sat 1.31:1 from the background and «Guardar» read only by its edge.
   Now 2.09:1, white on it 7.7:1; it still carries `border-primary-border` (`#3b5f87`, Primary →
   Secondary at 15%, also its hover). In light that token equals the fill and adds nothing.
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

- **Four radii, GitHub's** (owner, 2026-11-04: «a GitHub feel… not so heavily rounded»; values read
  from Primer's tokens). `rounded-md` (6 px) for everything that acts or contains — `Button`,
  `IconButton` (a square, not a circle), fields, `Switch` (a rounded rectangle), the segments, rows,
  thumbnails, `Card`/`Callout`/`FieldGroup`/`MediaPanel` boxes, tooltips, toasts. `rounded-xl` (12) for
  what floats: the centred `Dialog`, menus and dropdowns. `rounded-sm` (4) for something small inside
  something else (a thumbnail's number, a swatch, the inner segment of a segmented box).
  `rounded-full` only for what is NOT a control: `Badge` (GitHub's `Label` is a pill too — the song
  order's chips are `Badge`s), status dots, progress bars, slider and scrubber thumbs. The sidebar of
  `Tabs` is GitHub's NavList: a 32 px row, the chosen one on a quiet fill with a 4 px accent bar on its
  left. `rounded-lg`, `rounded-2xl`, the bare `rounded` and any `rounded-[…]` but the logo's are retired
  — `tests/renderer/radius-scale.test.ts` fails on them. A surface never contains a radius larger than
  its own.
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
  `motion-safe:` (the linked audio's pulse, the skeleton, the
  spinner). The PROJECTOR's transitions don't: those are content, not interface (see the note in
  `globals.css`).
- A modal's scrim is `bg-scrim`: black at 60% in dark, navy at 40% in light.
- **Out of room, the text gives way, never the icon** (owner's rule, 2026-10-22). `Icon` and
  `Badge` are `shrink-0` by default; text truncates in its own `<span className="truncate">` —
  `Button` (`truncateText()`) and `Tabs` do it on their own. Tabs show the full name as `title`
  on hover, only if it's cut off. The resource tabs (`underline`) share the row equally and drop their icons in a
  window under 1100 px; a `segment` has no icons at all — the 2026-11-04 locale tour found «Presentaciones» cut at
  1440 and «Canciones»/«Funciones» at the 1000 px minimum (`tools/release-checks/locale-tour/` in the workspace).

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

`components/ui/brand.tsx`: `BrandMark` (the 20 px drawing inline, `currentColor`, in `text-muted-foreground`: on the
toolbar it is a signature in the icons' grey, never a coloured button — the only colour on that bar is ON-AIR red) and
`Wordmark` (the lockup inline: the initial in `fill-brand-mark`, gold on dark and old gold on light, the words in
`currentColor`; `role="img"`, named «Himnova Live»; `font-size` sets its height). The mark sits at the left of the
TopBar; the wordmark alone heads **Settings ▸ About** and the welcome's rail (never mark + wordmark side by side:
the wordmark already starts with the mark).
Never on the projector: with LOGO and no logo chosen the stage stays black; the congregation sees
the church's brand and not the software's.

App icons, generated from the same SVG: `build/icon.icns` (macOS, Apple's grid: an 824 px body
with a ~22% radius and the template's shadow) and `build/icon.png` (Windows/Linux, the sheet's
shape with a 3% margin; electron-builder derives the `.ico` from it). They were rendered with an
offscreen Electron window (the `paint` event, which does keep the alpha) and `iconutil`.

## Scales: type, spacing, control heights (2026-11-04)

Written in `globals.css` next to `--text-*`. The type scale is closed — `text-2xs` (11 px, slide numbers and
counters, never a sentence), `text-xs` (12, hints), `text-dense` (13, an inspector's rows, toolbars), `text-sm`
(14, body, fields, buttons), `Title h2` (15 condensed), `ModalTitle` (20 condensed) — and body text never goes
under 13 px on the dark theme. `text-2xs` and `text-dense` are taught to tailwind-merge in `lib/utils.ts`:
unknown to it, `text-dense` reads as a colour and erases the `text-foreground` beside it (a test asserts it).
Section titles (`InspectorSection`, `FieldGroup`) are `Title h3` — 14 px semibold, sentence case, GitHub's — and
the condensed uppercase `Title h2` is kept for the three column headers and, at 20 px, an editor's title (owner,
2026-11-04). Spacing is Tailwind's 4 px step as a rule (4–8 inside a control, 8 between controls, 12–16 at a
panel's edge, 24 between groups); separate with space before boxes, and a box is a 1 px border + 6 px, no
shadow. Control heights, GitHub's: 24 (an icon inside a row), 28 (`xs`, a compact bar), **32 (`sm`, the default
of `Button`, `IconButton`, `Input`, `Select`, `ColorField`)**; 40 (`md`, `Button` only) was GO LIVE and LOGO / BLACK /
LIVE until 2026-11-06, when they went to 32 so the top bar could be a strip like the rest. Fields have no 40 any more.
**Every bar of the main window is one height, `h-strip`** (`--spacing-strip` in `globals.css`, taught to
tailwind-merge in `lib/utils.ts`): the top bar, the three columns' headers, the resource tabs and the segments under
them, a tab's search rows (the Bible tab's are two strips), a panel's footer (`min-h-strip`, it may wrap). 41 px with
its 1 px line, so a 32 px control sits 4 / 4 and a 28 px one 6 / 6; at a round 40 the 3.5 px were rounded up in some
bars and down in others (owner, 2026-11-06: «todas las líneas a un mismo tamaño»). Side edges, two values: 6 px
(`px-1.5`) for a strip of boxes (tabs, segments, search rows, footers — and panel bodies' `p-1.5`), 12 (`px-3`) for a
strip of text (the headers, and the top bar's three groups, each over its column). The cards under the monitors
(transports, `MediaTrackRow`) are content, not bars, and keep their own height. The transports under the monitors (deck,
song, verse) and the rows of `MediaTrackRow` are 32 too, both sides at once: the row under each monitor must land
on the same pixel as its twin across, so a control taller on one side misaligns both grids. A disabled FILLED button turns grey
(`disabledVariants` in `button.tsx`) instead of fading: at 60 % opacity the light theme's navy read as a
pale-blue button that could be pressed.

## Full-screen editors: `EditorScreen`, `Inspector`, `EditorStage`

Every editor in the control window (song themes, timer scenes, plates, the verse's look, the song editor, the saved
programs and Settings; `docs/plans/2026-11-04-rediseno-ui/` in the maintainer workspace) is a full-screen
`EditorScreen` (`components/shared/editor-screen/`) instead of a centred modal: a 48 px bar, and under it a list
of the things of that kind · the canvas · the inspector.

- **It is still a `Modal`**, `size="screen"` (`inset-0`, no backdrop, no frame): the stack, the focus trap, the
  inert work screen, Escape and the global shortcuts switched off (`useAnyModalOpen`) all come with it.
- **It fades in and out** (150 ms; the way out is the owner's, 2026-11-04). It is closed the instant `open` turns
  false — off the stack, focus back on the opener, the work screen usable — and only its PICTURE stays to fade:
  the children of the closing render, `inert`, `aria-hidden`, no pointer events. The editors clear their draft
  once closed, so a fade of the live children would be a blink. `ModalBoundary` remounts on each OPENING, not on
  open/close, or it would cut the fade off. A centred dialog still has no exit.
  The owner's rule (2026-11-04) is that with an editor open no key acts on the projector, remote included;
  `LiveIndicator` in the bar shows what is on air instead — the LIVE column's own heading/status and an
  `OutputView` fed `selectOutput`, with `videoStill` so the thumbnail never decodes a video. Because of it, every
  full-screen screen holds a second copy of what is projected — the logo too, when nothing is live — so a test that
  looks for projected content inside an editor's dialog must scope it to the canvas or the tab panel, or it finds two.
- **Two save models, two looks.** An editor that saves on demand passes `save`: ✕ to close, «Edited» by the
  title while dirty, «Discard» while dirty, «Save» (the screen's ONE primary button, ⌘S/Ctrl+S while focus is
  inside it), and a «⋯» `Menu` with Duplicate/Delete. Without `save`, the screen applies at once and closes with
  «← Back». The edited thing's name is an inline input in the bar (`name`), not a «Name» field.
- `Menu` without a `value` is a command menu (`menuitem`, nothing checked, options can be `disabled` or
  `tone: "danger"`). With `text` its trigger is a worded `Button` instead of an icon (Songs ▸ «Importar», a menu
  of the programs it reads).
- **`Inspector`** (`components/ui/inspector.tsx`, 352 px) folds its groups with the platform's `<details>`
  (`InspectorSection`) and sets `FieldLayoutContext` to `compact` for every `FieldRow` inside it: label in a
  fixed 7.5 rem column (the «?» glued to the label's last word, so it never sits alone on a line), the control right beside it taking the whole cell (a switch keeps its size, a slider its
  readout), and the description behind a «?» tooltip — written out, the hints made an inspector twice as long —
  still the row's description for a screen reader. The shared knobs of `style-fields.tsx` render compact in an
  inspector and spread in Settings without a prop. `layout="stacked"` puts the label on top for what is too
  wide to sit beside one. A row whose only control is a `Switch` is one wide `<label>` instead: the words across
  the row, the switch at its end, a click anywhere flips it (2026-11-05). Each section remembers whether the
  operator folded it (`localStorage`, per inspector and title), and the rarely used ones start folded
  (`defaultOpen={false}`: Traducción, Entre diapositivas, Animación, Ocultar sola, Avisos). Every row is 40 px
  (`min-h-10`), whatever its control, and a label dims with a control that is off. A section can turn the canvas
  to what it dresses when a control in it takes focus (`InspectorSection`'s `onFocus`: the footer → a slide that
  carries it, the translation → «Con traducción», a countdown's end → «Al terminar»).
- **`EditorStage`** is a look editor's canvas: the 16:9 preview as large as the window allows (capped by height
  too), its sample controls under it, and the reason «Save» is off. A sample is a STATE of the canvas, so it is
  one `Segmented` in every editor (2026-11-05): Temas «Primera · Última · Con traducción» (the footer follows the
  theme's own «show on» rule; the sample song has two stanzas and a translation), Escenas «Contando · Al
  terminar», Versículo «Versículo corto · largo». The plates' «Try the way in/out» stay buttons: they are actions. The previews (`ScenePreview`, `VersePreview`) are only the `OutputView`; the stage
  frames them. `PlatePreview` IS the plates editor's canvas, because its two tests drive the state it draws.
- **The verse's look is an editor, not a setting** (owner, 2026-11-04): the palette at the foot of the Bible tab
  opens `VerseStyleModal`, the way «Themes» opens from the Songs tab's. It applies at once (a `settings` key, see the
  note in the component), so its bar is «← Back» with nothing to save.
- **The song editor's canvas is the lyrics, not a stage** (`SongEditorModal`): the list column holds the song's
  slides as projected (`SongSlideGrid`, one tile wide), the textarea fills the middle, and the inspector starts
  with the chosen slide drawn large, then its theme, order and data. The caret and the slides go together
  (owner, 2026-11-04): the caret picks its slide on both sides and a click on a slide puts the caret at the start
  of its words. Both directions are pure (`slideAtCaret` / `caretAtSlide` in `shared/song-text.ts`, tested); the
  editor only holds the caret's offset, reported by the textarea's `onSelect` — which React fires on keys and the
  mouse, NOT on a synthetic `select` event, so a test moves the caret with a real key. Opened, a song's text is
  written so it reads back to the very same sections (`serializeLyrics`, see «Chords» and the text format in
  `05-data-and-persistence.md`), and while it is not touched the save keeps the stored sections (`SongDraft.stored`).
  «Save» off says WHICH limit (`songProblem` → `songs.limits.*`), never a generic «title and lyrics».
- **An editor with unsaved changes counts itself in** (`EditorScreen` → `holdUnsavedEditor`, `ui.store`'s
  `unsavedEditors`), so ⌘Q or closing the window asks first like the schedule does (`quitRisks`'s `editor`) — one
  place for the song, theme, scene, plate and program editors, none wiring it on its own.
- **`onNew`** puts «+ New …» at the top of the list column, one look in every editor; a new, unsaved thing is a
  plain selected row at the end of the list. «Duplicate» always saves a copy of what is SAVED and chooses it (it
  copied the draft in two editors, discarded changes included).
- **The saved programs are a screen too** (`ProgramsModal`, owner's D10): the programs on the left (search,
  favourites filter, drag to reorder, the unsaved schedule pinned on top), what the chosen one IS — its items,
  read with `programs:peek` so choosing never adopts it, drawn with the schedule's own row picture
  (`shared/program-item-thumb.tsx`) inside a `Box` that runs down to the bottom of the canvas, the song editor's
  lyrics box (rows hanging at the top of an empty canvas read as floating) — with «Open», and its favourite, notes and
  dates in the inspector; Duplicate and Delete in «⋯». The top bar's «Save» of a program never saved opens it with
  that schedule's row chosen and the caret in the name. The star in a row is saved at once and the chosen row's
  draft follows it, so it is never a pending change. Opening a program over unsaved work, and leaving a changed
  row, ask with the small `ConfirmModal` — a second question set by the first one's answer is kept, which is why
  its `onOpenChange` only clears the question it showed.

## Forms: `FieldGroup`/`FieldRow`, and `ColorField`

`FieldGroup` + `FieldRow` (`components/ui/field.tsx`) are the shape of ANY options screen: a
subtitle above (and, optionally, one line of `description` about the whole group), the rows in ONE box (`Box`: 1 px border,
6 px, the fields' surface, no shadow) between thin lines — Windows 11's and macOS's settings; borderless rows on the canvas
had «no separation from the background» (owner, 2026-11-05) — and one row per option: label (with an optional description)
on the left, its control on the right, never wrapping. Anything inside a group that is not a `FieldRow` (a preview, a
hint under a list) carries the row's `px-4` itself.

**The Settings row is one standard (2026-11-05 review):** its label in regular weight under the group's semibold
title (two levels, not one), at least 64 px tall (`min-h-16`) with or without a
description; the description is ONE short line (≤ ~70 characters in every language) and anything longer goes in
`help`, a «?» after the label with the text in a tooltip — the descriptions ran from 11 to 246 characters and the rows
were all different heights; every field (`Select`, `Input`) is the same 256 px (`w-64`, set by the row, so call sites
pass no width) and a button keeps its own; at most two buttons per row (change = `outline`, reset/remove = `ghost`);
a row that would need more controls than that opens a small dialog instead (the CCLI report's dates). Groups are 32 px
apart (`gap-8`), a group's title 8 px above its box. They were born inside Settings as
`SettingsGroup`/`SettingsRow` and moved up to `ui/` when the Timers scene editor became the
second consumer: it's literally the `CLAUDE.md` reuse rule firing. You add an option to an
existing group, or open a new group; never a flat list of rows.

`ColorField` is the color control. It picks from the 2026-10-22 identity sheet's swatches (neutrals,
blues, accent, indicators and the flame, with the sheet's EXACT values and not the interface's
AA-adjusted ones: on the projector the color belongs to the brand) or accepts a custom hex, and
**only emits `#rrggbb`** — a single canonical form, because two spellings of the same color in
the database is a comparison that fails over a value the operator never sees. It opens its
popover through a portal with `computeMenuPosition`, same as `Select` and `Menu`, because every
panel and every dialog in this app clips its overflow.

The hex values in `color-field.tsx`, in `DEFAULT_SCENE_STYLE` and in `DEFAULT_BIBLE_STYLE`
**don't violate** the "no hardcoded colors in a component" rule —and since 2026-10-22 they also
come from the 2026-10-22 identity sheet; a scene saved earlier keeps its own—: they're CONTENT values,
stored in a row and editable by the operator —the same category as a schedule's name—, and they
end up in an inline `style` on the projector's stage, which has no theme. An INTERFACE color
still always comes from a semantic token.

`Slider` (`components/ui/slider.tsx`) is the range with its value next to it, in ONE fixed 48 px box for every slider
(2026-11-05: a `ch` width per call site ended the tracks of an inspector at different x), set inline because an
inspector row stretches its children with a class that outranks one; the number shows as many decimals as the step
(«6.0» beside «2.5»). Sliders live only in inspectors, so the dead-space concern of
[`.claude/knowledge/fixed-width-readout-inflates-flex-gap.md`](../../.claude/knowledge/fixed-width-readout-inflates-flex-gap.md)
(transport rows) does not apply here.

`Select` takes an optional `action` — a command at the foot of its list, after a rule («Importar imagen…» under the
images it adds to): picking it closes the menu and runs it, and the keyboard reaches it like an option. That is how a
background's image or video is imported (owner, 2026-11-05): a button beside the field did not fit in an inspector
and read «+ A». In an inspector row (`compact`) every field stretches and a plain button beside one keeps its width.

### `components/shared/style-fields.tsx` — the knobs for everything that gets DRESSED

`SceneStyle` was designed to dress three things (timer scenes, the Overlays plates and the Bible
verse). The controls for what those three share —solid/gradient/image background, typography,
vertical alignment, and the four knobs of a text role— live here, not inside the scene editor
where they were born. Each one is a bare `FieldRow`: the `FieldGroup` is supplied by whoever uses
them, so one editor can give the background its own group and another can interleave it among
its rows.

The labels moved with them, from `scenes.*` to **`style.*`**. Two features spelling «Background
type» from two dictionary entries is exactly how the two spellings start to drift apart.

## A song — `SongScene`, drawn tiles and section colours

`SongScene` (`components/shared/song-scene.tsx`) is `BibleScene`'s sibling but measures nothing: it
draws one slide at the `sizeCqw` the output carries (see «Songs» in `04-renderer-state.md`). The same
component draws the PREVIEW and LIVE grids' tiles (owner: drawn miniatures, not text tiles), a
schedule row's picture and the measurer's off-screen stages. Margins, outline and footer are all in
`cqw`; the footer keeps its place on every slide while the theme shows it.

Each section type has a colour token (`--color-section-*`, the sheet's hues the content badges already
use): verse steel/navy, pre-chorus amber, chorus orange, bridge green, the rest neutral — a bar under
each tile, a dot on the order's chips and on the section buttons.

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

- **Column 1** (above Schedule/Resources): the Himnova Live mark, the gear icon (Settings), the
  current schedule's name as plain text, **«Save» with its word** (it was a 16 px icon), and two
  icons: new schedule, and the saved schedules (`pages/programs/ProgramsModal.tsx`).
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

Settings is a full-screen `EditorScreen` without `save` (it applies at once: «← Back»), laid out like GitHub's
settings (2026-11-04): `Tabs variant="sidebar"` in the list column (`components/ui/tabs.tsx`, NavList's look) and
the chosen section as a page in a reading column (`max-w-3xl`) CENTRED in the canvas, like every other screen's canvas
— left-aligned, all the free space sat on the right and read as broken (owner); one scrollbar at the window's edge
(`scrollbar-gutter: stable both-edges`) — a `PageHeader` (20 px, no line under it since 2026-11-05), then one
`sections/<name>-section.tsx` per category. Inside each section, `FieldGroup` + `FieldRow`: each group a titled box
of rows (see «Forms» above), 32 px from the next; each row follows the standard there. Today's categories: **Projection** (screen,
open/close the window, logo, clear live content, transition, starting volume), **Slides** (the slides'
text fallback face, the cache and PDF rasterizing quality),
**Bible** (which versions are installed: import, rename, default, delete), **System** (theme,
language, folders, performance) and **About** (logo, version and logs folder). A new setting goes
into an existing group or creates one inside its section — a category isn't added without need.

How a verse is DRESSED is not in Settings: since 2026-11-04 it is the Bible tab's verse style editor (see
«Full-screen editors» above). The version list is drawn with the SAME `FieldRow`s as the rest of Settings (wrapped in
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

- **The work screen's chrome (2026-11-04 redesign, F4):** a column header is the title plus its data in
  quiet text (`PanelHeader`'s `meta`), never a pill — only what asks the operator to act stays a
  badge (the schedule's «Not saved», a damaged slide). The panel footers are neutral (`ghost`):
  colour no longer carries meaning, and a tab's own tools — «Importar», «Temas», the verse's
  «Estilo», «Escenas», «Placas» — are icons with a tooltip (owner, 2026-11-05: «me gustan solo los
  íconos», reversing the redesign's words). «Agregar» (add to schedule) is the one with its word: an
  `outline` button at the right of each resource footer — neutral, so GO LIVE is the one strong
  button of the work screen (owner's D13). The schedule's tools are a vertical strip of icons on the
  list's right, like EasyWorship's (owner's D19, then «a la derecha»). Media and Songs share one
  filter bar (`shared/library-filter-bar.tsx`): order, folder, search, add a folder; and a folder view's
  footer starts with its refresh (`FolderRefreshButton`, owner 2026-11-06), which also reads the folder on
  screen again when the window comes back to the front — nothing watches the disk. A tooltip goes
  the moment its trigger is pressed and stays away until the pointer leaves, never shows over the menu its
  trigger opened (`aria-expanded`), and goes when the window loses focus — a native picker took the pointer
  without a `pointerleave` and left the bubble stuck (owner, 2026-11-05). Empty states carry no buttons. The transport boxes (`MediaPanel`) have no border
  of their own — the card's fill sets them apart —, an `EmptyState` shows its icon without a disc,
  everything that takes content off the projector — the transports' button, the LIVE panel's rows,
  Settings' button — is «Sacar del aire» with the `offAir` icon (owner's D12), never the ✕ that
  clears PREVIEW; a song's sections are one box everywhere (`Button outline xs`, and `Token` for
  the order's removable chips); and the LIVE monitor's «No logo» notice appears only once LOGO is pressed, in a neutral band
  (`OutputView`'s `notice` tone): resting on a missing logo is how every launch starts.
- **`schedule/`**: the order of service. Click = preview, double click = live, drag = reorder.
  Every row leads with a small 16:9 picture (`RowThumb`, since 2.2.1): the same thumbnail the
  library tile shows (`lib/asset-thumb.ts`), a deck's first slide from one `deck:statuses`
  round-trip for the whole schedule, and the kind's icon in the corner over it; with no picture
  (audio, verse, time scene, plate, a missing file) the kind's tinted icon fills the same box, so
  every row keeps one height.
- **`resources/`**: a single tabbed browser for **everything** projectable, Bible included
  (`variant="underline"` of `Tabs`, GitHub's UnderlineNav; the second level is a `segment`). An asset can be previewed and projected without being in the
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

### Toasts: every one goes, with its time drawn

Every toast leaves on its own after `TOAST_DURATION_MS` (5 s; owner, 2026-11-05: first 10, then «10 es mucho») —
the ones with an action and the «screen lost» warning included («no se van a menos que los cierres») — and a 2 px bar along its bottom edge,
in its tone's fill, empties as the time runs out. The pointer or the focus on a toast holds the count and the bar
(`pause`/`resume` in `toast.store.ts`, which keeps what was left), so reading it or reaching for «Deshacer» never
races the clock. A schedule's «Deshacer» («Quitar», «Vaciar») lives only while nothing else has changed the
schedule: the next edit takes its toast down (`offerScheduleUndo`; owner, 2026-11-06), since its undo would land in
another list. What must outlast a toast says so somewhere that stays: the LIVE header keeps «Sin pantalla» with
«Abrir pantalla» while there is no projector. A message wraps anywhere (`overflow-wrap: anywhere`): a file name or a
path has no space to break at. An info toast carries the `info` icon, never «!», and its action sits on the
message's own line.

### Two-stage flow (strict)

Selecting **never** projects. `lib/actions/preview.ts` moves the preview target and
`lib/actions/playback.ts::goLive()` is the only path to `projection.store`. The preview cursor
(`stores/preview.store.ts`) is independent from the live cursor, so you can set up slide 7 while
slide 3 is still on screen.

The shortcuts follow the same split: ←/→ move **what's live**, ↑/↓ move **the preview**, Enter
crosses from one to the other.

PREVIEW **sounds** since 2026-11-05 (owner: «todo como en vivo pero con el volumen a 0»): its row has the same
play, seek and volume as EN VIVO's — a video, an audio file, a deck's music —, at PREVIEW's own `volume`
(`preview.store`), 0 with every new target, silenced by GO LIVE (`stopPreviewPlayback`). A video plays through the
monitor's `<video>` (`OutputView`'s `audible`, which ONLY `PreviewMonitor` passes — an editor canvas drawn over the
live stage must never play the room's video twice) or PREVIEW's engine; a sound through PREVIEW's engine with no
picture (`usePreviewEngineSound`), started on the first play so a click through the library spins no engine up.
A deck in PREVIEW gets EN VIVO's transport (◀ ▶, counter, «Auto-avance») but never advances on its own.

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
