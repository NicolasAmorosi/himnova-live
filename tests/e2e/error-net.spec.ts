import { expect, test } from "./support/app";

/** The net every test runs under (`support/app.ts`, teardown): an error in ANY window fails the test, not only in
 *  the control window, which is the only one with global handlers. Before 2026-11-15 a throw or a rejection in the
 *  projector — the window the room sees — and the ErrorBoundary's own line passed in green. */
test("an error in the projector, or one the ErrorBoundary caught, is seen by the net", async ({ app }) => {
  await app.control.getByRole("button", { name: "NEGRO", exact: true }).click();
  const projector = await app.projector();
  await projector.evaluate(() => {
    setTimeout(() => {
      throw new Error("zz-net projector uncaught");
    }, 0);
    void Promise.reject(new Error("zz-net projector rejection"));
  });
  await app.control.evaluate(() => console.error("[renderer] uncaught render error", new Error("zz-net render")));

  await expect
    .poll(() => app.unexpectedErrors().filter((line) => line.includes("zz-net")).length)
    .toBe(3);
  // Seen: forgotten, or the teardown would fail this test for the errors it made on purpose.
  app.log.splice(0);
});
