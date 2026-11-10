/**
 * `resolveLinkedAudio` — which `.mp3` beside a hymnal deck is that deck's
 * soundtrack.
 *
 * Four rules in order of confidence, and the interesting cases are the two
 * that must NOT match: the audio that merely happens to be alone in the folder
 * (a silent deck used to adopt its neighbour's music), and the tie between two
 * equally plausible candidates, where guessing means the wrong song plays in
 * front of the congregation.
 *
 * Each test gets its own directory: the resolver caches listings for 2 s.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { strToU8, zipSync } from "fflate";
import { resolveLinkedAudio } from "../../src/main/slides/linked-audio";

let root: string;
let dir: string;
let seq = 0;

beforeEach(() => {
  root ??= fs.mkdtempSync(path.join(os.tmpdir(), "worship-linked-audio-"));
  seq += 1;
  dir = path.join(root, `case-${seq}`);
  fs.mkdirSync(dir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Writes the named files and returns the deck's path. */
function folder(deckName: string, ...others: string[]): string {
  const deck = path.join(dir, deckName);
  fs.writeFileSync(deck, "not a real presentation");
  for (const name of others) fs.writeFileSync(path.join(dir, name), "not real audio");
  return deck;
}

describe("resolveLinkedAudio", () => {
  test("matches the PowerPoint convention: same base name, audio extension", () => {
    const deck = folder("Himno 125.pps", "Himno 125.mp3", "Himno 300.mp3");
    expect(resolveLinkedAudio(deck)).toBe(path.join(dir, "Himno 125.mp3"));
  });

  test("matches across case and accents", () => {
    const deck = folder("Cuán Grande Es Él.pps", "cuan grande es el.mp3");
    expect(resolveLinkedAudio(deck)).toBe(path.join(dir, "cuan grande es el.mp3"));
  });

  test("falls back to a partial title match", () => {
    const deck = folder("125 - Castillo Fuerte (cantado).pps", "Castillo Fuerte.mp3");
    expect(resolveLinkedAudio(deck)).toBe(path.join(dir, "Castillo Fuerte.mp3"));
  });

  test("an audio file alone in the folder is NOT adopted by an unrelated deck", () => {
    // The rule that was removed on purpose: a folder holding one deck with
    // audio and a sibling deck without one handed that unrelated audio to the
    // silent deck just because it was the only file there.
    const deck = folder("Himno 410.pps", "Sermon del pastor.mp3");
    expect(resolveLinkedAudio(deck)).toBeNull();
  });

  test("a MIDI file is never the deck's music: nothing can play it", () => {
    expect(resolveLinkedAudio(folder("Himno 125.pps", "Himno 125.mid"))).toBeNull();
  });

  test("a WMA beside the MIDI is", () => {
    const deck = folder("Himno 126.pps", "Himno 126.midi", "Himno 126.wma");
    expect(resolveLinkedAudio(deck)).toBe(path.join(dir, "Himno 126.wma"));
  });

  test("a folder with no audio at all resolves to null", () => {
    const deck = folder("Himno 410.pps", "Himno 411.pps");
    expect(resolveLinkedAudio(deck)).toBeNull();
  });

  test("a missing folder resolves to null rather than throwing", () => {
    expect(resolveLinkedAudio(path.join(dir, "nope", "deck.pps"))).toBeNull();
  });

  test("a link that is not valid percent-encoding does not make the deck unopenable", () => {
    // Old Office wrote «Canción» as `Canci%F3n`: a Latin-1 escape, which
    // `decodeURIComponent` refuses with a URIError.
    const rels =
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio" ' +
      'Target="file:///C:/Himnos/Canci%F3n%20100.mp3" TargetMode="External"/></Relationships>';
    const deck = path.join(dir, "100 Canción.pptx");
    fs.writeFileSync(deck, zipSync({ "ppt/slides/_rels/slide1.xml.rels": strToU8(rels) }));
    fs.writeFileSync(path.join(dir, "100 Canción.mp3"), "not real audio");
    expect(() => resolveLinkedAudio(deck)).not.toThrow();
    expect(resolveLinkedAudio(deck)).toBe(path.join(dir, "100 Canción.mp3"));
  });
});
