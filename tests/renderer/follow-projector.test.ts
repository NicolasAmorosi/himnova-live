import { describe, expect, test } from "vitest";
import { followAction, followDrift } from "../../src/renderer/src/lib/follow-projector";

describe("the NDI window's video follows the projector's", () => {
  test("within a frame it plays at its own pace", () => {
    expect(followAction(0.005)).toEqual({ rate: 1 });
    expect(followAction(-0.005)).toEqual({ rate: 1 });
  });

  test("ahead, it slows down hard — down to half speed, repeating frames; behind, it speeds up by at most 10 %", () => {
    expect((followAction(0.03) as { rate: number }).rate).toBeCloseTo(0.9, 6);
    expect((followAction(-0.05) as { rate: number }).rate).toBeCloseTo(1.05, 6);
    // The +109…+311 ms starts measured over NDI: half speed until it is close.
    expect(followAction(0.311)).toEqual({ rate: 0.5 });
    expect(followAction(0.23)).toEqual({ rate: 0.5 });
    expect(followAction(-0.4)).toEqual({ rate: 1.1 });
  });

  test("a start 0.23 s ahead is in step within a second, reported every 250 ms, and does not overshoot", () => {
    for (const reportMs of [200, 250, 350]) {
      let drift = 0.23;
      let ms = 0;
      while (ms < 1000) {
        const action = followAction(drift);
        if (!("rate" in action) || action.rate === 1) break;
        drift -= (1 - action.rate) * (reportMs / 1000);
        ms += reportMs;
      }
      expect(Math.abs(drift)).toBeLessThan(0.012);
      expect(ms).toBeLessThanOrEqual(1050);
    }
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
