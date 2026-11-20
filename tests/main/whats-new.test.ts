/** «Novedades» (`shared/whats-new.ts`) and the `ui.whatsNewSeen` it reads. */
import { expect, test } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_NORMALIZERS, SETTINGS_VALIDATORS } from "../../src/shared/types/settings";
import { LATEST_WHATS_NEW, WHATS_NEW_KEYS, whatsNewDue, whatsNewKeysFor } from "../../src/shared/whats-new";

test("a profile that saw none, or an older one, is due; the latest or a later one is not", () => {
  expect(DEFAULT_SETTINGS["ui.whatsNewSeen"]).toBeNull();
  expect(whatsNewDue(null)).toBe(true);
  // By number, not as text: «2.9» < «2.10» < «2.10.1».
  expect(whatsNewDue("2.9")).toBe(true);
  expect(whatsNewDue("1.0")).toBe(true);
  expect(whatsNewDue(LATEST_WHATS_NEW)).toBe(false);
  expect(whatsNewDue(`${LATEST_WHATS_NEW}.1`)).toBe(false);
  // A profile opened by an older build after a newer one never sees an older screen.
  expect(whatsNewDue("99.0")).toBe(false);
});

test("the keys go oldest first, so the last one is the latest", () => {
  expect(WHATS_NEW_KEYS.at(-1)).toBe(LATEST_WHATS_NEW);
  for (const key of WHATS_NEW_KEYS.slice(0, -1)) expect(whatsNewDue(key)).toBe(true);
});

test("a profile that skipped a version is told what each brought, oldest first; by hand, the latest", () => {
  // 2.9 straight to 2.13: the stage screen and the strips (2.10) were never told, and only the latest was shown.
  expect(whatsNewKeysFor("2.9")).toEqual(["2.10", "2.11", "2.12", "2.12.1", "2.13"]);
  expect(whatsNewKeysFor(null)).toEqual(WHATS_NEW_KEYS);
  expect(whatsNewKeysFor("2.10")).toEqual(["2.11", "2.12", "2.12.1", "2.13"]);
  expect(whatsNewKeysFor("2.10.1")).toEqual(["2.11", "2.12", "2.12.1", "2.13"]);
  expect(whatsNewKeysFor("2.11")).toEqual(["2.12", "2.12.1", "2.13"]);
  // A patch with a key of its own counts like any version: after its minor, then before the next.
  expect(whatsNewKeysFor("2.12")).toEqual(["2.12.1", "2.13"]);
  expect(whatsNewKeysFor("2.12.1")).toEqual(["2.13"]);
  // Nothing due: Settings ▸ About opens the latest.
  expect(whatsNewKeysFor(LATEST_WHATS_NEW)).toEqual([LATEST_WHATS_NEW]);
  expect(whatsNewKeysFor("99.0")).toEqual([LATEST_WHATS_NEW]);
});

test("the seen key is validated on write and normalized on read", () => {
  const valid = SETTINGS_VALIDATORS["ui.whatsNewSeen"];
  expect(valid(null)).toBe(true);
  expect(valid("2.10")).toBe(true);
  expect(valid("")).toBe(false);
  expect(valid("2.10-beta")).toBe(false);
  expect(valid(2.1)).toBe(false);
  const normalize = SETTINGS_NORMALIZERS["ui.whatsNewSeen"]!;
  for (const [stored, read] of [
    ["2.10", "2.10"],
    ["dos", null],
    [7, null],
    [null, null],
  ] as const) {
    expect(normalize(stored)).toBe(read);
    expect(valid(normalize(stored))).toBe(true);
  }
});
