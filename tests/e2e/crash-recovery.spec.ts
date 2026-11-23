import { expect, relaunch, test, type WorshipApp } from "./support/app";

/**
 * What comes back after the app goes down without closing: main killed outright (SIGKILL, not a `close()`), as a
 * power cut, a frozen app ended from the task manager or a Windows update would leave it, then launched again on the
 * same profile. A clean close is the other side: nothing comes back that the operator did not leave unsaved.
 */

const scheduleRows = (app: WorshipApp) => app.control.getByRole("main").getByRole("list").first().getByRole("listitem");

/** Main gone without a word: no `before-quit`, no `closed`, no `will-quit`. Then the same profile again. */
async function crashAndRelaunch(app: WorshipApp): Promise<WorshipApp> {
  // What is written on a timer reaches the disk first: the schedule's draft (600 ms) and the settings (300 ms).
  await app.control.waitForTimeout(1_000);
  process.kill(app.mainPid, "SIGKILL");
  await app.exited;
  return relaunch(app);
}

async function liveRowSchedule(app: WorshipApp): Promise<void> {
  await app.addMedia("video", "clip.mp4");
  await app.addMedia("image", "photo.png");
  for (const [tab, name] of [["Videos", "clip"], ["Imágenes", "photo"]] as const) {
    await app.previewFile(tab, name);
    await app.control.getByRole("tabpanel", { name: tab }).getByRole("button", { name: "Agregar al programa" }).click();
  }
  await expect(scheduleRows(app)).toHaveText([/1\s*clip/, /2\s*photo/]);
  await scheduleRows(app).filter({ hasText: "photo" }).dblclick();
  await expect((await app.projector()).locator('img[src^="worship://asset/"]')).toBeVisible();
}

test("after a crash the row that was on air is back in PREVIEW, and nothing is on air (DU-6)", async ({ app }) => {
  await liveRowSchedule(app);
  const again = await crashAndRelaunch(app);
  await expect(scheduleRows(again)).toHaveText([/1\s*clip/, /2\s*photo/]);
  // Selected as a click selects it: an Enter takes it back.
  await expect(scheduleRows(again).filter({ hasText: "photo" })).toHaveAttribute("aria-current", "true");
  // Nothing went out by itself: the projector was never opened (the suite runs with `--no-auto-projector`).
  expect(again.hasProjector()).toBe(false);
  await again.goLive();
  await expect((await again.projector()).locator('img[src^="worship://asset/"]')).toBeVisible();
});

test("after a clean close nothing is put in PREVIEW", async ({ app }) => {
  await liveRowSchedule(app);
  await app.quit("close");
  const again = await relaunch(app);
  await expect(scheduleRows(again)).toHaveText([/1\s*clip/, /2\s*photo/]);
  await expect(again.control.getByRole("main").getByRole("list").first().locator('[aria-current="true"]')).toHaveCount(0);
});
