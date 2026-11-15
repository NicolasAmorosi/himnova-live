// Where each bus sounds (plan 2026-11-15 §2 «Salidas», F3a): the output chosen for LIVE moves every element of the
// projector and every live engine session, PREVIEW's moves this window's elements and PREVIEW's engine, and the NDI®
// sound is captured from LIVE's output only (D6). Measured where it can be: the projector's elements report their
// `sinkId`, the NDI sender's own capture of LIVE's output (its `levelDb`) hears a tone only when it really plays
// there, and on Linux two null sinks are recorded while each bus plays. Unplugging is unit-tested
// (`tests/renderer/audio-route.test.ts`).
import { execFileSync, spawn } from "node:child_process";
import type { Page } from "@playwright/test";
import type { MediaAsset } from "../../src/shared/types/media";
import { ffmpegBinary } from "./support/paths";
import { audioStates, expect, test, type WorshipApp } from "./support/app";

type Output = { deviceId: string; label: string; isDefault: boolean };

const STRIP = { live: "Sonido de EN VIVO", preview: "Sonido de PREVIEW" } as const;
const OUTPUT = { live: "Salida de EN VIVO", preview: "Salida de PREVIEW" } as const;
const UNUSABLE = /no se puede usar|no está conectada/;

/** This computer's outputs as the control window's Chromium lists them, and whether each is the default's device. */
function outputsOf(app: WorshipApp): Promise<Output[]> {
  return app.control.evaluate(async () => {
    const list = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audiooutput");
    const fallback = list.find((device) => device.deviceId === "default");
    return list
      .filter((device) => device.deviceId !== "default" && device.deviceId !== "communications" && device.label !== "")
      .map((device) => ({ deviceId: device.deviceId, label: device.label, isDefault: device.groupId === fallback?.groupId }));
  });
}

function outputButton(app: WorshipApp, bus: "live" | "preview") {
  const column = bus === "live" ? app.liveColumn() : app.previewColumn();
  return column.getByRole("group", { name: STRIP[bus] }).getByRole("button", { name: new RegExp(`^${OUTPUT[bus]}`) });
}

/** The strip's output menu, as the operator chooses. */
async function choose(app: WorshipApp, bus: "live" | "preview", label: string): Promise<void> {
  await outputButton(app, bus).click();
  await app.control.getByRole("menu", { name: OUTPUT[bus] }).getByRole("menuitemradio", { name: label, exact: true }).click();
}

/** `sinkId` of every media element of a window. */
function sinks(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLMediaElement>("audio, video")].map((element) => element.sinkId));
}

/** Main's own line for where the engine plays («[audio] engine output: LIVE …, PREVIEW …»), the last one. */
function engineRoute(app: WorshipApp): string | null {
  return app.log.filter((line) => line.includes("[audio] engine output:")).at(-1) ?? null;
}

/**
 * A non-default output both Chromium and the engine can use, chosen for LIVE; null when this computer has none.
 * The Mac this was written on lists a Teams device mpv cannot open (amber, skipped) and Zoom's, which it can.
 */
async function liveOnAnotherOutput(app: WorshipApp): Promise<Output | null> {
  await expect.poll(async () => (await outputsOf(app)).length, { timeout: 5_000 }).toBeGreaterThan(0);
  const candidates = (await outputsOf(app)).filter((output) => !output.isDefault);
  console.log(`[audio-outputs] outputs: ${JSON.stringify(await outputsOf(app))}`);
  for (const output of candidates) {
    await choose(app, "live", output.label);
    // Resolved within a moment (the previous choice's amber may linger for it): the engine's name in main's log, or
    // the strip's amber word for a refusal.
    await app.control.waitForTimeout(1000);
    const verdict = await expect
      .poll(async () => {
        const live = engineRoute(app)?.match(/LIVE (\S+),/)?.[1];
        if (live && live !== "default") return "ok";
        return UNUSABLE.test((await outputButton(app, "live").getAttribute("aria-label")) ?? "") ? "unusable" : "pending";
      })
      .not.toBe("pending")
      .then(
        () => (engineRoute(app)?.match(/LIVE (\S+),/)?.[1] ?? "default") !== "default" ? "ok" : "unusable",
        () => "pending",
      );
    console.log(`[audio-outputs] LIVE on «${output.label}»: ${verdict} (${engineRoute(app)})`);
    if (verdict === "ok") return output;
  }
  return null;
}

/** The NDI output on with its sound, and a reader of its capture's level (dBFS, the loudest of each second); null
 *  without an NDI runtime. */
async function ndiLevel(app: WorshipApp): Promise<(() => Promise<number>) | null> {
  await app.invoke("settings:set", { "ndi.output.audio": true, "ndi.output.audioDelayMs": 0, "ndi.output.enabled": true });
  const status = () => app.invoke<{ state: string; audio?: { levelDb: number | null } | null }>("ndi:getStatus");
  await expect.poll(async () => (await status()).state, { timeout: 30_000 }).toMatch(/sending|runtime-missing/);
  if ((await status()).state === "runtime-missing") return null;
  return async () => (await status()).audio?.levelDb ?? -120;
}

/** A stereo tone (Zoom's virtual device on macOS will not open for a mono one, measured 2026-11-15), as the media
 *  engine plays it: an AVI with a picture, or a WMA. */
function stereoTone(app: WorshipApp, file: string, kind: "video" | "audio"): Promise<MediaAsset[]> {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  if (kind === "video") args.push("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=20");
  args.push("-f", "lavfi", "-i", "sine=frequency=440:duration=20", "-ac", "2");
  if (kind === "video") args.push("-shortest", "-c:v", "mpeg4", "-c:a", "libmp3lame");
  else args.push("-c:a", "wmav2");
  execFileSync(ffmpegBinary(), [...args, file]);
  return app.invoke<MediaAsset[]>("library:add", { kind, paths: [file] });
}

test("LIVE on another output: the projector's elements play there, and so does the engine, NDI hearing only that output", async ({ app }, testInfo) => {
  test.setTimeout(150_000);
  const output = await liveOnAnotherOutput(app);
  test.skip(output === null, "this computer has no second output both sides can open");
  // LIVE moved, so PREVIEW went apart: main got both at once. Fails if PREVIEW's half arrives alone and main applies
  // «LIVE old, PREVIEW apart» first (the NDI capture restarted twice, 2026-11-15 audit).
  expect(app.log.filter((line) => line.includes("[audio] engine output: LIVE default, PREVIEW default (apart)"))).toEqual([]);
  const level = await ndiLevel(app);

  // A file Chromium plays: the projector's <audio> plays through the chosen output.
  await app.addMedia("audio", "song.mp3");
  await app.previewFile("Audios", "song");
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await audioStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.3);
  // Fails if the projector never applies the route, or applies an id its own Chromium does not know.
  await expect.poll(() => sinks(projector)).toEqual([output!.deviceId]);
  // PREVIEW stays on the default: this window's elements are PREVIEW's.
  expect((await sinks(app.control)).every((sink) => sink === "")).toBe(true);
  if (level) {
    // NDI captures LIVE's output only (D6, PREVIEW apart): it hears the tone because it plays THERE.
    await expect.poll(level, { timeout: 10_000 }).toBeGreaterThan(-40);
    console.log(`[audio-outputs] NDI with LIVE's tone on «${output!.label}»: ${await level()} dB`);
  }

  // Off the air, then PREVIEW audible on the default: the NDI sound stays silent (PREVIEW apart).
  await app.liveColumn().getByRole("button", { name: "Detener" }).click();
  await expect.poll(async () => (await audioStates(projector)).length).toBe(0);
  if (level) await expect.poll(level, { timeout: 10_000 }).toBeLessThan(-80);
  await app.addMedia("video", "clip.mp4");
  await app.previewFile("Videos", "clip");
  await app.previewColumn().getByRole("slider", { name: "Volumen de PREVIEW" }).fill("60");
  await app.previewColumn().getByRole("button", { name: "Reproducir" }).click();
  await expect.poll(async () => (await sinks(app.control)).length).toBeGreaterThan(0);
  expect((await sinks(app.control)).every((sink) => sink === "")).toBe(true);
  if (level) {
    await app.control.waitForTimeout(2500);
    const quiet = await level();
    console.log(`[audio-outputs] NDI while PREVIEW sounds on the default: ${quiet} dB`);
    expect(quiet).toBeLessThan(-80);
  }
  await app.previewColumn().getByRole("button", { name: "Pausar" }).click();

  // A file the engine plays, previewed and taken live: the handover moves PREVIEW's engine to LIVE's output.
  const [avi] = await stereoTone(app, testInfo.outputPath("tone-stereo.avi"), "video");
  if (!avi) throw new Error("import failed");
  await expect.poll(async () => (await app.invoke<number[]>("engine:assets")).includes(avi.id), { timeout: 30_000 }).toBe(true);
  await app.previewFile("Videos", "tone-stereo");
  await app.goLive();
  expect(engineRoute(app)).toMatch(/LIVE (?!default)\S+, PREVIEW default \(apart\)/);
  if (level) {
    // Fails if the taken engine stays on PREVIEW's output: the NDI capture of LIVE's would hear nothing.
    await expect.poll(level, { timeout: 10_000 }).toBeGreaterThan(-40);
    console.log(`[audio-outputs] NDI with an engine video taken from PREVIEW: ${await level()} dB`);
  }
});

test("PREVIEW on another output: this window's elements play there, the projector's stay on LIVE's", async ({ app }) => {
  await expect.poll(async () => (await outputsOf(app)).length, { timeout: 5_000 }).toBeGreaterThan(0);
  const output = (await outputsOf(app)).find((candidate) => !candidate.isDefault && !/teams/i.test(candidate.label));
  test.skip(!output, "this computer has no second output");
  await choose(app, "preview", output!.label);
  await expect.poll(() => engineRoute(app) ?? "", { timeout: 5_000 }).toMatch(/PREVIEW (?!default)\S+ \(apart\)/);

  await app.addMedia("video", "clip.mp4");
  await app.previewFile("Videos", "clip");
  await app.previewColumn().getByRole("slider", { name: "Volumen de PREVIEW" }).fill("60");
  await app.previewColumn().getByRole("button", { name: "Reproducir" }).click();
  await expect.poll(async () => (await sinks(app.control)).filter((sink) => sink === output!.deviceId).length).toBeGreaterThan(0);
  expect((await sinks(app.control)).every((sink) => sink === output!.deviceId)).toBe(true);

  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await sinks(projector)).length).toBeGreaterThan(0);
  expect((await sinks(projector)).every((sink) => sink === "")).toBe(true);
});

test("an output the engine cannot open is not used: LIVE stays whole on the default and its strip says why", async ({ app }) => {
  await expect.poll(async () => (await outputsOf(app)).length, { timeout: 5_000 }).toBeGreaterThan(0);
  // macOS's Teams device: Chromium can, mpv cannot (`.claude/knowledge/an-audio-output-is-named-differently-…`).
  const teams = (await outputsOf(app)).find((candidate) => /Microsoft Teams Audio/.test(candidate.label));
  test.skip(!teams, "no output here that only one side can open");
  await choose(app, "live", teams!.label);
  await expect(outputButton(app, "live")).toHaveAccessibleName(/no se puede usar: suena por la predeterminada/);
  await expect(outputButton(app, "live")).toHaveClass(/text-warning-ink/);
  await expect(app.control.getByText(/Microsoft Teams Audio.* no se puede usar\. Suena por la predeterminada del sistema\./)).toBeVisible();

  await app.addMedia("audio", "song.mp3");
  await app.previewFile("Audios", "song");
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await audioStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.3);
  // Fails if Chromium plays there while the engine's files would go elsewhere: one bus, one device.
  expect(await sinks(projector)).toEqual([""]);
});

test.describe("an output the engine loses", () => {
  // Every output reaches the engine under a name it has not (`--unopenable-engine-outputs`): the real engine, playing
  // a real file, says it cannot open it, as it does for a device unplugged or one mpv cannot drive.
  test.use({ chromiumArgs: ["--unopenable-engine-outputs"] });

  test("turns LIVE's strip amber, sends the bus whole to the default, and is tried again when chosen again", async ({ app }, testInfo) => {
    test.setTimeout(120_000);
    await expect.poll(async () => (await outputsOf(app)).length, { timeout: 5_000 }).toBeGreaterThan(0);
    const output = (await outputsOf(app)).find((candidate) => !candidate.isDefault && !/teams/i.test(candidate.label));
    test.skip(!output, "this computer has no second output");
    const lost = () => app.log.filter((line) => /\[audio\] engine output: LIVE \S+\/NOPE,/.test(line)).length;
    await choose(app, "live", output!.label);
    await expect.poll(lost).toBe(1);
    // Nothing plays yet, so nothing has failed.
    await expect(outputButton(app, "live")).not.toHaveClass(/text-warning-ink/);

    const [avi] = await stereoTone(app, testInfo.outputPath("tone-stereo.avi"), "video");
    if (!avi) throw new Error("import failed");
    await expect.poll(async () => (await app.invoke<number[]>("engine:assets")).includes(avi.id), { timeout: 30_000 }).toBe(true);
    await app.previewFile("Videos", "tone-stereo");
    await app.goLive();
    // Fails if the engine's `audio-out` never reaches the control window: the strip stayed calm while the room heard
    // nothing (the 2026-11-15 final review).
    await expect(outputButton(app, "live")).toHaveAccessibleName(/no se puede usar: suena por la predeterminada/, { timeout: 10_000 });
    await expect(outputButton(app, "live")).toHaveClass(/text-warning-ink/);
    await expect.poll(() => engineRoute(app)).toMatch(/LIVE default,/);
    await expect(app.control.getByText(/no se puede usar\. Suena por la predeterminada del sistema\./)).toHaveCount(1);

    // Chosen again in the menu: tried again (it was refused for the session), and refused again by the engine.
    await choose(app, "live", output!.label);
    await expect.poll(lost).toBe(2);
    await expect.poll(() => engineRoute(app), { timeout: 10_000 }).toMatch(/LIVE default,/);
    await expect(outputButton(app, "live")).toHaveClass(/text-warning-ink/);
  });
});

/** Stops (or resumes) every media engine the app runs: one that never answers, as a spare stuck at launch would. */
function signalEngines(app: WorshipApp, signal: "SIGSTOP" | "SIGCONT"): number[] {
  // `comm` is the whole path, spaces kept: the package's runs inside «Himnova Live.app».
  const pids = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" })
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)?.slice(1) ?? [])
    .filter(([, ppid, comm]) => Number(ppid) === app.mainPid && /media-engine(\.exe)?$/.test(comm ?? ""))
    .map(([pid]) => Number(pid));
  for (const pid of pids) process.kill(pid, signal);
  return pids;
}

test("an engine that answers late never splits LIVE: the bus waits whole on the default, then moves whole", async ({ app }, testInfo) => {
  test.skip(process.platform === "win32", "SIGSTOP");
  test.setTimeout(120_000);
  const output = await liveOnAnotherOutput(app);
  test.skip(output === null, "this computer has no second output both sides can open");
  const engineName = engineRoute(app)?.match(/LIVE (\S+),/)?.[1];
  await choose(app, "live", "Predeterminada del sistema");
  await expect.poll(() => engineRoute(app)).toMatch(/LIVE default/);

  // Something Chromium plays live, long enough to outlast the wait: the projector's element shows where LIVE sounds.
  const wav = testInfo.outputPath("long-tone.wav");
  execFileSync(ffmpegBinary(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=90", "-ac", "2", wav]);
  await app.invoke("library:add", { kind: "audio", paths: [wav] });
  await app.previewFile("Audios", "long-tone");
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await audioStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.3);
  expect(await sinks(projector)).toEqual([""]);

  expect(signalEngines(app, "SIGSTOP").length).toBeGreaterThan(0);
  try {
    await choose(app, "live", output!.label);
    // Main gives up waiting (~6 s) and the strip says the bus waits: still whole on the default. Fails if the late
    // engine is taken for an engine-7, which put the projector on the chosen output and the engine on the default.
    await expect(outputButton(app, "live")).toHaveAccessibleName(/Preparando la salida elegida: mientras tanto suena por la predeterminada/, {
      timeout: 15_000,
    });
    expect(await sinks(projector)).toEqual([""]);
    expect(engineRoute(app)).toMatch(/LIVE default/);
  } finally {
    signalEngines(app, "SIGCONT");
  }
  // It answers: both sides move to the chosen output, with nothing plugged or chosen again.
  await expect.poll(() => sinks(projector), { timeout: 15_000 }).toEqual([output!.deviceId]);
  await expect.poll(() => engineRoute(app)?.match(/LIVE (\S+),/)?.[1]).toBe(engineName);
  await expect(outputButton(app, "live")).not.toHaveClass(/text-warning-ink/);
});

/** The loudest sample a sink's monitor records in `seconds` (dBFS, −120 for none). */
function recordPeak(sink: string, seconds: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("parec", ["-d", `${sink}.monitor`, "--format=s16le", "--rate=48000", "--channels=2", "--raw"]);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", reject);
    setTimeout(() => child.kill(), seconds * 1000);
    child.once("exit", () => {
      const pcm = Buffer.concat(chunks);
      let peak = 0;
      for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
      resolve(peak ? Math.round(200 * Math.log10(peak / 32768)) / 10 : -120);
    });
  });
}

test.describe("Linux: two null sinks, recorded", () => {
  test.skip(process.platform !== "linux", "null sinks are PulseAudio's and PipeWire's");
  const SINKS = { live: "himnova_live", preview: "himnova_preview" } as const;
  const LABELS = { live: "Himnova-LIVE", preview: "Himnova-PREVIEW" } as const;
  let modules: string[] = [];

  test.beforeAll(() => {
    modules = (["live", "preview"] as const).map((bus) =>
      execFileSync("pactl", ["load-module", "module-null-sink", `sink_name=${SINKS[bus]}`, `sink_properties=device.description=${LABELS[bus]}`])
        .toString()
        .trim(),
    );
  });
  test.afterAll(() => {
    for (const module of modules) execFileSync("pactl", ["unload-module", module]);
  });

  test("LIVE sounds only in LIVE's output and PREVIEW only in PREVIEW's, Chromium's files and the engine's alike", async ({ app }, testInfo) => {
    test.setTimeout(150_000);
    const loud = -40;
    const silent = -70;
    const both = async (what: string) => {
      const [live, preview] = await Promise.all([recordPeak(SINKS.live, 2.5), recordPeak(SINKS.preview, 2.5)]);
      console.log(`[audio-outputs] ${what}: LIVE's sink ${live} dB, PREVIEW's sink ${preview} dB`);
      return [live, preview] as const;
    };
    await expect.poll(async () => (await outputsOf(app)).map((output) => output.label), { timeout: 10_000 }).toContain(LABELS.preview);
    await choose(app, "live", LABELS.live);
    await choose(app, "preview", LABELS.preview);
    await expect
      .poll(() => engineRoute(app) ?? "", { timeout: 10_000 })
      .toMatch(new RegExp(`LIVE \\w+/${SINKS.live}, PREVIEW \\w+/${SINKS.preview} \\(apart\\)`));

    // A file Chromium plays, live.
    const wav = testInfo.outputPath("tone-stereo-wav.wav");
    execFileSync(ffmpegBinary(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=20", "-ac", "2", wav]);
    await app.invoke("library:add", { kind: "audio", paths: [wav] });
    await app.previewFile("Audios", "tone-stereo-wav");
    await app.goLive();
    const projector = await app.projector();
    await expect.poll(async () => (await audioStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.5);
    let [live, preview] = await both("Chromium's .wav live");
    expect(live).toBeGreaterThan(loud);
    expect(preview).toBeLessThan(silent);
    await app.liveColumn().getByRole("button", { name: "Detener" }).click();

    // A file the engine plays: previewed (PREVIEW's engine, on PREVIEW's output), audible, then taken live.
    const [avi] = await stereoTone(app, testInfo.outputPath("tone-stereo.avi"), "video");
    if (!avi) throw new Error("import failed");
    await expect.poll(async () => (await app.invoke<number[]>("engine:assets")).includes(avi.id), { timeout: 30_000 }).toBe(true);
    await app.previewFile("Videos", "tone-stereo");
    await app.previewColumn().getByRole("slider", { name: "Volumen de PREVIEW" }).fill("100");
    await app.previewColumn().getByRole("button", { name: "Reproducir" }).click();
    await app.control.waitForTimeout(800);
    [live, preview] = await both("the engine's .avi in PREVIEW");
    expect(live).toBeLessThan(silent);
    expect(preview).toBeGreaterThan(loud);

    await app.goLive();
    await app.control.waitForTimeout(800);
    [live, preview] = await both("the same engine taken live (GO LIVE)");
    expect(live).toBeGreaterThan(loud);
    expect(preview).toBeLessThan(silent);
    await app.liveColumn().getByRole("button", { name: "Sacar del aire" }).first().click();

    // A file Chromium plays, in PREVIEW.
    await app.addMedia("video", "clip.mp4");
    await app.previewFile("Videos", "clip");
    await app.previewColumn().getByRole("slider", { name: "Volumen de PREVIEW" }).fill("100");
    await app.previewColumn().getByRole("button", { name: "Reproducir" }).click();
    await app.control.waitForTimeout(800);
    [live, preview] = await both("Chromium's .mp4 in PREVIEW");
    expect(live).toBeLessThan(silent);
    expect(preview).toBeGreaterThan(loud);
  });
});
