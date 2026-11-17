/**
 * GO LIVE on the time scene that is already on the projector.
 *
 * What is live wins everywhere in the control window (`clockForScene`), so
 * PREVIEW shows the running countdown — and pressing GO LIVE on it must not
 * restart it from its full duration, nor touch a clock the operator armed on
 * another scene. It only uncovers it.
 */
import { beforeEach, expect, test } from "vitest";
import { goLive } from "@renderer/lib/actions/playback";
import { useDisplayStore } from "@renderer/stores/display.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useUtilityStore } from "@renderer/stores/utility.store";
import { DEFAULT_SCENE_STYLE } from "@shared/types/scene-style";
import { DEFAULT_TIMER_FORMAT, type TimerClock } from "@shared/types/timer";
import type { UtilityScene } from "@shared/types/utility";

const countdown = (id: number): UtilityScene => ({
  id,
  name: `Cuenta ${id}`,
  tool: "countdown",
  config: { durationMs: 600_000, targetMinuteOfDay: 600, endMessage: null, format: DEFAULT_TIMER_FORMAT },
  style: DEFAULT_SCENE_STYLE,
  title: null,
  message: null,
});

const a = countdown(1);
const b = countdown(2);
const initialProjection = useProjectionStore.getState();
const initialUtility = useUtilityStore.getState();

beforeEach(() => {
  useProjectionStore.setState(initialProjection, true);
  useUtilityStore.setState(initialUtility, true);
  useUtilityStore.getState().setScenes([a, b]);
  useDisplayStore.setState({ openIfNeeded: async () => {} });
});

test("GO LIVE on the countdown already on air keeps its clock and only uncovers it, with a fade", async () => {
  usePreviewStore.getState().setTarget({ kind: "utility", sceneId: a.id });
  await goLive();
  const base = useProjectionStore.getState().base;
  if (base?.kind !== "utility") throw new Error("the countdown did not go live");
  const running: TimerClock = base.clock;
  const epoch = useProjectionStore.getState().sceneEpoch;

  // The operator arms the next one, then covers the projector.
  const armed: TimerClock = { mode: "countdown", state: "held", remainingMs: 120_000 };
  useUtilityStore.getState().arm(b.id, armed, false);
  useProjectionStore.getState().setOverlay("black");

  usePreviewStore.getState().setTarget({ kind: "utility", sceneId: a.id });
  await goLive();

  const after = useProjectionStore.getState();
  expect(after.base).toMatchObject({ kind: "utility", sceneId: a.id, clock: running });
  // Uncovered with a fade, one new scene, as VIVO does (owner, 2026-11-16, audit U17): it was a cut.
  expect(after.sceneEpoch).toBe(epoch + 1);
  expect(after.overlay).toBe("none");
  expect(useUtilityStore.getState().run).toEqual({ sceneId: b.id, clock: armed, started: false });
});

test("GO LIVE on the countdown already on air and not covered sends nothing: no scene, no fade", async () => {
  usePreviewStore.getState().setTarget({ kind: "utility", sceneId: a.id });
  await goLive();
  const epoch = useProjectionStore.getState().sceneEpoch;
  usePreviewStore.getState().setTarget({ kind: "utility", sceneId: a.id });
  await goLive();
  // A fade between the same pictures would flash under «fade through black».
  expect(useProjectionStore.getState().sceneEpoch).toBe(epoch);
});
