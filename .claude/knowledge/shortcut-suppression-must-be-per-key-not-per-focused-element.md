## Suppressing global shortcuts by focused ELEMENT kills the keys that element never handled — and Chromium focuses a button on click

**Area:** renderer / ui (`src/renderer/src/lib/hooks/use-global-shortcuts.ts`)
**Trigger:** "the B / BLACK key stopped working", a shortcut that works only sometimes, before
adding any key to the global shortcut handler, or before choosing the focus model of a new
keyboard-driven widget (a menu, a popover, a combobox) in the control window.

Found on 2026-09-13 auditing feature #5.

### The mechanism

The handler bailed out for **every** key whenever the focus was on an interactive element:

```ts
const INTERACTIVE_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA", "BUTTON", "A"]);
if (isInteractiveTarget(e.target)) return;
```

**Chromium focuses a `<button>` when you click it** (unlike Safari/WebKit, where clicking a button
does not move focus — which is why this reads as harmless to anyone who has tested the pattern in
a browser other than the one Electron ships). So after a single click on *any* button in the app —
GO LIVE, LOGO, BLACK, save, any `IconButton` — `b`, `l`, `Delete` and `Backspace` were dead until
the operator happened to click on empty space. Nothing on screen said why.

BLACK is the control an operator reaches for when something appears that the congregation should
not see. It was unavailable for the rest of the service, silently.

### Why the rule looked right

It genuinely is right for `Enter`, `" "` and the four arrows: a button activates on Enter/Space
natively, and the arrows drive the roving tabindex of the resource grid. Those are real conflicts.
The error was generalizing from them to keys a button has no behaviour for at all.

### The rule

Decide suppression on the pair **(element, key)**, never on the element alone:

- text entry (`INPUT`/`SELECT`/`TEXTAREA`/`contentEditable`) consumes everything — anything else
  would type into it;
- a `BUTTON`/`A` consumes only what activates or navigates it (`Enter`, `" "`, the arrows);
- everything else falls through to the global shortcut.

### The other half: that table decides how a new popup must be built (2026-09-17)

The list is also a **constraint on every widget added afterwards**, and it is easy to read it as
a defensive measure only. A widget is protected from the global shortcuts exactly insofar as
`suppressesKey()` recognizes whatever holds DOM focus while it is open — and what it recognizes
for `Enter`/`" "` is `INPUT`/`SELECT`/`TEXTAREA`/`contentEditable` and `BUTTON`/`A`. Nothing else.
`ARROW_CONSUMING_ROLES` looks like it covers the rest, and it does not: it is gated on
`ARROW_KEYS.has(key)`, so a `role` **only ever suppresses the four arrows**, never Enter or Space.
`"menuitem"` is in that list; `"menuitemradio"` is not in it at all.

Building `components/ui/menu.tsx` (the sort-order button of the media library) ran straight into
it. The obvious move was to copy `Select`: keep focus on the trigger, or focus the list container,
and point at the highlighted option with `aria-activedescendant`. But `aria-activedescendant` is
not valid on `role="button"`, so the container is what would have to take focus — a
`<ul role="menu">`. Focused, that element is a `UL` with a role: `suppressesKey("Enter")` returns
**false**, and `Enter` would have picked the sort order *and* run the global `Enter` shortcut,
which is `goLive()`. Choosing how to order a folder would have sent the preview to the projector,
mid-service.

So `Menu` moves focus INTO the list, one real `<button role="menuitemradio">` per option, roving
with the arrows. It is the canonical ARIA menu pattern and it is also the only shape that lands
back inside `ACTIVATION_TAGS`.

The rule: **when adding a keyboard widget to the control window, pick the focus model by checking
`suppressesKey()` first.** If what will hold focus is not a text field, a `BUTTON` or an `A`, the
widget is unprotected for `Enter` and `" "` — and in this app `Enter` is the button that puts
something on the projector.

### Enter after a CLICK is GO LIVE; Enter after Tab is the button's (2026-10-14)

- The table above still left one trap: Chromium focuses a button on click, so after touching
  «Pause» (or a resource tile) with the mouse, Enter pressed that button again instead of going
  live. «Pause» then Enter resumed the countdown in PREVIEW; BLACK then Enter did nothing. The
  user decided: Enter on a button reached with the MOUSE is GO LIVE; on one reached with the
  keyboard it stays the button's.
- **`:focus-visible` cannot make that call.** Measured: after a real mouse press it reads `false`,
  but Chromium flips it to `true` on the very Enter keydown being handled, already in the window
  capture phase. So the modality is recorded at FOCUS time instead (in
  `lib/focus-modality.ts` since the later 2026-10-18 pass, `use-global-shortcuts.ts` before):
  `pointerdown`/`pointerup`/`pointercancel` keep a pressed flag, and `focusin` stores the target
  only when it got focus during a press (`pointerFocused`).
- **Companion rule:** the global handler returns early on `e.defaultPrevented`. A key a widget
  already handled is not a shortcut. `Select` answers Enter on its own trigger, a button the mouse
  may well have focused, and picking a Bible version must not also send the preview live.
  Verified: Enter in the open version Select left `sceneEpoch` unchanged.

### Space and the arrows after a click, too (2026-10-18)

- The Enter rule left the same trap open for the other keys a button consumes. After clicking
  GO LIVE with the mouse, → and ← did nothing: the focused button swallowed them, so a verse or a
  slide that had just gone live could not be stepped until the operator clicked empty space. Worse,
  Space natively pressed GO LIVE again, which is a new scene: the video and the deck's music go back
  to 0. Found by the review and reproduced by the E2E suite
  (`tests/e2e/bible.spec.ts`, «after clicking EN VIVO, the arrows and Space still belong to the
  operator»). The test fails without the fix.
- Now a mouse-focused button consumes none of `KEYS_A_CONTROL_CONSUMES`, and Space is
  `preventDefault`ed whenever it reaches the switch, so it can never press the clicked button.
  **Two things keep their arrows regardless:** a button with a widget role (a `tab`, which the
  role check still covers before the pointer exemption) and any widget that handles the arrow
  itself and `preventDefault`s it (`VirtualGrid`'s tiles), which the `defaultPrevented` early
  return already protects.

### …and on a thumbnail too: VirtualGrid lets go of the arrows after a click (2026-10-18, later)

- The `VirtualGrid` exception above turned out to be the same trap one level down. Its delegated
  `onKeyDown` runs before the `window` listener and `preventDefault`s every arrow, so the
  `defaultPrevented` early return meant **any** widget handler beat the modality rule. Measured with
  the E2E suite: deck live on 1, click slide 2 in PREVIEW, → — projector still on 1 (focus moved to
  the tile below); click slide 2 in the LIVE grid, → — projector stays on 2; click a library tile,
  ↓ — PREVIEW does not move.
- The user decided (2026-10-18): after a MOUSE click on a thumbnail the arrows are the operator's,
  like on any other button; the grid walks its tiles only when reached by keyboard. `VirtualGrid`
  now returns early on an arrow whose target `isPointerFocused()`. The modality moved to
  `src/renderer/src/lib/focus-modality.ts` because two places ask.
- **A second trap in the modality itself:** clicking the element that ALREADY has focus moves no
  focus, so no `focusin` fires and the keyboard's modality stuck — a tile reached with the arrows
  and then clicked swallowed Enter (native activation) instead of going live. `pointerup` now
  re-records the modality when the press landed inside `document.activeElement`.
- Covered by `tests/e2e/keyboard.spec.ts`; each test there fails on the previous build.

### The keys always work on the work screen: every clicked control, the projector window, a remote (2026-11-03)

The owner reported that the slide keys and BLACK only worked «from the right spot». Read top to
bottom, four places still swallowed them, each one a case the rules above had left open:

- **The projector window had the keyboard.** `createProjectionWindow` calls `show()` on macOS (only
  Windows gets `showInactive()`), so on a Mac the first GO LIVE/BLACK/LOGO, which opens the
  projector, took the keyboard with it — and a click on the projector's screen does the same on any
  system. That window has no handlers: → and B did nothing until the operator clicked back on the
  control window. Moving focus back from main was rejected (on one screen it raises the control
  window over a windowed projector; on macOS a fullscreen window is its own Space). Main's
  `before-input-event` on the projector forwards every key without Ctrl/⌘/Alt as `projector-key`,
  and the control window runs the same `runShortcut`.
- **A role still kept the arrows after a click.** The 2026-10-18 rule exempted clicked buttons but
  kept a `tab` (and a slider, a combobox) owning its arrows «however it got focus»: one click on
  «Biblia» and → switched the resource tab instead of the slide; one click on a deck soundtrack's
  volume or seek bar and → changed the volume or seeked. Now a pointer-focused control keeps no key
  in `suppressesKey`, and each widget that handles arrows itself returns early on
  `isPointerFocused` (`Tabs`, `MediaScrubber`, `Select`/`Menu` triggers, like `VirtualGrid`).
- **Focus put back by CODE after a mouse pick reads as the keyboard's.** `Select` and `Menu`
  re-focused their trigger on close. After a mouse pick that happens in the `click` handler, after
  `pointerup` cleared `pointerDown`, so `focusin` recorded keyboard modality: after choosing a book
  with the mouse, the combobox trigger kept ← → ↑ ↓, Enter re-opened it and a letter both
  typeaheaded and toggled BLACK/LOGO. A mouse pick now leaves focus where the click left it
  (`Menu`: refocus only when `click.detail === 0`). Extending `pointerDown` past the click was the
  other option and is a trap: `Menu` focuses its first item in an effect flushed inside that same
  click, so the item would read as clicked and Enter would `goLive()` instead of choosing.
- **Window reactivation re-recorded the modality.** Alt/⌘-Tab back fires `focusin` on the same
  element with no pointer down, turning a clicked tile into a keyboard-focused one. `focusin` on
  the element already recorded as pointer-focused now keeps it.

Also: a presentation remote is a keyboard sending PageDown/PageUp (next/back), «.» (blank screen)
and F5/Esc alternating on one button (Logitech's own table for the R400/R700/R800). PageUp/PageDown
are never suppressed, not even in a text field (nothing there pages, and the remote is in the
preacher's hand while the operator types); «.» is BLACK; F5/Esc do nothing, because an alternating
button mapped to two different actions would desynchronize on the first missed press. And held
keys: only stepping repeats — a held B flickered BLACK, a held Enter re-sent the preview live on
every repeat (a new scene each time, the video back to 0).

**Playwright cannot press a key on the projector window for this.** Its keyboard reaches a page
over CDP, which never goes through `before-input-event` (measured: the hook saw nothing). The test
uses `webContents.sendInputEvent`, which does — see `pressOnProjector` in `tests/e2e/keyboard.spec.ts`.
Covered there; the five new tests fail on the previous build.

**Last updated:** 2026-11-03
