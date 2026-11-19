import { projectorDisplayFor } from "@shared/display-roles";
import type { DisplayPrint } from "@shared/types/settings";

/** What the two functions below read of an Electron `Display`. */
type ScreenSeen = { id: number; label: string; bounds: { x: number; y: number; width: number; height: number } };

/** A screen's print, kept for its role while it is connected; `null` for a screen with no name (Linux may give none),
 *  which is never recognized by its place alone. */
export function printOf(display: ScreenSeen): DisplayPrint | null {
  const label = display.label.trim();
  if (label === "") return null;
  const { x, y, width, height } = display.bounds;
  return { label, x, y, width, height };
}

/**
 * The screen a role's print points to once its saved id is gone. Windows can hand every screen a new id after a
 * restart (measured 2026-11-18 on the owner's PC: three screens, three new ids, the same names and places), and with
 * three screens the stage then stayed off and the projector took the first free screen, maybe the musicians'.
 * The same name; with two screens of one model, the same place as well. Anything less certain is `null`, and the roles
 * behave as before (`projectorDisplayFor`, `chooseStageDisplay`). Never a screen another role holds. Pure.
 */
export function recognizeDisplay(
  print: DisplayPrint | null,
  displays: readonly ScreenSeen[],
  taken: readonly number[],
): number | null {
  if (print === null) return null;
  const named = displays.filter((display) => display.label.trim() === print.label);
  const placed =
    named.length === 1
      ? named
      : named.filter(({ bounds: b }) => b.x === print.x && b.y === print.y && b.width === print.width && b.height === print.height);
  const found = placed.length === 1 ? placed[0]!.id : null;
  return found !== null && !taken.includes(found) ? found : null;
}

/**
 * Where the projection window goes once the list of screens changes, or `null` to leave it where it
 * is — on its screen, or hidden because its screen went away (`projector-screen.ts`).
 *
 * - The operator's chosen screen (`projection.displayId`) as soon as it is connected again.
 * - Otherwise only a screen that has JUST appeared (`addedIds`): a projector turned on after the app
 *   opened, or one back from standby under a new id. Never one that was already there: with three
 *   screens, a projector going to standby sent the service to the third — a stage, a confidence
 *   monitor — and left it there for the rest of the service (2026-11-10 review, `agent5-03`).
 * - Never the operator's own screen (the one hosting the control window) nor the stage's: there a
 *   fullscreen, always-on-top window covers what someone is reading. Unless the operator CHOSE their
 *   own screen: then it is a movable window there, and stays (owner, 2026-11-10).
 *
 * Pure, so the rule is tested without Electron (`tests/main/projector-display-choice.test.ts`).
 */
export function chooseProjectorMove(
  displayIds: readonly number[],
  operatorId: number,
  preferredId: number | null,
  /** The screen it is shown on; `null` while hidden. */
  currentId: number | null,
  addedIds: readonly number[],
  stageId: number | null = null,
): number | null {
  // Chosen on purpose: a movable window on the operator's screen (owner, 2026-11-10), kept there.
  if (preferredId === operatorId) return null;
  const allowed = (id: number) => id !== operatorId && id !== stageId && displayIds.includes(id);
  if (preferredId !== null && allowed(preferredId)) return preferredId === currentId ? null : preferredId;
  if (currentId !== null && displayIds.includes(currentId) && currentId !== operatorId && currentId !== stageId) return null;
  // On the stage's screen, where it fell before a stage was assigned there: off it, onto any screen it may use.
  if (currentId !== null && currentId === stageId) return displayIds.find(allowed) ?? null;
  return addedIds.find(allowed) ?? null;
}

/**
 * Which screen the stage window opens on: the chosen one (`stage.displayId`)
 * while it is connected — never the projector's. Fullscreen and always on top,
 * it would cover what the congregation watches, and before the service it
 * would BE what they watch: the projector opens on the first GO LIVE, the
 * stage as soon as its screen is there. The projector's screen is where GO
 * LIVE opens it (`projectorDisplayFor`: its chosen screen while connected,
 * else the first that is neither the operator's nor the stage's). A stage chosen there stays
 * off rather than jumping to a screen nobody chose, and comes back on its own
 * once the projector moves elsewhere (owner, 2026-11-06). The operator's own
 * screen is the exception: there both are movable windows (one screen,
 * testing). `null` = no stage window.
 */
export function chooseStageDisplay(
  displayIds: readonly number[],
  operatorId: number,
  stageId: number | null,
  projectorPreferredId: number | null,
): number | null {
  if (stageId === null || !displayIds.includes(stageId)) return null;
  if (stageId === operatorId) return stageId;
  return stageId === projectorDisplayFor(displayIds, operatorId, projectorPreferredId, stageId) ? null : stageId;
}
