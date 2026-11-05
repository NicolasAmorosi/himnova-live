/**
 * Where a jump to a section lands, and where → and ← go from there — pure, so
 * the keys, the section buttons and the tests ask the same function.
 *
 * Owner, 2026-11-04: a key goes to the NEXT time that section is sung in the
 * order, Shift to the previous one, and → carries on from there. A section
 * that is not ahead (or behind) in the order — the bridge nobody planned, the
 * chorus once more after the last one — is sung as a DETOUR: its slides, and
 * after its last one → returns to the slide after the one the operator was on.
 */
import type { ResolvedSong, SongSectionType } from "./types/song";

/** A detour: section `sectionKey`, at its `slideIndex` (1-based), to go back
 *  to the order's `returnTo` (1-based) once it is over. */
export type SongDetour = { sectionKey: string; slideIndex: number; returnTo: number };

/** Where the live song is: a slide of the order, or a detour off it. */
export type SongPosition = { slideIndex: number; detour: SongDetour | null };

/** What a key or a section button asks for: verse N names its number; the
 *  chorus, the bridge, the ending name their type, whichever number is next. */
export type SongJumpTarget = { type: SongSectionType; number: number | null };

function matches(target: SongJumpTarget, type: SongSectionType, number: number): boolean {
  return type === target.type && (target.number === null || target.number === number);
}

/** The pass of the order the operator is in — a detour counts from the slide
 *  it left. */
function currentPass(song: ResolvedSong, position: SongPosition): number {
  const index = position.detour?.returnTo ?? position.slideIndex;
  return song.slides[index - 1]?.pass ?? -1;
}

export function jumpTo(
  song: ResolvedSong,
  position: SongPosition,
  target: SongJumpTarget,
  direction: 1 | -1,
): SongPosition | null {
  const pass = currentPass(song, position);
  const starts = song.slides
    .map((slide, i) => ({ slide, index: i + 1 }))
    .filter(({ slide }) => slide.indexInSection === 0 && matches(target, slide.type, slide.number));
  const found =
    direction === 1
      ? starts.find(({ slide }) => slide.pass > pass)
      : [...starts].reverse().find(({ slide }) => slide.pass < pass);
  if (found) return { slideIndex: found.index, detour: null };

  // Not ahead (or behind) in the order: sung as a detour. Of the sections the
  // target can mean, the one sung last before here, else the first written.
  const candidates = song.sections.filter((section) => matches(target, section.type, section.number));
  if (candidates.length === 0) return null;
  const lastSung = [...song.slides]
    .slice(0, (position.detour?.returnTo ?? position.slideIndex))
    .reverse()
    .find((slide) => matches(target, slide.type, slide.number));
  const section = candidates.find((c) => c.key === lastSung?.sectionKey) ?? candidates[0]!;
  return {
    slideIndex: position.slideIndex,
    detour: { sectionKey: section.key, slideIndex: 1, returnTo: position.detour?.returnTo ?? position.slideIndex },
  };
}

/** → and ←, detours included. `null` when there is nowhere to go. */
export function stepSong(song: ResolvedSong, position: SongPosition, direction: 1 | -1): SongPosition | null {
  const { detour } = position;
  if (detour) {
    const length = song.sections.find((section) => section.key === detour.sectionKey)?.slides.length ?? 0;
    const next = detour.slideIndex + direction;
    if (next >= 1 && next <= length) return { slideIndex: position.slideIndex, detour: { ...detour, slideIndex: next } };
    // Off either end: back to the order — after the slide it left going
    // forward, on it going back.
    const back = direction === 1 ? Math.min(detour.returnTo + 1, song.slides.length) : detour.returnTo;
    return { slideIndex: Math.max(1, back), detour: null };
  }
  const next = position.slideIndex + direction;
  return next >= 1 && next <= song.slides.length ? { slideIndex: next, detour: null } : null;
}

/** The lines on screen at `position`. */
export function linesAt(song: ResolvedSong, position: SongPosition): readonly string[] {
  const { detour } = position;
  if (detour) {
    return song.sections.find((section) => section.key === detour.sectionKey)?.slides[detour.slideIndex - 1]?.lines ?? [];
  }
  return song.slides[position.slideIndex - 1]?.lines ?? [];
}
