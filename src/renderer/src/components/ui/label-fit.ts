/**
 * A label shown short when its whole words do not fit (2026-11-15 audit, U14: «Rive…» among nine Bibles, «Present…»
 * among four tabs, at the window's narrowest). The whole label is measured on an invisible copy of it
 * (`invisible absolute whitespace-nowrap`, inside `box`) against `box`'s content box, never on the label shown: shown
 * short, it no longer says how wide the whole one is.
 */
export function labelOverflows(box: HTMLElement, wholeLabel: HTMLElement): boolean {
  const style = getComputedStyle(box);
  return wholeLabel.offsetWidth > box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
}

/** Runs `measure` now, on every resize of `box`, and once the fonts are in (a label measured in the fallback face is
 *  another width). Returns the stop. Nothing where there is no `ResizeObserver` (the unit tests' jsdom). */
export function watchLabelFit(box: HTMLElement, measure: () => void): () => void {
  if (typeof ResizeObserver === "undefined") return () => undefined;
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(box);
  let live = true;
  void document.fonts?.ready.then(() => live && measure());
  return () => {
    live = false;
    observer.disconnect();
  };
}
