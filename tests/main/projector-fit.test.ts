/** A screen's size as its system says it, and the projector's fit kept per screen (`shared/types/display.ts`,
 *  `projection.fit` in `shared/types/settings.ts`). A church's 1920x1080 projector at Windows' 125 % read «1536x864»
 *  and overscanned ~5 % per edge (2026-11-21). */
import { expect, test } from "vitest";
import { projectorFitKey, resolutionLabel } from "../../src/shared/types/display";
import { DEFAULT_SETTINGS, SETTINGS_NORMALIZERS, SETTINGS_VALIDATORS } from "../../src/shared/types/settings";

test("Windows and Linux say the mode in pixels, with the scale when it is not 100 %", () => {
  expect(resolutionLabel(1536, 864, 1.25, "win32")).toBe("1920x1080 · 125 %");
  expect(resolutionLabel(1280, 720, 1.5, "linux")).toBe("1920x1080 · 150 %");
  expect(resolutionLabel(1920, 1080, 1, "win32")).toBe("1920x1080");
  // Fractional DIPs round to the mode, not to 1919.
  expect(resolutionLabel(1745, 982, 1.1, "win32")).toBe("1920x1080 · 110 %");
});

test("macOS keeps its own «looks like» size", () => {
  expect(resolutionLabel(1512, 982, 2, "darwin")).toBe("1512x982");
});

test("a fit belongs to the screen's name and mode, whatever Windows' scale or the screen's id", () => {
  expect(projectorFitKey(" EPSON PJ ", 1536, 864, 1.25)).toBe("EPSON PJ|1920x1080");
  expect(projectorFitKey("EPSON PJ", 1920, 1080, 1)).toBe(projectorFitKey("EPSON PJ", 1536, 864, 1.25));
  expect(projectorFitKey("", 1920, 1080, 1)).not.toBe(projectorFitKey("", 1280, 720, 1));
});

test("projection.fit takes whole percents from 80 to 100 per screen, and nothing else", () => {
  const valid = SETTINGS_VALIDATORS["projection.fit"];
  expect(DEFAULT_SETTINGS["projection.fit"]).toEqual({});
  expect(valid({})).toBe(true);
  expect(valid({ "EPSON PJ|1920x1080": 92, "|1280x720": 100 })).toBe(true);
  expect(valid({ a: 79 })).toBe(false);
  expect(valid({ a: 101 })).toBe(false);
  expect(valid({ a: 92.5 })).toBe(false);
  expect(valid({ a: "92" })).toBe(false);
  expect(valid([92])).toBe(false);
  expect(valid(null)).toBe(false);
  expect(valid(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`s${i}`, 90])))).toBe(false);
});

test("a stored projection.fit is read screen by screen, and what it gives always passes the validator", () => {
  const normalize = SETTINGS_NORMALIZERS["projection.fit"]!;
  const valid = SETTINGS_VALIDATORS["projection.fit"];
  const kept = normalize({ "EPSON PJ|1920x1080": 92, "TV|1920x1080": 0, "LG|3840x2160": "90", [`${"x".repeat(301)}|1x1`]: 90 });
  expect(kept).toEqual({ "EPSON PJ|1920x1080": 92 });
  for (const stored of [null, "90", [92], 7, { a: 85.5 }, Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`s${i}`, 90]))]) {
    expect(valid(normalize(stored))).toBe(true);
  }
  expect(Object.keys(normalize(Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`s${i}`, 90]))))).toHaveLength(64);
});

test("«Lo que sigue en PREVIEW» is on by default", () => {
  expect(DEFAULT_SETTINGS["projection.previewNext"]).toBe(true);
  expect(SETTINGS_VALIDATORS["projection.previewNext"]("yes")).toBe(false);
});
