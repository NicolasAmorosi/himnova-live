import { expect, test } from "vitest";
import { chooseProjectorMove, chooseStageDisplay } from "../../src/main/windows/projector-display-choice";

// Screens: 1 = the operator's (hosts the control window), 2 = the projector, 3 = a third one.

test("back to the chosen screen as soon as it is connected again", () => {
  expect(chooseProjectorMove([1, 2, 3], 1, 2, 2, [2])).toBeNull(); // already there
  expect(chooseProjectorMove([1, 2, 3], 1, 2, 3, [2])).toBe(2);
  // Hidden while it was gone: its screen comes back.
  expect(chooseProjectorMove([1, 2], 1, 2, null, [2])).toBe(2);
});

test("a projector in standby with three screens never sends the service to the third", () => {
  // 2 went away: the window is hidden; 3 was already there.
  expect(chooseProjectorMove([1, 3], 1, 2, null, [])).toBeNull();
  // 2 comes back: it goes there, not on to 3.
  expect(chooseProjectorMove([1, 2, 3], 1, 2, null, [2])).toBe(2);
});

test("a screen that just appeared receives it — a projector turned on late, or back under a new id", () => {
  // The single-screen window on the operator's screen, the projector turned on.
  expect(chooseProjectorMove([1, 2], 1, null, 1, [2])).toBe(2);
  // The chosen projector came back as 4.
  expect(chooseProjectorMove([1, 4], 1, 2, null, [4])).toBe(4);
});

test("never onto the operator's own screen or the stage's", () => {
  expect(chooseProjectorMove([1], 1, 2, null, [])).toBeNull();
  expect(chooseProjectorMove([1, 3], 1, 2, null, [3], 3)).toBeNull();
  expect(chooseProjectorMove([1, 2, 3], 1, 3, 2, [3], 3)).toBeNull();
});

test("the operator's own screen chosen on purpose keeps its movable window there", () => {
  expect(chooseProjectorMove([1, 2], 1, 1, 1, [2])).toBeNull();
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
