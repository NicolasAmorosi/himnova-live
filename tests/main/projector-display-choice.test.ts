import { expect, test } from "vitest";
import { chooseProjectorDisplay, chooseStageDisplay } from "../../src/main/windows/projector-display-choice";

test("the operator's chosen screen wins while it is connected", () => {
  expect(chooseProjectorDisplay([1, 2, 3], 1, 3)).toBe(3);
});

test("otherwise the first screen that is not the operator's own", () => {
  expect(chooseProjectorDisplay([1, 2, 3], 1, 9)).toBe(2);
  expect(chooseProjectorDisplay([1, 2], 1, null)).toBe(2);
});

test("never the primary screen, even when it is the one chosen", () => {
  expect(chooseProjectorDisplay([1], 1, 1)).toBeNull();
  expect(chooseProjectorDisplay([1, 2], 1, 1)).toBe(2);
});

test("the stage screen is the chosen one while it is connected", () => {
  expect(chooseStageDisplay([1, 2, 3], 1, 3, 2)).toBe(3);
  expect(chooseStageDisplay([1, 2], 1, 3, 2)).toBeNull();
  expect(chooseStageDisplay([1, 2], 1, null, 2)).toBeNull();
});

test("never the projector's screen, even when the projector has not opened yet", () => {
  expect(chooseStageDisplay([1, 2, 3], 1, 2, 2)).toBeNull();
  // The projector's own choice unplugged: it would open on the first screen that is not the operator's.
  expect(chooseStageDisplay([1, 2, 3], 1, 2, 9)).toBeNull();
  expect(chooseStageDisplay([1, 2, 3], 1, 3, 9)).toBe(3);
});

test("the operator's own screen takes both, as movable windows", () => {
  expect(chooseStageDisplay([1], 1, 1, 1)).toBe(1);
  expect(chooseStageDisplay([1, 2], 1, 1, 2)).toBe(1);
});
