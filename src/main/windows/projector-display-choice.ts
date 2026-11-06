/**
 * Which screen the projection window belongs on, once the list of screens
 * changes: the one the operator chose (`projection.displayId`) when it is
 * connected, else the first screen that is not the operator's own. Never the
 * primary one — that is the laptop, and a fullscreen, always-on-top window
 * there covers the control window. `null` when there is no such screen.
 *
 * Pure, so the rule is tested without Electron (`tests/main/projector-display-choice.test.ts`).
 */
export function chooseProjectorDisplay(
  displayIds: readonly number[],
  primaryId: number,
  preferredId: number | null,
): number | null {
  if (preferredId !== null && preferredId !== primaryId && displayIds.includes(preferredId)) return preferredId;
  return displayIds.find((id) => id !== primaryId) ?? null;
}

/**
 * Which screen the stage window opens on: the chosen one (`stage.displayId`)
 * while it is connected — never the projector's. Fullscreen and always on top,
 * it would cover what the congregation watches, and before the service it
 * would BE what they watch: the projector opens on the first GO LIVE, the
 * stage as soon as its screen is there. The projector's screen is where GO
 * LIVE opens it (`display.store`'s rule: its chosen screen while connected,
 * else the first that is not the operator's own). A stage chosen there stays
 * off rather than jumping to a screen nobody chose, and comes back on its own
 * once the projector moves elsewhere (owner, 2026-11-06). The operator's own
 * screen is the exception: there both are movable windows (one screen,
 * testing). `null` = no stage window.
 */
export function chooseStageDisplay(
  displayIds: readonly number[],
  primaryId: number,
  stageId: number | null,
  projectorPreferredId: number | null,
): number | null {
  if (stageId === null || !displayIds.includes(stageId)) return null;
  if (stageId === primaryId) return stageId;
  const projectorId =
    projectorPreferredId !== null && displayIds.includes(projectorPreferredId)
      ? projectorPreferredId
      : (displayIds.find((id) => id !== primaryId) ?? null);
  return stageId === projectorId ? null : stageId;
}
