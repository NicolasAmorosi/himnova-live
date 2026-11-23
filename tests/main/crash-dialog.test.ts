/**
 * An uncaught error in main showed «Error inesperado» over a bare stack in English: nothing said whether the app
 * goes on or what to do (2026-11-22 review, EC-7).
 */
import { afterEach, expect, test } from "vitest";
import { crashDialogText } from "../../src/main/logging";
import { setMainLocale } from "../../src/main/i18n";
import mainEs from "../../src/main/i18n/messages/es";
import mainEn from "../../src/main/i18n/messages/en";

const STACK = "TypeError: x is undefined\n    at tick (index.js:1:1)";

afterEach(() => setMainLocale("es"));

test("the crash dialog says whether the app goes on and what to do, before the stack", () => {
  expect(crashDialogText("uncaughtException", STACK)).toBe(`${mainEs.dialogs.crashRunning}\n\n${STACK}`);
  expect(crashDialogText("unhandledRejection", STACK)).toBe(`${mainEs.dialogs.crashRunning}\n\n${STACK}`);
  // Only a failed start is followed by a quit.
  expect(crashDialogText("startup", STACK)).toBe(`${mainEs.dialogs.crashStartup}\n\n${STACK}`);
  setMainLocale("en");
  expect(crashDialogText("startup", STACK)).toBe(`${mainEn.dialogs.crashStartup}\n\n${STACK}`);
});
