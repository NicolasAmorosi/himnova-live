import { api } from "@renderer/lib/api";
import { counters } from "@renderer/lib/counters";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import { useAudioStore } from "@renderer/stores/audio.store";
import { useBibleStore } from "@renderer/stores/bible.store";
import { operatorClosedProjector } from "@renderer/stores/display.store";
import { freezeLivePositions } from "@renderer/lib/actions/live-positions";
import { useProgramStore } from "@renderer/stores/program.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useStageStore } from "@renderer/stores/stage.store";
import { useUiStore } from "@renderer/stores/ui.store";
import type { MediaStatus } from "@shared/types/projection";

/**
 * The control window's copy of what is live, kept with main for a page of the window that starts again: its renderer
 * died and main reloaded it, or the error screen's «Recargar» (2026-11-15 audit, A30). A page that started blind
 * reached the room with its first push (the projector blanked, the music stopped) and with its first actions (CLEAR
 * left the music on, NEGRO taken off put out LOGO over the video, a new sound cut the one playing).
 *
 * Whole stores, not a list of fields: what is live is spread over several (the picture, the sounds, LIVE's mute, the
 * verse's chapter and cursor, the schedule's live row, the stage's countdown and message), and a field left out of a
 * list is the next blind spot. PREVIEW stays out: a page starts with it empty.
 *
 * Main keeps it as it comes and never reads it (`window:keepLiveCopy`). It is sent on every change of these stores,
 * in a microtask like the projector's output, so it trails the output by one message at most.
 */
type LiveCopy = {
  v: 1;
  projection: Partial<ReturnType<typeof useProjectionStore.getState>>;
  audio: Partial<ReturnType<typeof useAudioStore.getState>>;
  bible: Partial<ReturnType<typeof useBibleStore.getState>>;
  program: Partial<ReturnType<typeof useProgramStore.getState>>;
  stage: Partial<ReturnType<typeof useStageStore.getState>>;
  liveMuted: boolean;
  /** The operator closed the projector: a screen coming back, or this page starting, does not reopen it. */
  projectorClosedByOperator: boolean;
  counters: typeof counters;
};

/** A store's data: its state without its actions, which a copy cannot carry (nor a clone of it). */
function dataOf<T extends object>(state: T): Partial<T> {
  return Object.fromEntries(Object.entries(state).filter(([, value]) => typeof value !== "function")) as Partial<T>;
}

export function takeLiveCopy(): LiveCopy {
  return {
    v: 1,
    projection: dataOf(useProjectionStore.getState()),
    audio: dataOf(useAudioStore.getState()),
    bible: dataOf(useBibleStore.getState()),
    program: { ...dataOf(useProgramStore.getState()), selectedIndex: null },
    stage: dataOf(useStageStore.getState()),
    liveMuted: useUiStore.getState().liveMuted,
    projectorClosedByOperator: operatorClosedProjector.get(),
    counters: { ...counters },
  };
}

/** Puts a copy back into the stores, before any effect listens to them: none of this is a change to push. */
export function restoreLiveCopy(copy: LiveCopy, projectorOpen: boolean): void {
  // Asked of main, not copied: the projector may have been closed while no page listened.
  useProjectionStore.setState({ ...copy.projection, presentationOpen: projectorOpen });
  useAudioStore.setState(copy.audio);
  useBibleStore.setState(copy.bible);
  useProgramStore.setState(copy.program);
  useStageStore.setState(copy.stage);
  useUiStore.setState({ liveMuted: copy.liveMuted });
  operatorClosedProjector.set(copy.projectorClosedByOperator);
  Object.assign(counters, copy.counters);
}

function isLiveCopy(value: unknown): value is LiveCopy {
  return typeof value === "object" && value !== null && (value as { v?: unknown }).v === 1;
}

/** What `finishRecovery` still has to do once the effects listen. */
let recovery: { mediaStatus: MediaStatus[]; projectorLost: boolean; done: boolean } | null = null;

/**
 * Before the window is drawn: a launch, or a page starting again over what is live. Settings come first, so the
 * values `App` mirrors into the projection store at mount (the LOGO, the verse's look, LIVE's level) are the room's,
 * not the defaults for an instant. A copy that cannot be put back is `failed`: the page stays inert (`main.tsx`),
 * since a page that starts blind is what this exists to prevent.
 */
export async function recoverLiveState(): Promise<"launch" | "recovered" | "failed"> {
  let answer: Awaited<ReturnType<typeof api.window.liveCopy>>;
  try {
    answer = await api.window.liveCopy();
  } catch (error) {
    // ponytail: main's handler only returns a variable; an IPC that fails here fails everything after it too.
    console.warn("[control] could not ask for the live copy", error);
    return "launch";
  }
  if (answer.copy === null) return "launch";
  try {
    if (!isLiveCopy(answer.copy)) throw new Error("not a live copy of this build");
    await useSettingsStore.getState().load();
    restoreLiveCopy(answer.copy, answer.projectorOpen);
    // Open in the copy and gone now: it closed while no page listened, and its `projection-closed` went nowhere.
    const projectorLost = answer.copy.projection.presentationOpen === true && !answer.projectorOpen;
    recovery = { mediaStatus: answer.mediaStatus, projectorLost, done: false };
    return "recovered";
  } catch (error) {
    console.error("[control] the live copy could not be restored", error);
    return "failed";
  }
}

/** Whether this page started over what was live: then the schedule is the copy's, not the draft's. */
export function wasRecovered(): boolean {
  return recovery !== null;
}

/**
 * Once the effects listen: the projector's last report of its videos (fresh positions, and a video's end that came
 * while no page listened, so «Al terminar» still runs), and the operator is told. Once, whatever mounts twice.
 *
 * A projector that closed meanwhile gets what `projection-closed` would have done: the positions folded in and pushed
 * to main, so the projector opened next (by itself, or «Abrir pantalla») resumes where things were, not where each
 * started (2026-11-15 audit, A30 review).
 *
 * ponytail: an audio file that ended in the gap stays listed until taken off (main keeps no audio reports, and an
 * ended `<audio>` reports nothing more); keep them in main if the gap ever grows past a second or two.
 */
export function finishRecovery(): void {
  if (!recovery || recovery.done) return;
  recovery.done = true;
  for (const status of recovery.mediaStatus) useProjectionStore.getState().setMediaStatus(status);
  if (recovery.projectorLost) freezeLivePositions();
  toast.warning(t("app.controlRecovered"));
}

/** Keeps main's copy current: one send per synchronous batch of changes, like the projector's output. */
export function startLiveCopy(): () => void {
  let queued = false;
  const send = () => {
    queued = false;
    api.window.keepLiveCopy(takeLiveCopy()).catch((error: unknown) => console.warn("[control] live copy not kept", error));
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(send);
  };
  const unsubscribe = [
    useProjectionStore.subscribe(schedule),
    useAudioStore.subscribe(schedule),
    useBibleStore.subscribe(schedule),
    useProgramStore.subscribe(schedule),
    useStageStore.subscribe(schedule),
    useUiStore.subscribe((state, previous) => {
      if (state.liveMuted !== previous.liveMuted) schedule();
    }),
  ];
  schedule();
  return () => unsubscribe.forEach((off) => off());
}
