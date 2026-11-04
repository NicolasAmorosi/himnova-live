import { api } from "@renderer/lib/api";
import {
  useProjectionStore,
  type LiveDeck,
  type ProjectionStoreState,
} from "@renderer/stores/projection.store";
import { DECK_SOUNDTRACK_TRACK_ID, useAudioStore } from "@renderer/stores/audio.store";
import { restartDeckSounds } from "./deck-sounds";
import { mediaTargetKey } from "@shared/types/projection";
import { SLIDES_MIN_ADVANCE_MS } from "@shared/constants";

/** Fixed identity for the deck's own soundtrack track — routes both the
 *  `mediaCommand` calls below and the `mediaStatus` read they react to. */
const DECK_AUDIO_TARGET = { kind: "audio", trackId: DECK_SOUNDTRACK_TRACK_ID } as const;
const DECK_AUDIO_STATUS_KEY = mediaTargetKey(DECK_AUDIO_TARGET);

/**
 * Deck auto-advance lives in the CONTROL window, never in the projection
 * window — the projection window stays a pure function of its declarative
 * inputs (`display-content` + `audio-tracks`).
 *
 * Two modes:
 *
 * - **synced** (a deck with a soundtrack, before any manual navigation): the
 *   slide index is derived from the audio element's own clock. Every
 *   `media-status` re-derives which slide should be up and re-arms a single
 *   timeout, so a ten-minute soundtrack cannot accumulate drift — the timer is
 *   a latency optimization, not the clock.
 * - **detached** (after the operator navigates by hand, or when there is no
 *   soundtrack): a monotonic deadline chain. The music keeps playing exactly
 *   where it was — the operator moved the slide, not the song — and advancing
 *   resumes relative to the slide they picked.
 */

/**
 * Scheduler state, deliberately module-level: the imperative half of this
 * module (`notifyManualNavigation`, `pauseAutoplay`, `resyncDeck`, …) is called
 * from `lib/actions/*`, which hold no handle on any instance and never will —
 * there is exactly one projector and therefore exactly one deck clock.
 *
 * `activeInstance` is what makes that assumption explicit instead of implicit.
 * Only the newest `startDeckAutoplay` owns this state, so a teardown that is
 * really a re-setup (StrictMode's double mount, an HMR swap) cannot reset the
 * state belonging to the setup that replaced it — and, symmetrically, the owner
 * that does tear down leaves nothing behind: `seededEpoch` used to survive it,
 * so a deck reopened afterwards found its epoch already "seeded" and started
 * the soundtrack from 0 instead of from the slide that was up.
 */
let timer: ReturnType<typeof setTimeout> | null = null;
/** Bumped on every manual navigation so a `media-status` already in flight
 *  can't yank the slide back a beat later. */
let navEpoch = 0;
let deadline = 0;
let seededEpoch = -1;
let activeInstance = 0;

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** BLACK/LOGO pauses the deck's own soundtrack (`projection-sync.ts`), and,
 *  so the two can never drift apart, must freeze slide auto-advance right
 *  along with it — otherwise this module's wall-clock timers would keep
 *  firing while the audio sits paused behind the overlay, and uncovering
 *  would reveal a slide further ahead than the music. A deck with no
 *  soundtrack has nothing to stay in sync with, so it's left untouched
 *  (matches the existing `liveDeck?.soundtrack` guard on `pauseAutoplay`). */
function isFrozenByCover(state: Pick<ProjectionStoreState, "overlay" | "liveDeck">): boolean {
  return state.overlay !== "none" && !!state.liveDeck?.soundtrack;
}

function advanceMsFor(deck: LiveDeck, slideIndex: number): number | null {
  const advance = deck.slides[slideIndex - 1]?.advanceAfterMs;
  return advance === null || advance === undefined
    ? null
    : Math.max(SLIDES_MIN_ADVANCE_MS, advance);
}

/** Last slide whose boundary is at or before `timeMs`. */
function slideAtAudioTime(deck: LiveDeck, timeMs: number): number {
  let index = 1;
  for (let n = 1; n <= deck.slides.length; n += 1) {
    const boundary = deck.cumulativeMs[n];
    if (boundary === undefined || boundary > timeMs) break;
    index = n;
  }
  return index;
}

function scheduleDetached(): void {
  clearTimer();
  const state = useProjectionStore.getState();
  const { liveDeck, base, autoplay } = state;
  if (autoplay !== "playing" || !liveDeck || base?.kind !== "deck") return;
  if (isFrozenByCover(state)) return;

  const advance = advanceMsFor(liveDeck, base.slideIndex);
  if (advance === null) return;

  const epochAtSchedule = navEpoch;
  // Monotonic chain: a late timeout must not push every later boundary out.
  deadline = Math.max(deadline, performance.now()) + advance;
  const delay = Math.max(0, deadline - performance.now());

  timer = setTimeout(() => {
    if (epochAtSchedule !== navEpoch) return;
    const current = useProjectionStore.getState();
    if (current.autoplay !== "playing" || current.base?.kind !== "deck") return;

    const next = current.base.slideIndex + 1;
    if (next > (current.liveDeck?.slides.length ?? 0)) {
      current.setAutoplay("finished");
      return;
    }
    current.setSlideIndex(next);
    scheduleDetached();
  }, delay);
}

function scheduleSynced(audioTimeMs: number): void {
  clearTimer();
  const state = useProjectionStore.getState();
  const { liveDeck, base, autoplay } = state;
  if (autoplay !== "playing" || !liveDeck || base?.kind !== "deck") return;
  if (isFrozenByCover(state)) return;

  const nextBoundary = liveDeck.cumulativeMs[base.slideIndex + 1];
  if (nextBoundary === undefined) return;

  const epochAtSchedule = navEpoch;
  // Land slightly early so the image swap happens ON the boundary, not after.
  const delay = Math.max(0, nextBoundary - audioTimeMs - 40);

  timer = setTimeout(() => {
    if (epochAtSchedule !== navEpoch) return;
    const current = useProjectionStore.getState();
    if (current.autoplay !== "playing" || current.base?.kind !== "deck") return;
    const next = current.base.slideIndex + 1;
    if (next > (current.liveDeck?.slides.length ?? 0)) {
      current.setAutoplay("finished");
      return;
    }
    current.setSlideIndex(next);
  }, delay);
}

/** Called by playback actions when the operator drives the deck by hand. */
export function notifyManualNavigation(): void {
  navEpoch += 1;
  const state = useProjectionStore.getState();
  // Manual navigation detaches the slide cursor from the audio clock: the
  // soundtrack keeps playing where it is (the chosen behaviour), and
  // auto-advance re-arms relative to the slide the operator picked.
  if (state.autoplayMode !== "detached") state.setAutoplayMode("detached");
  deadline = performance.now();
  if (state.autoplay === "playing") scheduleDetached();
  else clearTimer();
}

export function pauseAutoplay(): void {
  const state = useProjectionStore.getState();
  if (state.autoplay !== "playing") return;
  clearTimer();
  state.setAutoplay("paused");
  // Declarative now — see `AudioTrackPush.paused` — instead of a play/pause
  // command, so the pause survives a projection-window reload the same way
  // the rest of "what's live" does.
  if (state.liveDeck?.soundtrack) useAudioStore.getState().setPaused(DECK_SOUNDTRACK_TRACK_ID, true);
}

export function resumeAutoplay(): void {
  const state = useProjectionStore.getState();
  if (state.autoplay !== "paused" && state.autoplay !== "finished") return;
  state.setAutoplay("playing");
  deadline = performance.now();
  if (state.liveDeck?.soundtrack) useAudioStore.getState().setPaused(DECK_SOUNDTRACK_TRACK_ID, false);
  if (state.autoplayMode === "detached" || !state.liveDeck?.soundtrack) scheduleDetached();
}

export function toggleAutoplay(): void {
  const { autoplay } = useProjectionStore.getState();
  if (autoplay === "playing") pauseAutoplay();
  else if (autoplay === "paused" || autoplay === "finished") resumeAutoplay();
}

export function restartDeck(): void {
  const state = useProjectionStore.getState();
  if (state.base?.kind !== "deck") return;
  navEpoch += 1;
  deadline = performance.now();
  state.setSlideIndex(1);
  restartDeckSounds();
  state.setAutoplayMode("synced");
  if (state.liveDeck?.soundtrack) {
    useAudioStore.getState().setPaused(DECK_SOUNDTRACK_TRACK_ID, false);
    void api.projection.mediaCommand({ target: DECK_AUDIO_TARGET, action: "restart" });
  }
  if (state.liveDeck?.autoAdvance) {
    state.setAutoplay("playing");
    if (!state.liveDeck.soundtrack) scheduleDetached();
  }
}

/** Rejoins the audio clock after a manual navigation ("detached"): snaps the
 *  slide cursor back to whatever the soundtrack (still playing right where it
 *  was) says it should be, then hands scheduling back to `scheduleSynced`. A
 *  deck with no soundtrack has no clock to rejoin — for it this only clears
 *  the "detached" label, since `scheduleDetached` already drives both modes
 *  identically in that case (see `startDeckAutoplay`'s deck-key subscription). */
export function resyncDeck(): void {
  const state = useProjectionStore.getState();
  if (state.base?.kind !== "deck" || !state.liveDeck || state.autoplayMode !== "detached") return;
  navEpoch += 1;
  deadline = performance.now();

  const status = state.mediaStatus[DECK_AUDIO_STATUS_KEY];
  if (state.liveDeck.soundtrack && status) {
    const expected = slideAtAudioTime(state.liveDeck, status.currentTimeSeconds * 1000);
    if (expected !== state.base.slideIndex) state.setSlideIndex(expected);
  }

  state.setAutoplayMode("synced");
  if (state.autoplay !== "playing") return;
  if (state.liveDeck.soundtrack && status) scheduleSynced(status.currentTimeSeconds * 1000);
  else scheduleDetached();
}

export function startDeckAutoplay(): () => void {
  activeInstance += 1;
  const instance = activeInstance;

  // Re-arm whenever a deck is loaded or autoplay is toggled from elsewhere.
  const unsubscribeDeck = useProjectionStore.subscribe(
    (state) => `${state.liveDeck?.assetId ?? "none"}:${state.autoplay}:${state.autoplayMode}`,
    () => {
      const state = useProjectionStore.getState();
      if (state.autoplay !== "playing") {
        clearTimer();
        // Every GO LIVE passes through "off" (`setLiveDeck`). Without this
        // the next deck inherited the previous one's chain — `scheduleDetached`
        // builds on `max(deadline, now)` — and its first slide stayed up for
        // whatever was left of the old one's, putting every later slide that
        // much behind the singers. A resume sets its own fresh deadline.
        deadline = 0;
        return;
      }
      // Without a soundtrack there's no audio clock to sync to.
      if (!state.liveDeck?.soundtrack || state.autoplayMode === "detached") {
        scheduleDetached();
      }
    },
  );

  const unsubscribeStatus = useProjectionStore.subscribe(
    (state) => state.mediaStatus[DECK_AUDIO_STATUS_KEY],
    (status) => {
      if (!status) return;
      const state = useProjectionStore.getState();
      const deck = state.liveDeck;
      if (!deck?.soundtrack || state.base?.kind !== "deck") return;

      // Reopening the projection window mid-deck gives us a fresh <audio> that
      // starts at 0. Seek it back to where the current slide belongs — but only
      // while still synced; a detached deck's music is intentionally elsewhere.
      if (seededEpoch !== state.soundtrackEpoch) {
        seededEpoch = state.soundtrackEpoch;
        const expected = deck.cumulativeMs[state.base.slideIndex] ?? 0;
        if (state.autoplayMode === "synced" && expected > 0 && status.currentTimeSeconds < 0.5) {
          void api.projection.mediaCommand({
            target: DECK_AUDIO_TARGET,
            action: "seek",
            timeSeconds: expected / 1000,
          });
          return;
        }
      }

      if (status.ended) {
        // Only the synced deck ends with its music. A detached one — the
        // operator stepped back to repeat a chorus — still has slides on its
        // own clock, and whichever of the two ends LAST decides
        // (`end-of-playback.ts`): finishing here cut it to the logo with
        // slides still unshown.
        if (state.autoplayMode !== "synced") return;
        clearTimer();
        if (state.autoplay === "playing") state.setAutoplay("finished");
        return;
      }
      if (state.autoplay !== "playing" || state.autoplayMode !== "synced") return;
      // Guards against the `pause` status event that covering itself causes:
      // without this, `scheduleSynced` would arm a real-time timeout against
      // a clock that has actually stopped advancing behind the overlay.
      if (isFrozenByCover(state)) return;
      // A stopped clock arms nothing. The media engine keeps reporting a soundtrack it holds paused
      // (the projector closed under it), where an `<audio>` went away with its window and fell
      // silent: re-arming on each report would advance the slide while the music stands still.
      if (status.paused) {
        clearTimer();
        return;
      }

      const audioTimeMs = status.currentTimeSeconds * 1000;
      const expected = slideAtAudioTime(deck, audioTimeMs);
      if (expected !== state.base.slideIndex) state.setSlideIndex(expected);
      scheduleSynced(audioTimeMs);
    },
  );

  // Freezes/re-arms auto-advance in lockstep with BLACK/LOGO covering the
  // deck's soundtrack (see `isFrozenByCover`). "synced" mode needs no explicit
  // re-arm here: resuming the `<audio>` element fires its own `play` event,
  // which reaches `unsubscribeStatus` above and reschedules from there.
  // "detached" mode has no such signal — its timer is pure wall-clock — so it
  // has to be re-armed explicitly once uncovered.
  const unsubscribeOverlay = useProjectionStore.subscribe(
    (state) => state.overlay,
    (overlay) => {
      const state = useProjectionStore.getState();
      if (!state.liveDeck?.soundtrack || state.base?.kind !== "deck") return;
      if (overlay !== "none") {
        clearTimer();
        return;
      }
      if (state.autoplay === "playing" && state.autoplayMode === "detached") scheduleDetached();
    },
  );

  return () => {
    // Always: these belong to this instance alone.
    unsubscribeDeck();
    unsubscribeStatus();
    unsubscribeOverlay();

    // The shared scheduler state belongs to whichever instance is current —
    // resetting it from a superseded one would clear the live deck's clock.
    if (instance !== activeInstance) return;
    clearTimer();
    // Retires any timeout that escaped `clearTimer` by already being in its
    // callback: they all re-check `navEpoch` before touching the store.
    navEpoch += 1;
    deadline = 0;
    seededEpoch = -1;
  };
}
