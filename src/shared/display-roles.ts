/**
 * Which screen the projector uses, shared by the control window (`display.store`, the next GO LIVE) and main
 * (`createProjectionWindow`, `chooseStageDisplay`) so the two never disagree.
 *
 * Its chosen screen while it is connected. Otherwise the first that is neither the operator's (it hosts the
 * control window) nor the stage's: «the first that is not the operator's» was, with three screens, sometimes
 * the stage's, and the next GO LIVE opened the service there and turned the stage off (plan 2026-11-13 §2.2).
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
