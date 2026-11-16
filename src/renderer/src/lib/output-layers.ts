/**
 * What `OutputView` stacks after each push, and what becomes of its video hold: the one decision its layout effect
 * makes, pure so it can be tested without mounting anything. Refs, timers and the animation stay in the component.
 */
import type { ProjectionOutput, SlideEnter } from "@shared/types/projection";
import { isAnimatable, type LayerTransition } from "./transition";

/** One stacked scene, keyed by a local sequence number — NOT by
 *  `output.transition.epoch` directly, so a rapid run of scene changes never
 *  produces key gaps or reuses a stale one. */
export type Layer = {
  seq: number;
  output: ProjectionOutput;
  /** Set only on the outgoing half of a transition away from a video — see
   *  `freezeFrame` in `OutputView`. */
  frozenFrame?: HTMLCanvasElement | null;
};

/** A transition into a video, waiting at its first keyframe for that video's first frame. `seq` is the layer the room
 *  sees meanwhile: the outgoing one. */
export type LayerHold = { epoch: number; seq: number; durationMs: number };

export type LayerPush = {
  /** On screen now, oldest first; the last one is the top. Never empty. */
  layers: readonly Layer[];
  hold: LayerHold | null;
  output: ProjectionOutput;
  /** The previous push's `transition.epoch` and slide entry. */
  lastEpoch: number;
  lastEnterSeq: number | null;
  /** The key a new layer takes. */
  nextSeq: number;
  /** The last frame of the video that unmounted with this push, if it drew one. */
  frozenFrame: HTMLCanvasElement | null;
  /** PREVIEW never animates. */
  animate: boolean;
  /** A monitor showing a still mounts no video, so there is no first frame to wait for. */
  videoMounted: boolean;
  /** The video epoch whose first frame already arrived. */
  readyVideoEpoch: number | null;
};

export type LayerStep =
  /** The same scene while a fade or a hold is in flight: the top layer takes the push in place and the outgoing one
   *  stays, so the fade, its fallback and the hold go on as they were. */
  | { kind: "patch"; layers: [Layer, Layer] }
  /** One layer, nothing in flight: whatever was (its fallback, a hold) is over. */
  | { kind: "steady"; layers: [Layer] }
  /** A new scene over the one leaving. With `hold`, it waits for the video's first frame; without, it runs now. */
  | { kind: "transition"; layers: [Layer, Layer]; transition: LayerTransition; hold: LayerHold | null };

/** How a slide of the same scene arrives — a deck's slide by its file's own
 *  transition, a song's by its theme's fade. */
export function entryOf(output: ProjectionOutput): SlideEnter | null {
  return output.kind === "slide" || output.kind === "song" ? output.enter : null;
}

/**
 * Serializes everything in an output EXCEPT `transition` — used to tell a
 * genuinely new scene from a push that only bumped `sceneEpoch` while
 * showing the exact same thing (an action re-asserting an overlay that was
 * already up, say). `beginScene()` is called from the action layer based on
 * "did the operator do something", not "did the picture actually change" —
 * that distinction is occasionally wrong at the source (an action forcing an
 * overlay it didn't need to), and re-checking it here, once, means a push
 * like that can never animate a scene fading into an identical copy of
 * itself, no matter which action produced it.
 */
function sceneContentKey(output: ProjectionOutput): string {
  // `plates` is not the scene: putting a name on screen must not cross-fade
  // the stage under it (`PlateLayer` animates each plate on its own).
  return JSON.stringify(output, (key: string, value: unknown) =>
    key === "transition" || key === "plates" ? undefined : value,
  );
}

/** Drops the outgoing half of a finished transition, leaving one "steady"
 *  layer (`role` is derived from `layers.length`, so this is also what takes
 *  the survivor off its keyframe and back to a plain opacity). */
export function withoutOutgoing(layers: Layer[], seq: number): Layer[] {
  return layers.length > 1 && layers[0]?.seq === seq ? layers.slice(1) : layers;
}

/**
 * The rule that keeps the room from seeing black (audit A2): while a hold is pending, the layer the room sees is the
 * outgoing one, and nothing but the video's first frame (or the hold's cap) may take it down. A push of the same
 * scene (the LIVE fader, a pause, a plate) patches the top in place; a new scene replaces the video that never drew,
 * not the picture held on screen. The same patch in place keeps a fade running instead of cutting it.
 */
export function nextLayers(push: LayerPush): LayerStep {
  const { layers, output, hold } = push;
  const top = layers[layers.length - 1]!;
  // With a hold pending, `layers[0]` is the picture on screen and the top is a video with no frame yet.
  const onScreen = hold !== null ? layers[0] : undefined;
  const sameEpoch = push.lastEpoch === output.transition.epoch;
  const sameContent = sceneContentKey(top.output) === sceneContentKey(output);
  // Within a scene, a slide the deck moved forward onto plays its own way
  // in (`enter`); a new scene plays the scene fade, whatever slide it opens.
  const enter = entryOf(output);
  const slideEntered =
    sameEpoch && enter !== null && enter.seq !== push.lastEnterSeq && top.output.kind === output.kind;
  const layerTransition: LayerTransition | null = !sameEpoch ? output.transition : slideEntered ? enter : null;

  // A new video waits for its first frame with the previous picture on, cut or fade (owner, 2026-11-12: never
  // black in between) — see the video hold in `OutputView`.
  const incomingVideoEpoch = output.kind === "video" ? output.videoUnderlay?.epoch : undefined;
  const holdsForVideo =
    push.videoMounted &&
    incomingVideoEpoch !== undefined &&
    incomingVideoEpoch !== top.output.videoUnderlay?.epoch &&
    push.readyVideoEpoch !== incomingVideoEpoch;

  const sameScene = sameContent || !layerTransition;
  const outgoingInFlight = layers.length === 2 ? layers[0] : undefined;
  // A hold only goes on while what it waits for is still what is coming in.
  const holdStands = hold === null || (output.kind === "video" && output.videoUnderlay?.epoch === hold.epoch);
  if (push.animate && sameScene && outgoingInFlight && holdStands) {
    return { kind: "patch", layers: [outgoingInFlight, { seq: top.seq, output }] };
  }

  if (!push.animate || sameScene || (!isAnimatable(layerTransition) && !holdsForVideo)) {
    // Content-only refresh: same layer, same key, no animation. This is
    // what keeps navigating within a live deck/verse, a pause toggle, or
    // an overlay's own `covered` prop an instant, un-keyed swap — exactly
    // like before transitions existed. `sameContent` catches the case a
    // changed epoch alone can't: an action that begins a new scene without
    // the picture actually changing (see `sceneContentKey`).
    return { kind: "steady", layers: [{ seq: top.seq, output }] };
  }

  // A genuinely new scene: the current top becomes the outgoing layer, a
  // fresh one enters on top of it. Only two layers are ever kept — a
  // transition that arrives mid-flight replaces the pair outright (the
  // older of the two is dropped without waiting for its own animation),
  // rather than growing a queue. During a hold the one that leaves is the
  // picture still on screen, as it is: the video under it never drew, so
  // this push's frame of it is nothing.
  // The frame only belongs to a layer that WAS the video: the element also
  // unmounts when an overlay's own scene is replaced, and that layer paints
  // its own content.
  const outgoing: Layer = onScreen ?? {
    ...top,
    frozenFrame: top.output.kind === "video" ? push.frozenFrame : null,
  };
  return {
    kind: "transition",
    layers: [outgoing, { seq: push.nextSeq, output }],
    transition: layerTransition,
    hold: holdsForVideo
      ? { epoch: incomingVideoEpoch, seq: outgoing.seq, durationMs: layerTransition.durationMs }
      : null,
  };
}
