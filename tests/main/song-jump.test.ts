/**
 * Live jumps to a section: the next time it is sung, Shift the previous one,
 * and a section that is not there sung as a detour that → leaves at the slide
 * after the one it left.
 */
import { describe, expect, test } from "vitest";
import { jumpTo, linesAt, stepSong, type SongPosition } from "../../src/shared/song-jump";
import { parseLyrics, songDeckSlides } from "../../src/shared/song-text";
import type { ResolvedSong } from "../../src/shared/types/song";

const { sections } = parseLyrics(
  "[Estrofa 1]\nv1a\n\nv1b\n[Estrofa 2]\nv2\n[Coro]\nc\n[Puente]\np1\n\np2\n[Final]\nf",
  "es",
);
// v1 v1 | c | v2 | c   — the bridge and the ending are not in the order.
const song: ResolvedSong = { id: 1, title: "", sections, slides: songDeckSlides(sections, ["v1", "c1", "v2", "c1"]) };
const at = (slideIndex: number): SongPosition => ({ slideIndex, detour: null });
const chorus = { type: "chorus" as const, number: null };

describe("a jump", () => {
  test("goes to the next time the section is sung, Shift to the previous one", () => {
    expect(jumpTo(song, at(1), chorus, 1)).toEqual(at(3));
    expect(jumpTo(song, at(3), chorus, 1)).toEqual(at(5));
    expect(jumpTo(song, at(5), chorus, -1)).toEqual(at(3));
    expect(jumpTo(song, at(4), { type: "verse", number: 1 }, -1)).toEqual(at(1));
    expect(jumpTo(song, at(1), { type: "verse", number: 2 }, 1)).toEqual(at(4));
  });

  test("a section that is not ahead is sung as a detour", () => {
    expect(jumpTo(song, at(4), { type: "bridge", number: null }, 1)).toEqual({
      slideIndex: 4,
      detour: { sectionKey: "b1", slideIndex: 1, returnTo: 4 },
    });
    // The chorus once more, after its last time in the order.
    expect(jumpTo(song, at(5), chorus, 1)?.detour?.sectionKey).toBe("c1");
    // A verse the song does not have goes nowhere.
    expect(jumpTo(song, at(1), { type: "verse", number: 7 }, 1)).toBeNull();
  });

  test("→ walks the detour and then carries on after where it left; ← goes back onto it", () => {
    let position = jumpTo(song, at(2), { type: "bridge", number: null }, 1)!;
    expect(linesAt(song, position)).toEqual(["p1"]);
    position = stepSong(song, position, 1)!;
    expect(linesAt(song, position)).toEqual(["p2"]);
    position = stepSong(song, position, 1)!;
    expect(position).toEqual(at(3));
    expect(linesAt(song, position)).toEqual(["c"]);

    const back = stepSong(song, jumpTo(song, at(2), { type: "ending", number: null }, 1)!, -1);
    expect(back).toEqual(at(2));
  });

  test("a jump from inside a detour still returns to the order where it left", () => {
    const bridge = jumpTo(song, at(4), { type: "bridge", number: null }, 1)!;
    const ending = jumpTo(song, bridge, { type: "ending", number: null }, 1)!;
    expect(ending.detour).toEqual({ sectionKey: "e1", slideIndex: 1, returnTo: 4 });
    expect(stepSong(song, ending, 1)).toEqual(at(5));
  });

  test("the order's own ends stop → and ←", () => {
    expect(stepSong(song, at(5), 1)).toBeNull();
    expect(stepSong(song, at(1), -1)).toBeNull();
  });
});
