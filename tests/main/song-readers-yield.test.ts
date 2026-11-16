/**
 * Importing a songbook of song files lets main go between files (2026-11-15 audit, A24): 1200 OpenLyrics files read
 * in one go held main ~0.1 s on an SSD (more from a pen drive or a share), and with it the engine's frames and NDI.
 * Counted as event-loop turns during the read, not as milliseconds: the machine may be busy with something else.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { readOpenLyricsFiles } from "../../src/main/songs/openlp";
import { readSongTextFiles } from "../../src/main/songs/text-files";

const N = 1200;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "song-readers-yield-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const verse = (n: number) =>
  `<verse name="v${n}"><lines>Sublime gracia del Señor<br/>que a un pecador salvó<br/>fui ciego mas hoy veo yo</lines></verse>`;
const openLyrics = (i: number) => `<?xml version="1.0" encoding="UTF-8"?>
<song xmlns="http://openlyrics.info/namespace/2009/song" version="0.8" createdIn="OpenLP 2.4.6">
  <properties><titles><title>Canción ${i}</title></titles><verseOrder>v1 v2 v3</verseOrder></properties>
  <lyrics>${[1, 2, 3].map(verse).join("")}</lyrics>
</song>`;
const chordPro = (i: number) =>
  `{title: Canción ${i}}\n\n{start_of_verse}\n[G]Sublime gracia del [C]Señor\nque a un [D]pecador salvó\n{end_of_verse}\n`;

function write(extension: string, body: (i: number) => string): string[] {
  return Array.from({ length: N }, (_, i) => {
    const file = path.join(dir, `s${i}.${extension}`);
    fs.writeFileSync(file, body(i));
    return file;
  });
}

/** How many times the event loop came round while `read` ran, and its longest stop, in ms. */
async function turnsDuring<T>(read: () => Promise<T>): Promise<{ result: T; turns: number; longest: number }> {
  let turns = 0;
  let longest = 0;
  let last = performance.now();
  let done = false;
  const tick = () => {
    if (done) return;
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    turns += 1;
    setImmediate(tick);
  };
  setImmediate(tick);
  const result = await read();
  done = true;
  longest = Math.max(longest, performance.now() - last);
  return { result, turns, longest };
}

test("1200 OpenLyrics files are read with main let go between them", async () => {
  const files = write("xml", openLyrics);
  const { result, turns, longest } = await turnsDuring(() => readOpenLyricsFiles(files));
  console.info(`[A24] OpenLyrics x${N}: ${turns} turns, longest stop ${longest.toFixed(1)} ms`);
  expect(result.songs).toHaveLength(N);
  expect(turns).toBeGreaterThan(N / 2);
});

test("1200 ChordPro files are read with main let go between them", async () => {
  const files = write("cho", chordPro);
  const { result, turns, longest } = await turnsDuring(() => readSongTextFiles(files, "es"));
  console.info(`[A24] ChordPro x${N}: ${turns} turns, longest stop ${longest.toFixed(1)} ms`);
  expect(result.songs).toHaveLength(N);
  expect(turns).toBeGreaterThan(N / 2);
});
