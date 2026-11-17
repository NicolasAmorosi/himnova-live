import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/** The same two aliases `electron.vite.config.ts` gives the app — the tests
 *  import the real modules by the real specifiers, never a copy. */
const alias = {
  "@shared": resolve("src/shared"),
  "@renderer": resolve("src/renderer/src"),
};

/**
 * Two projects because the app is two runtimes. `main` is Node: SQLite, the
 * zip reader, the slide pipeline's pure parts. `renderer` is jsdom, which the
 * stores need only because a couple of them touch `document` on a path a test
 * may reach. A component is mounted only for a defect nothing but its render
 * shows (a fade in `OutputView`); the rest stays with the E2E suite.
 *
 * Electron itself is never imported by anything under test: a module that
 * needs `electron` is a module this suite does not cover, and that boundary is
 * what keeps these tests from becoming a wall of mocks.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "main",
          environment: "node",
          include: ["tests/main/**/*.test.ts"],
          // The data-layer suite runs the real migrations and seeds the real
          // RV1909 (31 102 verses, ~600 ms) once for the whole file.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "renderer",
          environment: "jsdom",
          include: ["tests/renderer/**/*.test.ts"],
        },
      },
    ],
  },
});
