import { describe, expect, test } from "vitest";
import { followAction, followDrift } from "../../src/renderer/src/lib/follow-projector";

describe("the NDI window's video follows the projector's", () => {
  test("within a frame it plays at its own pace", () => {
    expect(followAction(0.005)).toEqual({ rate: 1 });
    expect(followAction(-0.005)).toEqual({ rate: 1 });
  });

  test("ahead, it slows down; behind, it speeds up — by at most 10 %", () => {
    expect(followAction(0.05)).toEqual({ rate: 0.95 });
    expect(followAction(-0.05)).toEqual({ rate: 1.05 });
    // The +227 / +311 ms starts measured 2026-11-10: slowed to 0.9, so it repeats frames and skips none.
    expect(followAction(0.311)).toEqual({ rate: 0.9 });
    expect(followAction(-0.4)).toEqual({ rate: 1.1 });
  });

  test("a second or more apart is the operator's seek: it jumps", () => {
    expect(followAction(1.5)).toEqual({ seek: true });
    expect(followAction(-30)).toEqual({ seek: true });
  });

  test("a looping clip's wrap is the short way round", () => {
    expect(followDrift(9.95, 0.1, 10, true)).toBeCloseTo(-0.15, 6);
    expect(followDrift(0.1, 9.95, 10, true)).toBeCloseTo(0.15, 6);
    expect(followDrift(5.2, 5, 10, true)).toBeCloseTo(0.2, 6);
    // Not looping, a wrap is a real jump.
    expect(followDrift(9.95, 0.1, 10, false)).toBeCloseTo(9.85, 6);
    // No duration yet: the plain difference.
    expect(followDrift(1.2, 1, 0, true)).toBeCloseTo(0.2, 6);
  });
});
