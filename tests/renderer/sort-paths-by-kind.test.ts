/**
 * `sortPathsByKind` — a Media tab's «Agregar» (and a drop on its grid) sends
 * each file to its own tab and counts what no tab takes (owner, 2026-11-06).
 */
import { expect, test } from "vitest";
import { sortPathsByKind } from "@renderer/lib/dnd";

test("a mixed pick lands each file under its own kind, and the rest is counted", () => {
  const { byKind, unsupported } = sortPathsByKind([
    "/m/clip.MP4",
    "/m/photo.png",
    "C:\\m\\song.mp3",
    "/m/Himno 1.pptx",
    "/m/notas.txt",
    "/m/sin-extension",
  ]);
  expect(Object.fromEntries(byKind)).toEqual({
    video: ["/m/clip.MP4"],
    image: ["/m/photo.png"],
    audio: ["C:\\m\\song.mp3"],
    ppt: ["/m/Himno 1.pptx"],
  });
  expect(unsupported).toBe(2);
});

test("the extension is the file's, never a dot in a folder's name", () => {
  const { byKind, unsupported } = sortPathsByKind(["/m/fotos.png/leeme", "C:\\v.mp4\\mp4"]);
  expect(byKind.size).toBe(0);
  expect(unsupported).toBe(2);
});
