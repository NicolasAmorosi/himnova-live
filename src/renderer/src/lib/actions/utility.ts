import { api } from "@renderer/lib/api";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { clockForScene, findScene, useUtilityStore } from "@renderer/stores/utility.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { holdClock, initialClock, isTimerRunning, resumeClock, seekCountdown } from "@shared/timer";
import type { TimerClock } from "@shared/types/timer";
import type { UtilityScene, UtilitySceneUpsert, UtilitySceneUsage } from "@shared/types/utility";

/**
 * The transport: start, pause, resume, reset and seek a scene's clock.
 *
 * These live in the actions layer because every one of them spans two stores
 * and, above all, because none of them can decide on its own WHERE its result
 * belongs. A scene's clock lives in one of two places, sometimes both:
 * `projection.store`'s `base` holds the copy the projector is drawing, and
 * `utility.store`'s `run` holds the one the operator armed without projecting
 * anything. `clockForScene` reads those two back in that order and
 * `commitClock` writes them in the same one — which is what lets the PREVIEW
 * row, the LIVE row and the Utilities list all carry a transport for the same
 * scene and still show one number.
 *
 * None of these begins a new scene. Pausing a countdown changes one field of
 * what is already on screen; treating it as a new scene would cross-fade the
 * projector into an almost identical copy of itself, mid-service.
 */

/** Is this scene what the projector is showing right now? */
function isLive(scene: UtilityScene): boolean {
  const { base } = useProjectionStore.getState();
  return base?.kind === "utility" && base.sceneId === scene.id;
}

/** The clock this scene is being drawn with at this instant, wherever it lives. */
function currentClock(scene: UtilityScene): TimerClock {
  return clockForScene(useProjectionStore.getState().base, useUtilityStore.getState().run, scene, Date.now());
}

/** Whether this scene's count was ever started — the bit `TimerClock`
 *  deliberately does not carry, and the one that decides whether the button
 *  offers START or RESUME. A live scene reached the projector through
 *  `ensureStarted`, so it counts as started even after the armed slot has
 *  moved on to another scene. */
function isStarted(scene: UtilityScene): boolean {
  const { run } = useUtilityStore.getState();
  return run?.sceneId === scene.id ? run.started : isLive(scene);
}

/**
 * Writes a clock the transport just computed to every place this scene's clock
 * lives.
 *
 * The projector gets it whenever the scene is live, through `setTimerClock`,
 * which patches `base` in place — **never** `beginScene()`. The armed slot gets
 * it when it already holds this scene, and also whenever the scene is not live
 * at all, which is what makes pressing play on a PREVIEW row arm the timer in
 * the first place.
 *
 * What it deliberately does not do is arm a live scene while a DIFFERENT
 * scene's timer is armed: the operator prepared that other countdown on
 * purpose, and pausing what is on screen is no reason to throw it away.
 */
function commitClock(scene: UtilityScene, clock: TimerClock, started: boolean): void {
  const live = isLive(scene);
  if (live) useProjectionStore.getState().setTimerClock(clock);
  const { run, arm } = useUtilityStore.getState();
  if (!live || run?.sceneId === scene.id) arm(scene.id, clock, started);
}

/** Back to the scene's starting value, stopped: what the row's «restart» and
 *  the list's STOP both do. */
export function resetTimer(scene: UtilityScene): void {
  commitClock(scene, initialClock(scene.tool, scene.config, Date.now()), false);
}

/**
 * The single play/pause control, so one button can never disagree with the
 * state it is describing: running → freeze it; held → continue from where it
 * stopped.
 *
 * There is no third branch for "never started". A scene nobody has armed rests
 * at its starting value, so resuming it and starting it are the same operation
 * on the same clock — the difference is only what the button is CALLED, which
 * is `isStarted`'s job.
 */
export function toggleTimer(scene: UtilityScene): void {
  const now = Date.now();
  const clock = currentClock(scene);
  commitClock(scene, isTimerRunning(clock) ? holdClock(clock, now) : resumeClock(clock, now), true);
}

/**
 * Moves a countdown to the point the operator dropped the bar on.
 *
 * Only a countdown by duration offers this — the one tool with a total for a
 * position to be inside — and it changes nothing about whether the count is
 * running: a paused countdown stays paused where it landed, and one that was
 * never started stays un-started, so the button still reads START.
 */
export function seekTimer(scene: UtilityScene, remainingMs: number): void {
  commitClock(scene, seekCountdown(currentClock(scene), remainingMs, Date.now()), isStarted(scene));
}

/* -------------------------------------------------------------------------
 * The saved scenes
 *
 * `utility.store.scenes` is a MIRROR of `utility_scenes`, never a second copy
 * that drifts: every write below re-reads the list main answered with instead
 * of patching the array in place. The list is a handful of rows and main is
 * its only writer, so there is nothing to win by being clever and a stale row
 * to lose.
 * ---------------------------------------------------------------------- */

/** Reads the list into the store. Called once at boot, and after every write.
 *  Never throws: a control window that cannot list its scenes still has to
 *  start, the same rule the draft restore follows. */
export async function loadScenes(): Promise<void> {
  try {
    useUtilityStore.getState().setScenes(await api.utility.list());
  } catch (error) {
    console.warn("[utility] could not load the saved scenes", error);
    toast.danger(t("utilities.loadError"));
  }
}

/**
 * Creates or updates a scene, and re-dresses the projector when the scene
 * edited is the one that is live.
 *
 * Two things happen after the write, in this order, and both matter:
 *
 * 1. `setLiveScene` patches `base.scene` in place — the F2 gate. No
 *    `beginScene()`, so no transition; the mark inside `base.clock` is
 *    untouched, so the count does not restart.
 * 2. If the TOOL changed, the armed timer is re-armed from the new tool's
 *    starting value: an `endsAtMs` means nothing to a stopwatch, and a clock
 *    of the wrong mode would draw a number nobody can explain. This is the one
 *    edit that deliberately resets a running count, which is why the editor
 *    says so.
 */
export async function saveScene(input: UtilitySceneUpsert): Promise<UtilityScene | null> {
  const previous = input.id === undefined ? null : findScene(useUtilityStore.getState().scenes, input.id);
  try {
    const scene =
      input.id === undefined
        ? await api.utility.create(input)
        : await api.utility.update({ ...input, id: input.id });
    await loadScenes();

    useProjectionStore.getState().setLiveScene(scene);
    if (previous !== null && previous.tool !== scene.tool) {
      // Only where a clock for this scene actually exists. Anywhere else
      // `resetTimer` would ARM the scene (see `commitClock`), turning an edit
      // in a modal into "the operator armed this timer", which they did not.
      const { run } = useUtilityStore.getState();
      if (run?.sceneId === scene.id || isLive(scene)) resetTimer(scene);
    }
    return scene;
  } catch (error) {
    console.warn("[utility] could not save the scene", error);
    toast.danger(t("utilities.saveError"));
    return null;
  }
}

export async function duplicateScene(id: number, name: string): Promise<UtilityScene | null> {
  try {
    const scene = await api.utility.duplicate(id, name);
    await loadScenes();
    return scene;
  } catch (error) {
    console.warn("[utility] could not duplicate the scene", error);
    toast.danger(t("utilities.saveError"));
    return null;
  }
}

/**
 * Deletes a scene. With `force`, the items of every saved program that
 * references it go too, in main's own transaction — the operator has just read
 * the list of those programs and confirmed anyway (see `utility:usages`).
 * Without it, main refuses with `UTILITY_SCENE_IN_USE`, which is what raises
 * that confirmation in the first place.
 *
 * What is on the projector is deliberately left alone. `base` holds a RESOLVED
 * copy of the scene (see `BaseContent`'s `utility` variant), so a countdown
 * that is live keeps counting on the screen the congregation is watching —
 * pulling it out from under them because the operator tidied a list would be
 * the app making a decision about the service. The armed timer does go, in
 * `setScenes`: a transport for a scene that no longer exists can neither be
 * restarted nor projected.
 *
 * The UNSAVED order of service is the one thing main cannot clean up, because
 * a draft is a JSON blob and not rows an FK can reach — so its items are
 * dropped here, the same way `purgeAsset` does it for a deleted asset. The
 * preview follows: a target pointing at a scene that is gone would render a
 * pane that can never explain itself.
 */
export async function deleteScene(id: number, force = false): Promise<boolean> {
  try {
    await api.utility.remove(id, force);
    await loadScenes();
    useProgramStore.getState().removeByUtilityScene(id);
    const target = usePreviewStore.getState().target;
    if (target?.kind === "utility" && target.sceneId === id) usePreviewStore.getState().clear();
    return true;
  } catch (error) {
    console.warn("[utility] could not delete the scene", error);
    toast.danger(t("utilities.deleteError"));
    return false;
  }
}

/** Whether the open order of service has the scene — no saved program lists
 *  that, and `deleteScene` takes it out of there too, so the confirmation says
 *  so (owner, 2026-11-06). */
export function isSceneInSchedule(id: number): boolean {
  return useProgramStore.getState().items.some((item) => item.kind === "utility" && item.utilitySceneId === id);
}

/** Which saved programs an about-to-be-deleted scene appears in. Never throws:
 *  a confirmation that cannot list them still has to open — main refuses the
 *  delete on its own either way, so the worst case is a dialog with less to
 *  say, never a delete that slips through. */
export async function sceneUsages(id: number): Promise<UtilitySceneUsage[]> {
  try {
    return await api.utility.usages(id);
  } catch (error) {
    console.warn("[utility] could not read the scene's usages", error);
    return [];
  }
}

/** Applies the operator's manual order. Replaces the list with what was
 *  actually persisted rather than the optimistic guess, like `reorderPrograms`. */
export async function reorderScenes(ids: number[]): Promise<void> {
  try {
    useUtilityStore.getState().setScenes(await api.utility.reorder(ids));
  } catch (error) {
    console.warn("[utility] could not reorder the scenes", error);
    toast.danger(t("utilities.reorderError"));
    await loadScenes();
  }
}
