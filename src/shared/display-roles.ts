/**
 * Which screen the projector uses, shared by the control window (`display.store`, the next GO LIVE) and main
 * (`createProjectionWindow`, `chooseStageDisplay`) so the two never disagree.
 *
 * Its chosen screen while it is connected. Otherwise the first that is neither the operator's (it hosts the
 * control window) nor the stage's: «the first that is not the operator's» was, with three screens, sometimes
 * the stage's, and the next GO LIVE opened the service there and turned the stage off (2026-11-13).
 * The operator's own as the last resort, where it is a movable window. Pure.
 */
export function projectorDisplayFor(
  ids: readonly number[],
  operatorId: number,
  preferredId: number | null,
  stageId: number | null,
): number | null {
  if (preferredId !== null && ids.includes(preferredId)) return preferredId;
  return ids.find((id) => id !== operatorId && id !== stageId) ?? (ids.includes(operatorId) ? operatorId : (ids[0] ?? null));
}

/**
 * A 2.9 profile could leave the stage on the projector's screen: the stage just stayed off. 2.10 keeps the two apart,
 * and with three screens its first display event moved the projector to the third, mid-service (2026-11-15 final
 * review). Such a profile is read the way 2.9 played it: the projector keeps its screen and the stage loses its role.
 * The operator's own screen still holds both, as movable windows.
 */
export function stageSharesProjector(projectorId: number | null, stageId: number | null, operatorId: number): boolean {
  return stageId !== null && stageId === projectorId && stageId !== operatorId;
}
