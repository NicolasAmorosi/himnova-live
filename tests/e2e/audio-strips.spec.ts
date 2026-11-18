// The audio strips beside PREVIEW and LIVE (owner, 2026-11-15, sketch A; D1 to D3, D5): one strip per monitor, the
// per-row volumes gone while they are on, and LIVE's fader a master that every live level is multiplied by. What the
// projector plays and what the NDI® output carries are measured, not the strip's own number.
import { faderToGain } from "../../src/renderer/src/components/ui/fader";
import { audioStates, expect, relaunch, test, videoStates, type WorshipApp } from "./support/app";

const LIVE_STRIP = "Sonido de EN VIVO";
const PREVIEW_STRIP = "Sonido de PREVIEW";
const MASTER = "Volumen general de EN VIVO";

async function videoLive(app: WorshipApp) {
  await app.addMedia("video", "clip.mp4");
  await app.previewFile("Videos", "clip");
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await videoStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.3);
  return projector;
}

/** A column's monitor (its bordered stage) and its strip, as boxes. */
async function boxes(app: WorshipApp, column: "preview" | "live") {
  const section = column === "live" ? app.liveColumn() : app.previewColumn();
  const strip = section.getByRole("group", { name: column === "live" ? LIVE_STRIP : PREVIEW_STRIP });
  const monitor = section.locator(".aspect-video").first().locator("..");
  const [stripBox, monitorBox] = await Promise.all([strip.boundingBox(), monitor.boundingBox()]);
  const inside = await strip.evaluate((group) => {
    const outer = group.getBoundingClientRect();
    return [...group.querySelectorAll("button, input, canvas")].every((element) => {
      const r = element.getBoundingClientRect();
      return r.top >= outer.top - 0.5 && r.bottom <= outer.bottom + 0.5 && r.left >= outer.left - 0.5 && r.right <= outer.right + 0.5;
    });
  });
  const overflows = await section.evaluate((element) => element.scrollWidth > element.clientWidth);
  // The dB scale (drawn in the canvas) ends before the fader's hit area begins.
  const apart = await strip.evaluate(
    (group) => group.querySelector("canvas")!.getBoundingClientRect().right <= group.querySelector("input")!.getBoundingClientRect().left,
  );
  return { strip: stripBox!, monitor: monitorBox!, inside, overflows, apart };
}

async function windowAt(app: WorshipApp, width: number, height: number) {
  await app.electron.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      const control = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().endsWith("/index.html"));
      control?.setFullScreen(false);
      control?.unmaximize();
      control?.setContentSize(w!, h!);
    },
    [width, height],
  );
  await expect.poll(() => app.control.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(width);
}

test("with the strips on, the volume is in two strips beside two identical monitors, and in no row", async ({ app }, testInfo) => {
  await videoLive(app);
  await app.previewFile("Videos", "clip");
  // D2: the rows under both monitors carry no volume of their own.
  await expect(app.liveColumn().getByRole("slider", { name: "Posición de clip" })).toBeVisible();
  await expect(app.control.getByRole("slider", { name: "Volumen de clip" })).toHaveCount(0);
  await expect(app.liveColumn().getByRole("slider", { name: MASTER })).toHaveValue("100");
  // PREVIEW's fader IS PREVIEW's volume: 0 with every new item.
  await expect(app.previewColumn().getByRole("slider", { name: "Volumen de PREVIEW" })).toHaveValue("0");

  for (const [width, height] of [
    [1366, 768],
    [1000, 700],
  ] as const) {
    await windowAt(app, width, height);
    const preview = await boxes(app, "preview");
    const live = await boxes(app, "live");
    console.log(`[audio-strips] ${width}x${height}: monitor ${live.monitor.width.toFixed(1)}x${live.monitor.height.toFixed(1)}, strip ${live.strip.height.toFixed(1)}`);
    // The two monitors are the same size and on the same line, as without strips.
    expect(Math.abs(preview.monitor.width - live.monitor.width)).toBeLessThan(0.5);
    expect(Math.abs(preview.monitor.height - live.monitor.height)).toBeLessThan(0.5);
    expect(Math.abs(preview.monitor.y - live.monitor.y)).toBeLessThan(0.5);
    // Each strip exactly as tall as its monitor, everything of it inside, and no column scrolls sideways.
    for (const column of [preview, live]) {
      expect(Math.abs(column.strip.height - column.monitor.height)).toBeLessThan(1);
      expect(Math.abs(column.strip.y - column.monitor.y)).toBeLessThan(1);
      expect(column.inside).toBe(true);
      expect(column.apart).toBe(true);
      expect(column.overflows).toBe(false);
    }
    await app.control.screenshot({ path: testInfo.outputPath(`strips-${width}x${height}.png`) });
  }
});

/** Settings ▸ Sonido ▸ «Mostrar las tiras», to the state asked for. */
async function setStrips(app: WorshipApp, on: boolean) {
  await app.control.getByRole("button", { name: "Configuración" }).click();
  const settings = app.control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Sonido" }).click();
  const strips = settings.getByRole("switch", { name: "Mostrar las tiras" });
  if ((await strips.isChecked()) !== on) await strips.click();
  await settings.getByRole("button", { name: "Volver" }).click();
  await expect(settings).toBeHidden();
}

/** Marks each column's monitor element, so a remount (a new element) is told from a re-render. */
async function markMonitors(app: WorshipApp) {
  for (const section of [app.previewColumn(), app.liveColumn()]) {
    await section.locator(".aspect-video").first().evaluate((element) => ((element as HTMLElement & { __kept?: boolean }).__kept = true));
  }
}
async function monitorsKept(app: WorshipApp) {
  return Promise.all(
    [app.previewColumn(), app.liveColumn()].map((section) =>
      section.locator(".aspect-video").first().evaluate((element) => (element as HTMLElement & { __kept?: boolean }).__kept === true),
    ),
  );
}

test("turning the strips off and on again does not restart PREVIEW's video or remount a monitor", async ({ app }) => {
  await app.addMedia("video", "clip.mp4");
  await app.previewFile("Videos", "clip");
  await app.previewColumn().getByRole("button", { name: "Reproducir" }).click();
  const position = app.previewColumn().getByRole("slider", { name: "Posición de clip" });
  const seconds = async () => Number(await position.getAttribute("aria-valuenow"));
  await expect.poll(seconds).toBeGreaterThanOrEqual(1);
  await markMonitors(app);
  const before = await seconds();

  await setStrips(app, false);
  expect(await monitorsKept(app)).toEqual([true, true]);
  // Fails if the remount restarts the video (a jump back to ~0).
  expect(await seconds()).toBeGreaterThanOrEqual(before);
  await setStrips(app, true);
  expect(await monitorsKept(app)).toEqual([true, true]);
  expect(await seconds()).toBeGreaterThanOrEqual(before);
});

test("turning the strips off does not restart what plays LIVE", async ({ app }) => {
  const projector = await videoLive(app);
  const position = app.liveColumn().getByRole("slider", { name: "Posición de clip" });
  await expect.poll(async () => Number(await position.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(1);
  await markMonitors(app);
  const before = (await videoStates(projector))[0]?.currentTime ?? 0;
  await setStrips(app, false);
  expect(await monitorsKept(app)).toEqual([true, true]);
  // The clip may have ended by now (it is 8 s); it never goes back.
  const after = (await videoStates(projector))[0]?.currentTime ?? before;
  expect(after).toBeGreaterThanOrEqual(before);
});

test("PREVIEW at rest is calm; its headphones turn amber only once it is audible on a shared output", async ({ app }) => {
  const preview = app.previewColumn().getByRole("group", { name: PREVIEW_STRIP });
  const headphones = preview.getByRole("button", { name: "Salida de PREVIEW" });
  // At 0 the mute is the dimmed speaker, not an alarm; the headphones are not amber, but still explain themselves.
  await expect(preview.getByRole("button", { name: "Silenciar PREVIEW" })).toHaveAttribute("aria-pressed", "true");
  await expect(headphones).not.toHaveClass(/text-warning-ink/);
  await expect(headphones).toHaveAccessibleName(/También se escucha en la sala/);
  await preview.getByRole("slider", { name: "Volumen de PREVIEW" }).fill("40");
  await expect(headphones).toHaveClass(/text-warning-ink/);
});

test("with the strips off, every row has its volume back and no strip shows", async ({ app }) => {
  await app.audioStripsOff();
  await videoLive(app);
  await expect(app.liveColumn().getByRole("slider", { name: "Volumen de clip" })).toBeVisible();
  await expect(app.control.getByRole("group", { name: LIVE_STRIP })).toHaveCount(0);
  await expect(app.control.getByRole("group", { name: PREVIEW_STRIP })).toHaveCount(0);
});

test("LIVE's fader is a master: at −6 dB the projector plays each item at half its level, and back", async ({ app }) => {
  const projector = await videoLive(app);
  await app.addMedia("audio", "song.mp3");
  await app.previewFile("Audios", "song");
  await app.goLive();
  await expect.poll(async () => (await audioStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.2);
  const levels = async () => [(await videoStates(projector))[0]?.volume, (await audioStates(projector))[0]?.volume];
  expect(await levels()).toEqual([1, 1]);

  const master = app.liveColumn().getByRole("slider", { name: MASTER });
  // Three quarters of the fader, −6.2 dB on its log scale (`fader.ts`).
  const half = faderToGain(0.75);
  await master.fill("75");
  await expect.poll(levels).toEqual([half, half]);
  // Remembered as a setting, not lost with the item.
  expect((await app.invoke<Record<string, unknown>>("settings:get"))["audio.live.volume"]).toBe(half);

  // Mute is the master at 0; unmute brings back the level it had.
  const strip = app.liveColumn().getByRole("group", { name: LIVE_STRIP });
  // The button keeps its name; the state is `aria-pressed`.
  const mute = strip.getByRole("button", { name: "Silenciar EN VIVO" });
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await expect.poll(levels).toEqual([0, 0]);
  // The remembered level is untouched by the mute (a key of its own).
  expect((await app.invoke<Record<string, unknown>>("settings:get"))["audio.live.volume"]).toBe(half);
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await expect.poll(levels).toEqual([half, half]);

  // D3: with the strips off the master counts as 100 %, never a level nobody can see.
  await mute.click();
  await expect.poll(levels).toEqual([0, 0]);
  await setStrips(app, false);
  await expect.poll(levels).toEqual([1, 1]);
  // The room just heard what is live jump to 100 %: said once, with the master's 49 % kept as the starting volume
  // (review of U5; the notice names the jump, owner 2026-11-16).
  await expect(
    app.control.getByText(
      "Tiras apagadas: el volumen general de EN VIVO (49 %) pasa a ser el volumen inicial, y lo que ya está al aire vuelve al 100 %.",
    ),
  ).toBeVisible();
  expect((await app.invoke<Record<string, unknown>>("settings:get"))["media.volume"]).toBe(half);
  // And turning them on again does not silence LIVE: the mute went with them. Fails if it survives the switch.
  await setStrips(app, true);
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await expect.poll(levels).toEqual([half, half]);
});

test("a fade-out down to 0 on LIVE's fader is a mute: unmuting, and the next launch, come back to where it started", async ({
  app,
}) => {
  const master = app.liveColumn().getByRole("slider", { name: MASTER });
  await master.fill("80");
  await expect.poll(async () => (await app.invoke<Record<string, unknown>>("settings:get"))["audio.live.volume"]).toBe(faderToGain(0.8));

  // The operator holds ↓ on the fader to the bottom: one gesture, every step reported (a slow drag does the same).
  await master.focus();
  for (let step = 0; step < 85; step += 1) await app.control.keyboard.down("ArrowDown");
  await app.control.keyboard.up("ArrowDown");
  const mute = app.liveColumn().getByRole("group", { name: LIVE_STRIP }).getByRole("button", { name: "Silenciar EN VIVO" });
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  // Fails with the last step before 0 remembered (−93 dB): the room barely hears the next song, and the app opens
  // like that tomorrow (2026-11-15 audit, A8).
  expect((await app.invoke<Record<string, unknown>>("settings:get"))["audio.live.volume"]).toBe(faderToGain(0.8));
  await mute.click();
  await expect(master).toHaveValue("80");
});

test("LIVE left silent opens silent: the room hears nothing until the operator unmutes (owner, 2026-11-17)", async ({
  app,
}) => {
  await app.liveColumn().getByRole("slider", { name: MASTER }).fill("80");
  await app.liveColumn().getByRole("group", { name: LIVE_STRIP }).getByRole("button", { name: "Silenciar EN VIVO" }).click();
  await expect.poll(async () => (await app.invoke<Record<string, unknown>>("settings:get"))["audio.live.muted"]).toBe(true);
  await app.quit();

  // Fails with the mute as session state: the app opened with LIVE audible, at 80 %.
  const again = await relaunch(app);
  const mute = again.liveColumn().getByRole("group", { name: LIVE_STRIP }).getByRole("button", { name: "Silenciar EN VIVO" });
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  const projector = await videoLive(again);
  await expect.poll(async () => (await videoStates(projector))[0]?.volume).toBe(0);
  await mute.click();
  await expect(again.liveColumn().getByRole("slider", { name: MASTER })).toHaveValue("80");
  await expect.poll(async () => (await videoStates(projector))[0]?.volume).toBe(faderToGain(0.8));
});

test("the NDI output hears LIVE's fader: three quarters up, its sound is 6 dB under the top", async ({ app }) => {
  test.setTimeout(120_000);
  // The NDI output's own capture of the app's sound is the meter (`native/engine/ndi-audio.h`): the loudest sample
  // of each second, so a steady tone reads the same every second.
  await app.invoke("settings:set", { "ndi.output.audio": true, "ndi.output.enabled": true });
  const status = () => app.invoke<{ state: string; audio?: { state: string; levelDb: number | null } | null }>("ndi:getStatus");
  await expect.poll(async () => (await status()).state, { timeout: 30_000 }).toMatch(/sending|runtime-missing/);
  test.skip((await status()).state === "runtime-missing", "no NDI runtime on this computer: nothing captures the sound");
  const level = async () => (await status()).audio?.levelDb ?? -120;
  /** Two seconds in a row that agree: a reading across the fader's move mixes both levels. */
  const steady = async () => {
    let previous = await level();
    for (let i = 0; i < 12; i++) {
      await app.control.waitForTimeout(1100);
      const now = await level();
      if (now > -80 && Math.abs(now - previous) < 0.3) return now;
      previous = now;
    }
    throw new Error(`the NDI sound never settled (last ${previous} dB)`);
  };

  // A 30-second tone, played by the media engine (the engine's level is the one a cubic curve stands between).
  await app.addMedia("audio", "song.wma");
  await app.previewFile("Audios", "song");
  await app.goLive();
  const full = await steady();
  await app.liveColumn().getByRole("slider", { name: MASTER }).fill("75");
  await expect.poll(level, { timeout: 10_000 }).toBeLessThan(full - 3);
  const half = await steady();
  console.log(`[audio-strips] NDI: ${full} dB at the top, ${half} dB three quarters up`);
  // −6.2 dB on the fader's log scale (`fader.ts`).
  expect(half - full).toBeGreaterThan(-7);
  expect(half - full).toBeLessThan(-5);
});

test("each strip's output menu lists this computer's outputs and keeps the one chosen by its name", async ({ app }) => {
  const strip = app.previewColumn().getByRole("group", { name: PREVIEW_STRIP });
  const trigger = strip.getByRole("button", { name: "Salida de PREVIEW" });
  // D6: both on the system's default, so PREVIEW is heard in the room too, and says so.
  await trigger.hover();
  await expect(app.control.getByRole("tooltip", { name: "Salida de PREVIEW:" })).toContainText("También se escucha en la sala");

  await trigger.click();
  const menu = app.control.getByRole("menu", { name: "Salida de PREVIEW" });
  const options = menu.getByRole("menuitemradio");
  // Named by the device behind it when Chromium says which (2026-11-15 audit, U15).
  await expect(options.first()).toHaveText(/^(Predeterminada del sistema|Del sistema: .+)$/);
  await expect(options.first()).toHaveAttribute("aria-checked", "true");
  // Chromium lists the outputs a moment after launch (the first time, Core Audio takes a second).
  const listed = await expect
    .poll(() => options.count(), { timeout: 5_000 })
    .toBeGreaterThan(1)
    .then(
      () => true,
      () => false,
    );
  test.skip(!listed, "this computer lists no audio output");
  const names = await options.allTextContents();
  console.log(`[audio-strips] outputs: ${JSON.stringify(names)}`);
  await options.nth(1).click();
  const stored = (await app.invoke<Record<string, unknown>>("settings:get"))["audio.output.preview"] as { label: string; deviceId: string };
  expect(stored.label).toBe(names[1]);
  expect(stored.deviceId).not.toBe("");

  await app.control.getByRole("button", { name: "Configuración" }).click();
  const settings = app.control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Sonido" }).click();
  await expect(settings.getByRole("combobox", { name: "Salida de PREVIEW" })).toHaveText(names[1]!);
  await expect(settings.getByRole("combobox", { name: "Salida de EN VIVO" })).toHaveText(/^(Predeterminada del|Del) sistema/);
});
