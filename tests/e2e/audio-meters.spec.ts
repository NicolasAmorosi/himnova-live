// The audio strips' meters (owner, 2026-11-15, plan §2 «Medidores»): each one shows what its bus is HEARD at, after
// every fader, from both players: the media engine's sessions (main) and Chromium's own elements (the projector's,
// and PREVIEW's in the control window). Read off the meter itself (`data-level-db-l`/`-r`, what its canvas drew),
// against a 1 kHz tone whose sample peak is −12 dBFS: with the feature broken, the meter stays at «-inf».
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MediaAsset } from "../../src/shared/types/media";
import { ffmpegBinary } from "./support/paths";
import { expect, test, type WorshipApp } from "./support/app";

const TONES_DIR = path.join(os.tmpdir(), "worship-e2e-meter-tones");
const TONE_DB = -12;
const STRIPS = { live: "Sonido de EN VIVO", preview: "Sonido de PREVIEW" } as const;

/** The tone, 30 s, as Chromium plays it (`.wav`; `.mp4` with FLAC, a video) and as only the engine does (an AVI with
 *  PCM): lossless everywhere, so −12.0 is what every player must read. Its own folder, not the suite's fixtures:
 *  `global-setup.ts` empties those whenever their version moves. */
function tone(name: "tone.wav" | "tone.avi" | "tone.mp4"): string {
  const file = path.join(TONES_DIR, name);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(TONES_DIR, { recursive: true });
  const amplitude = 10 ** (TONE_DB / 20);
  const sine = `${amplitude}*sin(2*PI*1000*t)`;
  const audio = ["-f", "lavfi", "-i", `aevalsrc=${sine}|${sine}:s=48000:d=30`];
  const picture = ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=30"];
  const encode = {
    "tone.wav": [...audio, "-c:a", "pcm_s16le"],
    "tone.avi": [...picture, ...audio, "-shortest", "-c:v", "mpeg4", "-c:a", "pcm_s16le"],
    "tone.mp4": [...picture, ...audio, "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "flac"],
  }[name];
  const partial = `${file}.part${path.extname(file)}`;
  execFileSync(ffmpegBinary(), ["-hide_banner", "-loglevel", "error", "-y", ...encode, partial]);
  fs.renameSync(partial, file);
  return file;
}

async function add(app: WorshipApp, kind: "video" | "audio", name: "tone.wav" | "tone.avi" | "tone.mp4"): Promise<MediaAsset> {
  const [asset] = await app.invoke<MediaAsset[]>("library:add", { kind, paths: [tone(name)] });
  if (!asset) throw new Error(`${name} was not imported`);
  return asset;
}

/** What a strip's meter drew last, left and right («-inf» at its floor). */
async function meter(app: WorshipApp, bus: "live" | "preview"): Promise<[number, number]> {
  const column = bus === "live" ? app.liveColumn() : app.previewColumn();
  const canvas = column.getByRole("group", { name: STRIPS[bus] }).locator("canvas");
  const read = async (side: "l" | "r") => {
    const value = await canvas.getAttribute(`data-level-db-${side}`);
    return value === null || value === "-inf" ? -Infinity : Number(value);
  };
  return [await read("l"), await read("r")];
}

/** Until the meter reads `db` ±1 on both sides; what it read, for the log. */
async function reads(app: WorshipApp, bus: "live" | "preview", db: number, what: string): Promise<void> {
  await expect
    .poll(async () => (await meter(app, bus)).every((side) => Math.abs(side - db) <= 1), { message: `${bus} at ${db} dB (${what})` })
    .toBe(true);
  console.log(`[audio-meters] ${what}: ${bus} ${JSON.stringify(await meter(app, bus))}`);
}

/** Until the meter has fallen to its floor (it falls 24 dB a second, as a mixer's does). */
async function silent(app: WorshipApp, bus: "live" | "preview", what: string): Promise<void> {
  await expect.poll(() => meter(app, bus), { message: `${bus} silent (${what})`, timeout: 10_000 }).toEqual([-Infinity, -Infinity]);
}

const master = (app: WorshipApp) => app.liveColumn().getByRole("slider", { name: "Volumen general de EN VIVO" });
const liveMute = (app: WorshipApp) =>
  app.liveColumn().getByRole("group", { name: STRIPS.live }).getByRole("button", { name: "Silenciar EN VIVO" });

test("LIVE's meter hears the engine through every fader: −12 at 100 %, −18 at 50 %, nothing muted or under NEGRO", async ({ app }) => {
  const avi = await add(app, "video", "tone.avi");
  await expect.poll(async () => (await app.invoke<number[]>("engine:assets")).includes(avi.id), { timeout: 30_000 }).toBe(true);
  await app.previewFile("Videos", "tone");
  await app.goLive();
  await app.projector();
  await reads(app, "live", TONE_DB, "engine video, 100 %");
  // PREVIEW gave its engine to LIVE and is silent.
  expect(await meter(app, "preview")).toEqual([-Infinity, -Infinity]);

  await master(app).fill("50");
  // 20·log10(0.5) = −6.02 dB: the item's linear level, never mpv's cubic one.
  await reads(app, "live", TONE_DB - 6, "engine video, 50 %");
  await liveMute(app).click();
  await silent(app, "live", "engine video, muted");
  await liveMute(app).click();
  await reads(app, "live", TONE_DB - 6, "engine video, unmuted");
  await master(app).fill("100");
  await reads(app, "live", TONE_DB, "engine video, 100 % again");

  // NEGRO pauses the video, and with it its sound.
  await app.control.locator("body").press("b");
  await silent(app, "live", "engine video under NEGRO");
  await app.control.locator("body").press("b");
  await reads(app, "live", TONE_DB, "engine video uncovered");
});

test("LIVE's meter hears the projector's own elements through their volume, and again after a mute", async ({ app }) => {
  await add(app, "video", "tone.mp4");
  await add(app, "audio", "tone.wav");
  await app.previewFile("Videos", "tone");
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(() => projector.evaluate(() => document.querySelector("video")?.paused)).toBe(false);
  await reads(app, "live", TONE_DB, "Chromium video, 100 %");
  await app.control.locator("body").press("b");
  await silent(app, "live", "Chromium video under NEGRO");

  // Background music plays through NEGRO.
  await app.previewFile("Audios", "tone");
  await app.goLive();
  await expect.poll(() => projector.evaluate(() => document.querySelector("audio")?.paused)).toBe(false);
  await reads(app, "live", TONE_DB, "Chromium audio, 100 %");
  await master(app).fill("50");
  // The element plays at 0.5; its copy is measured before that volume, so the meter applies it.
  await reads(app, "live", TONE_DB - 6, "Chromium audio, 50 %");
  // A muted element's copy stays silent for good: the meter has to take a new one.
  await liveMute(app).click();
  await silent(app, "live", "Chromium audio, muted");
  await liveMute(app).click();
  await reads(app, "live", TONE_DB - 6, "Chromium audio, unmuted");
});

test("PREVIEW's meter hears PREVIEW at its own volume, from the engine and from its own video, and LIVE hears none of it", async ({ app }) => {
  await add(app, "audio", "tone.wav");
  await add(app, "video", "tone.mp4");
  const fader = app.previewColumn().getByRole("slider", { name: "Volumen de PREVIEW" });
  const play = () => app.previewColumn().getByRole("button", { name: "Reproducir" }).click();

  // An audio file in PREVIEW plays through PREVIEW's engine.
  await app.previewFile("Audios", "tone");
  await play();
  await fader.fill("100");
  await reads(app, "preview", TONE_DB, "PREVIEW engine, 100 %");
  expect(await meter(app, "live")).toEqual([-Infinity, -Infinity]);
  await fader.fill("0");
  await silent(app, "preview", "PREVIEW engine at 0");

  // A video Chromium plays sounds in this window's own element (0 again with every new item).
  await app.previewFile("Videos", "tone");
  await play();
  await expect(fader).toHaveValue("0");
  await fader.fill("100");
  await reads(app, "preview", TONE_DB, "PREVIEW video, 100 %");
  expect(await meter(app, "live")).toEqual([-Infinity, -Infinity]);
  await fader.fill("0");
  await silent(app, "preview", "PREVIEW video at 0");
});
