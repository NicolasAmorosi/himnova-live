import { audioStates, expect, test, videoStates, type WorshipApp } from "./support/app";

/**
 * The LIVE column's own controls — what the operator touches while something
 * is ALREADY on the projector. Every check reads the projector's elements,
 * never the control window's idea of them: a panel that says "paused" over a
 * video that keeps running is the bug these exist to catch.
 */

async function videoLive(app: WorshipApp, name = "clip") {
  await app.addMedia("video", `${name}.mp4`);
  await app.previewFile("Videos", name);
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await videoStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.5);
  return projector;
}

async function openSettings(app: WorshipApp, section: "Proyección" | "Diapositivas" | "Biblia" | "Sistema") {
  await app.control.getByRole("button", { name: "Configuración" }).click();
  const dialog = app.control.getByRole("dialog", { name: "Configuración" });
  await dialog.getByRole("tab", { name: section }).click();
  return dialog;
}

test("the LIVE row pauses, seeks and resumes the projected video", async ({ app }) => {
  const projector = await videoLive(app);
  const live = app.liveColumn();

  await live.getByRole("button", { name: "Pausar" }).click();
  await expect.poll(async () => (await videoStates(projector))[0]?.paused).toBe(true);
  await expect(live.getByRole("button", { name: "Reproducir" })).toBeVisible();

  // Keyboard on the scrubber, the way an operator aims a seek precisely.
  const scrubber = live.getByRole("slider", { name: "Posición de clip" });
  await scrubber.focus();
  await scrubber.press("Home");
  await expect.poll(async () => (await videoStates(projector))[0]?.currentTime ?? -1).toBeLessThan(0.3);
  await scrubber.press("ArrowRight");
  await expect.poll(async () => (await videoStates(projector))[0]?.currentTime ?? 0).toBeCloseTo(5, 0);
  // Still paused: a seek is not a play.
  expect((await videoStates(projector))[0]?.paused).toBe(true);

  await live.getByRole("button", { name: "Reproducir" }).click();
  await expect.poll(async () => (await videoStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(5.3);
  expect((await videoStates(projector))[0]?.paused).toBe(false);
});

test("the LIVE row's volume reaches the projector, survives NEGRO and mutes", async ({ app }) => {
  const projector = await videoLive(app);
  const live = app.liveColumn();

  await live.getByRole("slider", { name: "Volumen de clip" }).fill("30");
  await expect.poll(async () => (await videoStates(projector))[0]?.volume).toBeCloseTo(0.3, 2);

  // The level is state the projector holds, not a one-off command: a cover
  // and an uncover must not reset it.
  await app.control.locator("body").press("b");
  await expect.poll(async () => (await videoStates(projector))[0]?.paused).toBe(true);
  await app.control.locator("body").press("b");
  await expect.poll(async () => (await videoStates(projector))[0]?.paused).toBe(false);
  expect((await videoStates(projector))[0]?.volume).toBeCloseTo(0.3, 2);

  await live.getByRole("button", { name: "Silenciar" }).click();
  await expect.poll(async () => (await videoStates(projector))[0]?.volume).toBe(0);
  await live.getByRole("button", { name: "Activar sonido" }).click();
  // Back to what the operator had set, not to a default.
  await expect.poll(async () => (await videoStates(projector))[0]?.volume).toBeCloseTo(0.3, 2);
});

test("a video that plays to its end leaves the projector by itself", async ({ app }) => {
  const projector = await videoLive(app);
  const live = app.liveColumn();
  const scrubber = live.getByRole("slider", { name: "Posición de clip" });
  await scrubber.focus();
  await scrubber.press("End");

  await expect.poll(async () => (await videoStates(projector)).length).toBe(0);
  await expect(scrubber).toHaveCount(0);
  // Nothing is live any more, so VIVO has nothing to uncover.
  await expect(app.control.getByRole("button", { name: "VIVO", exact: true })).toBeDisabled();
});

test("«Sacar del aire» on the LIVE row takes the video off the projector", async ({ app }) => {
  const projector = await videoLive(app);
  await app.liveColumn().getByRole("button", { name: "Sacar del aire" }).click();
  await expect.poll(async () => (await videoStates(projector)).length).toBe(0);
  await expect(app.liveColumn().getByRole("slider", { name: "Posición de clip" })).toHaveCount(0);
});

test("a standalone audio pauses, resumes and stops from its row", async ({ app }) => {
  await app.addMedia("audio", "song.mp3");
  await app.previewFile("Audios", "song");
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await audioStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.5);
  const live = app.liveColumn();

  await live.getByRole("button", { name: "Pausar" }).click();
  await expect.poll(async () => (await audioStates(projector))[0]?.paused).toBe(true);
  const pausedAt = (await audioStates(projector))[0]?.currentTime ?? 0;
  await projector.waitForTimeout(700);
  expect((await audioStates(projector))[0]?.currentTime).toBeCloseTo(pausedAt, 1);

  await live.getByRole("button", { name: "Reproducir" }).click();
  await expect.poll(async () => (await audioStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(pausedAt + 0.3);

  await live.getByRole("button", { name: "Detener" }).click();
  await expect.poll(async () => (await audioStates(projector)).length).toBe(0);
  await expect(live.getByRole("slider", { name: "Posición de song" })).toHaveCount(0);
});

test("an audio that plays to its end leaves the LIVE panel", async ({ app }) => {
  await app.addMedia("audio", "song.mp3");
  await app.previewFile("Audios", "song");
  await app.goLive();
  const projector = await app.projector();
  await expect.poll(async () => (await audioStates(projector))[0]?.currentTime ?? 0).toBeGreaterThan(0.3);

  const scrubber = app.liveColumn().getByRole("slider", { name: "Posición de song" });
  await scrubber.focus();
  await scrubber.press("End");
  await expect(scrubber).toHaveCount(0);
  await expect.poll(async () => (await audioStates(projector)).length).toBe(0);
});

test("the start volume set in Ajustes is the level a new video starts at", async ({ app }) => {
  const settings = await openSettings(app, "Proyección");
  await settings.getByRole("slider", { name: "Volumen inicial" }).fill("0.4");
  await expect(settings.getByText("40%", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Volver" }).click();

  const projector = await videoLive(app);
  expect((await videoStates(projector))[0]?.volume).toBeCloseTo(0.4, 2);
  await expect(app.liveColumn().getByRole("slider", { name: "Volumen de clip" })).toHaveValue("40");
});

test("closing and reopening the projector from Ajustes keeps the video where it was", async ({ app }) => {
  const first = await videoLive(app);
  await expect.poll(async () => (await videoStates(first))[0]?.currentTime ?? 0).toBeGreaterThan(2.5);

  const settings = await openSettings(app, "Proyección");
  await settings.getByRole("button", { name: "Cerrar pantalla" }).click();
  await expect.poll(() => app.hasProjector()).toBe(false);
  // Read once the window is gone: this is where the operator stopped it.
  await settings.getByRole("button", { name: "Abrir pantalla" }).click();
  const second = await app.projector();
  await settings.getByRole("button", { name: "Volver" }).click();

  // A reopened projector starts covered — and the video under it is mounted
  // where it was, not back at 0:00.
  await expect.poll(async () => (await videoStates(second))[0]?.readyState ?? 0).toBeGreaterThanOrEqual(1);
  expect((await videoStates(second))[0]).toMatchObject({ paused: true, opacity: 0 });
  expect((await videoStates(second))[0]?.currentTime).toBeGreaterThan(2.3);

  await app.control.locator("body").press("b");
  await expect.poll(async () => (await videoStates(second))[0]).toMatchObject({ paused: false, opacity: 1 });
  expect((await videoStates(second))[0]?.currentTime).toBeGreaterThan(2.3);
});

test("«Sacar del aire» in Ajustes empties the projector", async ({ app }) => {
  const projector = await videoLive(app);
  const settings = await openSettings(app, "Proyección");
  await settings.getByRole("button", { name: "Sacar del aire" }).click();
  await expect.poll(async () => (await videoStates(projector)).length).toBe(0);
  await expect(settings.getByRole("button", { name: "Sacar del aire" })).toBeDisabled();
});
