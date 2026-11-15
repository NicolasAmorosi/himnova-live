/** The LIVE master and the audio settings (`shared/types/audio.ts`, `audio.*` in `shared/types/settings.ts`). */
import { expect, test } from "vitest";
import { busVolume, liveMasterVolume } from "../../src/shared/types/audio";
import { DEFAULT_SETTINGS, SETTINGS_NORMALIZERS, SETTINGS_VALIDATORS } from "../../src/shared/types/settings";

test("a live item plays at its own level times the master, clamped and never NaN", () => {
  expect(busVolume(0.8, 0.5)).toBeCloseTo(0.4, 6);
  expect(busVolume(1, 1)).toBe(1);
  expect(busVolume(0.7, 0)).toBe(0);
  // `HTMLMediaElement.volume` throws outside 0..1 and on NaN.
  expect(busVolume(1.2, 1)).toBe(1);
  expect(busVolume(Number.NaN, 1)).toBe(0);
});

test("with the strips off the LIVE master counts as 100 % (D3)", () => {
  // Fails if a fader nobody can see keeps turning the room down.
  expect(liveMasterVolume(false, 0.3)).toBe(1);
  expect(liveMasterVolume(true, 0.3)).toBe(0.3);
});

test("the LIVE mute silences the master without touching the remembered level, and never outlives the app", () => {
  expect(liveMasterVolume(true, 0.3, true)).toBe(0);
  expect(liveMasterVolume(true, 0.3, false)).toBe(0.3);
  // A mute nobody can see (strips off) does not silence the room either.
  expect(liveMasterVolume(false, 0.3, true)).toBe(1);
  // A launch starts unmuted (`ui.store`), and a remembered 0 (an older build's mute) reads back as the default:
  // fails if a church can open the app with LIVE silent.
  const normalize = SETTINGS_NORMALIZERS["audio.live.volume"] as (value: unknown) => number;
  expect(normalize(0)).toBe(1);
  expect(normalize(0.4)).toBe(0.4);
});

test("the strips are on by default, the master at 100 %, both outputs the system's (D5)", () => {
  expect(DEFAULT_SETTINGS["audio.strips"]).toBe(true);
  expect(DEFAULT_SETTINGS["audio.live.volume"]).toBe(1);
  expect(DEFAULT_SETTINGS["audio.output.live"]).toBeNull();
  expect(DEFAULT_SETTINGS["audio.output.preview"]).toBeNull();
});

test("the audio settings are validated on write", () => {
  const valid = (key: keyof typeof SETTINGS_VALIDATORS, value: unknown) => SETTINGS_VALIDATORS[key](value);
  expect(valid("audio.strips", "true")).toBe(false);
  expect(valid("audio.live.volume", 0.5)).toBe(true);
  expect(valid("audio.live.volume", 1.01)).toBe(false);
  expect(valid("audio.live.volume", Number.NaN)).toBe(false);
  expect(valid("audio.output.live", null)).toBe(true);
  expect(valid("audio.output.live", { label: "Scarlett 2i2", deviceId: "a1b2" })).toBe(true);
  // The name is what the engine matches by: it cannot be blank.
  expect(valid("audio.output.live", { label: "", deviceId: "a1b2" })).toBe(false);
  expect(valid("audio.output.preview", { label: "Scarlett 2i2" })).toBe(false);
  expect(valid("audio.output.preview", "Scarlett 2i2")).toBe(false);
});

test("a stored audio setting is normalized on read, and what comes out passes the validator", () => {
  const cases: [keyof typeof SETTINGS_VALIDATORS, unknown, unknown][] = [
    ["audio.strips", "yes", true],
    ["audio.strips", false, false],
    // JSON stores NaN as null: read as a level it would silence every live element.
    ["audio.live.volume", null, 1],
    ["audio.live.volume", 0.25, 0.25],
    ["audio.output.live", { label: "Scarlett", deviceId: "x", extra: 1 }, { label: "Scarlett", deviceId: "x" }],
    ["audio.output.preview", { deviceId: "x" }, null],
  ];
  for (const [key, stored, read] of cases) {
    const normalize = SETTINGS_NORMALIZERS[key] as (value: unknown) => unknown;
    expect(normalize(stored)).toEqual(read);
    expect(SETTINGS_VALIDATORS[key](normalize(stored))).toBe(true);
  }
});
