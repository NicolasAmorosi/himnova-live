import { defineConfig } from "@playwright/test";

/**
 * End-to-end suite: the real, built app (`out/`) driven through Playwright's
 * Electron support, one throwaway profile per test, against media generated
 * on the fly by `tests/e2e/support/global-setup.ts`. Run with
 * `npm run test:e2e`, which builds first.
 *
 * One worker on purpose: every test opens a fullscreen projector window, and
 * two of them fighting over the same screen would test the window manager,
 * not the app.
 */
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  // Off for the CI's launch check (`checks.yml`): `startup.spec.ts` projects none of the generated files.
  ...(process.env["E2E_NO_FIXTURES"] ? {} : { globalSetup: "./tests/e2e/support/global-setup.ts" }),
  outputDir: "test-results/e2e",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
});
