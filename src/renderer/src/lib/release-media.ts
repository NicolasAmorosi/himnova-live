/**
 * Lets go of a media element's player now, not at the next garbage collection. An unmounted `<video>`/`<audio>`
 * that still has its `src` keeps its whole player alive — demuxer, decoder, buffered data — until V8 collects
 * the element: measured 2026-11-12, one player pending per live video, ~30–48 MB per renderer. Clearing `src`
 * and calling `load()` is the HTML spec's way to tear the player down at once. A frozen frame must be captured
 * BEFORE this: afterwards the element has no picture.
 */
export function releaseMedia(element: HTMLMediaElement): void {
  element.pause();
  element.removeAttribute("src");
  element.load();
}
