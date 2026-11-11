import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/** `npm run tutorials`: `tests/e2e/tutorials.record.ts` films the landing's
 *  tutorials. Its own config, so `test:e2e` never does. */
export default defineConfig({ ...base, testMatch: "**/*.record.ts" });
