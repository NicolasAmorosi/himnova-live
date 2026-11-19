import { expect, test } from "vitest";
import {
  chooseProjectorMove,
  chooseStageDisplay,
  printOf,
  recognizeDisplay,
} from "../../src/main/windows/projector-display-choice";
import { projectorDisplayFor, stageSharesProjector } from "../../src/shared/display-roles";

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

test("a projector that fell on the stage's screen before the stage was assigned leaves it", () => {
  // Never chosen, opened on 3 (the first that was not the operator's); 3 is the stage's now.
  expect(chooseProjectorMove([1, 2, 3], 1, null, 3, [], 3)).toBe(2);
  // Nowhere else to go: it stays rather than land on the operator's screen.
  expect(chooseProjectorMove([1, 3], 1, null, 3, [], 3)).toBeNull();
});

test("the projector's screen: its chosen one, else never the operator's nor the stage's", () => {
  expect(projectorDisplayFor([1, 2, 3], 1, 3, 2)).toBe(3);
  expect(projectorDisplayFor([1, 2, 3], 1, null, 2)).toBe(3);
  expect(projectorDisplayFor([1, 2, 3], 1, 9, 2)).toBe(3);
  expect(projectorDisplayFor([1, 2, 3], 1, null, null)).toBe(2);
  // Two screens, the second the stage's: a movable window on the operator's, never over the stage.
  expect(projectorDisplayFor([1, 3], 1, null, 3)).toBe(1);
  expect(projectorDisplayFor([], 1, null, null)).toBeNull();
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
  // The projector's own choice unplugged: it opens on the first screen that is neither the operator's nor the
  // stage's, so the stage keeps its screen whichever it is (2026-11-13).
  expect(chooseStageDisplay([1, 2, 3], 1, 2, 9)).toBe(2);
  expect(chooseStageDisplay([1, 2, 3], 1, 3, 9)).toBe(3);
  // Never chosen at all: the same.
  expect(chooseStageDisplay([1, 2, 3], 1, 2, null)).toBe(2);
});

test("the operator's own screen takes both, as movable windows", () => {
  expect(chooseStageDisplay([1], 1, 1, 1)).toBe(1);
  expect(chooseStageDisplay([1, 2], 1, 1, 2)).toBe(1);
});

test("a 2.9 profile with the stage on the projector's screen keeps the projector there and loses the stage", () => {
  // Fails if it is kept: with a third screen, the first display event moved the projector there mid-service.
  expect(stageSharesProjector(2, 2, 1)).toBe(true);
  expect(chooseProjectorMove([1, 2, 3], 1, 2, 2, [], 2)).toBe(3);
  // Read as 2.9 played it: the stage off, the projector stays.
  expect(chooseProjectorMove([1, 2, 3], 1, 2, 2, [], null)).toBeNull();
  // The operator's own screen holds both (movable windows, one screen): nothing to change.
  expect(stageSharesProjector(1, 1, 1)).toBe(false);
  expect(stageSharesProjector(2, 3, 1)).toBe(false);
  expect(stageSharesProjector(null, null, 1)).toBe(false);
  expect(stageSharesProjector(null, 2, 1)).toBe(false);
});

// The owner's Windows PC before and after the restart of 2026-11-18: three new ids, the same names and places.
const before = [
  { id: 115815580, label: "GS25F2", bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  { id: 2926163071, label: "PHL 221V8", bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
  { id: 3750548484, label: "LG FULL HD", bounds: { x: 1920, y: 0, width: 1920, height: 1080 } },
];
const after = [
  { id: 989985988, label: "GS25F2", bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  { id: 2560382816, label: "PHL 221V8", bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
  { id: 3161383203, label: "LG FULL HD", bounds: { x: 1920, y: 0, width: 1920, height: 1080 } },
];

test("a screen Windows renumbered is found again by its name", () => {
  expect(recognizeDisplay(printOf(before[2]!), after, [])).toBe(3161383203);
  expect(recognizeDisplay(printOf(before[1]!), after, [])).toBe(2560382816);
  // Same size, so the size alone could not tell them apart.
});

test("two screens of one model are told apart by their place, and only by both", () => {
  const twins = [
    { id: 7, label: "EPSON PJ", bounds: { x: 1920, y: 0, width: 1920, height: 1080 } },
    { id: 8, label: "EPSON PJ", bounds: { x: 3840, y: 0, width: 1920, height: 1080 } },
  ];
  expect(recognizeDisplay({ label: "EPSON PJ", x: 3840, y: 0, width: 1920, height: 1080 }, twins, [])).toBe(8);
  // Moved since: neither is certain, so nothing is guessed.
  expect(recognizeDisplay({ label: "EPSON PJ", x: 0, y: 1080, width: 1920, height: 1080 }, twins, [])).toBeNull();
});

test("nothing is recognized without a name, without a match, or onto a screen another role holds", () => {
  expect(printOf({ id: 1, label: "  ", bounds: { x: 0, y: 0, width: 1920, height: 1080 } })).toBeNull();
  expect(recognizeDisplay(null, after, [])).toBeNull();
  expect(recognizeDisplay({ label: "Proyector", x: 0, y: 0, width: 1920, height: 1080 }, after, [])).toBeNull();
  expect(recognizeDisplay(printOf(before[2]!), after, [3161383203])).toBeNull();
});
