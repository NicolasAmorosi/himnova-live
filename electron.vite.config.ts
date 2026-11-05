import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";

/** The dev server's HMR socket, and the only reason `connect-src` is not just
 *  `'self'`. */
const DEV_CONNECT_SRC = " ws://localhost:*";

/**
 * Drops the HMR origin from the shipped CSP.
 *
 * The policy lives in a `<meta>` tag in each HTML file, so what dev needs used
 * to be what production shipped. Writing the permissive one in the file and
 * narrowing it here (rather than the reverse) keeps `npm run dev` working with
 * no transform at all, and makes the build strictly tighter than dev — never
 * the other way round.
 */
function stripDevCsp(): Plugin {
  return {
    name: "worship-strip-dev-csp",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: (html) => html.replaceAll(DEV_CONNECT_SRC, ""),
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
    build: {
      // `reportCrash` (src/main/index.ts) appends `error.stack` to
      // `crash.log`, and that is the only trace a machine in a booth leaves
      // behind. Without a map the stack points at a minified bundle, so the
      // one artifact the operator can send back says nothing.
      sourcemap: true,
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
    build: {
      // Same reason as main: a preload failure is reported through the same
      // process-level handlers.
      sourcemap: true,
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
        },
        // Electron's sandboxed preload (sandbox: true in both windows) cannot
        // load ES modules — `import`/`export` throws "Cannot use import
        // statement outside a module" and the preload silently fails to
        // load, leaving `window.worship` undefined. package.json has
        // "type": "module" for the rest of the toolchain (tsx, drizzle-kit),
        // so this override is what keeps the preload itself as plain CJS.
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    // Ajustes ▸ Acerca de shows it: the operators of the first real services could
    // not tell which build they had run.
    define: {
      __APP_VERSION__: JSON.stringify(
        (JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version: string }).version,
      ),
    },
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
      },
    },
    plugins: [react(), tailwindcss(), stripDevCsp()],
    build: {
      rollupOptions: {
        input: {
          control: resolve("src/renderer/index.html"),
          projection: resolve("src/renderer/projection.html"),
          // The musicians' screen (`main/windows/stage-window.ts`).
          stage: resolve("src/renderer/stage.html"),
          // Offscreen worker window: renders PDF pages to images with pdf.js.
          // It's a renderer (not a Node worker) because rasterizing needs a
          // real Canvas2D — see src/main/slides/rasterizer.ts.
          rasterizer: resolve("src/renderer/rasterizer.html"),
        },
      },
    },
  },
});
