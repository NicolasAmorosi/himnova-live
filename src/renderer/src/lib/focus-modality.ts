/**
 * The element that took focus from a pointer press, if the focused one did.
 *
 * Enter, Space and the arrows on a button mean two different things depending
 * on how the operator got there. Reached with Tab, they are that button's own
 * keys. Clicked, they are not: Chromium focuses a button on click, so after
 * touching «Pause» or a resource tile, Enter pressed that button again instead
 * of going live, which is the one key an operator presses blind — and after
 * clicking GO LIVE itself, → no longer moved the verse or the slide that had
 * just gone live, and Space pressed GO LIVE again (a new scene: the video and
 * the deck's music back to 0). `:focus-visible` cannot tell the two apart here.
 * Chromium flips it to true on the very keydown being handled, already in the
 * capture phase (measured 2026-10-14). So the modality is recorded when focus
 * moves instead.
 *
 * Its own module because two places ask: the global shortcuts, and
 * `VirtualGrid`, whose tiles are buttons with arrow keys of their own.
 */
let pointerFocused: EventTarget | null = null;
let pointerDown = false;

/** Installs the listeners and returns their cleanup. Always on, modal or not:
 *  what matters is how the focused element got its focus, whenever that was. */
export function trackFocusModality(): () => void {
  const onPointerDown = () => {
    pointerDown = true;
  };
  const onPointerUp = (e: PointerEvent) => {
    pointerDown = false;
    // A press on the element that ALREADY had focus moves nothing, so no
    // `focusin` records it: a tile reached with the arrows and then clicked
    // kept the keyboard's modality, and Enter pressed the tile again.
    const active = document.activeElement;
    if (active && e.target instanceof Node && active.contains(e.target)) pointerFocused = active;
  };
  const onPointerCancel = () => {
    pointerDown = false;
  };
  const onFocusIn = (e: FocusEvent) => {
    // Focus coming BACK to the element the mouse focused is the window being
    // reactivated (Alt/⌘-Tab, the taskbar, a click on the projector and back):
    // no key moved it, so it keeps the mouse's modality. Read as keyboard, the
    // tile or tab clicked before switching away swallowed the arrows again.
    if (e.target === pointerFocused) return;
    pointerFocused = pointerDown ? e.target : null;
  };
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerCancel, true);
  window.addEventListener("focusin", onFocusIn, true);
  return () => {
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", onPointerCancel, true);
    window.removeEventListener("focusin", onFocusIn, true);
  };
}

export function isPointerFocused(target: EventTarget | null): boolean {
  return target !== null && target === pointerFocused;
}
