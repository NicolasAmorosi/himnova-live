import { api } from "@renderer/lib/api";
import {
  slideHoldMs,
  useProjectionStore,
  type LiveDeck,
  type ProjectionStoreState,
} from "@renderer/stores/projection.store";
import { DECK_AUDIO_STATUS_KEY, DECK_SOUNDTRACK_TRACK_ID, useAudioStore } from "@renderer/stores/audio.store";
import { restartDeckSounds } from "./deck-sounds";
import { SLIDES_MIN_ADVANCE_MS } from "@shared/constants";

/** Fixed identity for the deck's own soundtrack track — routes both the
 *  `mediaCommand` calls below and the `mediaStatus` read they react to. */
const DECK_AUDIO_TARGET = { kind: "audio", trackId: DECK_SOUNDTRACK_TRACK_ID } as const;

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
/** Set by «Reiniciar»: a report the projector sent before it applied the restart can still land after it, and a
 *  synced deck followed it back to the music's slide for an instant (1, 3, 1). Reports past slide 1 are dropped until
 *  the first one inside it, or `RESTART_GUARD_MS` (2026-11-15 audit, A17). */
let restartGuard: { epoch: number; boundaryMs: number; until: number } | null = null;
/** ponytail: a fixed bound, so a slide 1 shorter than a report's period cannot hold the deck forever; raise it if the
 *  engine's seek ever takes longer than this to report. */
const RESTART_GUARD_MS = 1000;
/** What was left of a detached slide's time when BLACK/LOGO froze it: uncovering gives it that. Building on the old
 *  deadline gave it a whole time more (2026-11-22 audit). Only for the same slide and navigation. */
let frozenLeft: { epoch: number; slide: number; ms: number } | null = null;

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

/** The slide on air's time on the wall clock: its «After» plus the transition it came in with, which PowerPoint plays
 *  before that time starts. A slide reached by a cut (a step back, a GO LIVE past slide 1) waits its time alone; the
 *  synced boundaries (`cumulativeMs`) are the music's and always count it. `slideEntryMs`, not `slideEntry`: with the
 *  presentations' transitions off the slide cuts in, and its transition still counts, or the chain ran ahead. */
function advanceMsFor(state: Pick<ProjectionStoreState, "slideEntryMs">, deck: LiveDeck, slideIndex: number): number | null {
  const after = deck.slides[slideIndex - 1]?.advanceAfterMs;
  if (after == null) return null;
  return Math.max(SLIDES_MIN_ADVANCE_MS, after + state.slideEntryMs);
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

/** `leftMs`: what is left of the slide's time when part of it already ran (the music ended mid-slide, BLACK/LOGO
 *  froze it); without it the slide gets its whole time. */
function scheduleDetached(leftMs?: number): void {
  clearTimer();
  const state = useProjectionStore.getState();
  const { liveDeck, base, autoplay } = state;
  if (autoplay !== "playing" || !liveDeck || base?.kind !== "deck") return;
  if (isFrozenByCover(state)) return;

  const advance = advanceMsFor(state, liveDeck, base.slideIndex);
  if (advance === null) return;

  const epochAtSchedule = navEpoch;
  // Monotonic chain: a late timeout must not push every later boundary out.
  deadline = leftMs === undefined ? Math.max(deadline, performance.now()) + advance : performance.now() + leftMs;
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

/** The soundtrack's own `ended` for the deck on air: past its end there is no music clock to follow or rejoin. */
export function musicIsOver(state: Pick<ProjectionStoreState, "mediaStatus" | "soundtrackEpoch">): boolean {
  const status = state.mediaStatus[DECK_AUDIO_STATUS_KEY];
  return status?.ended === true && status.epoch === state.soundtrackEpoch;
}

/** The music of a synced deck ended while its slides still had time, as half the hymnal's last slides do once the
 *  transitions count: PowerPoint keeps them up on their own times, and so does this. The slide the music left runs
 *  out what remains of its time, the rest go on detached, and the deck finishes with its last slide's. */
function runPastMusic(deck: LiveDeck, endedAtMs: number): void {
  const state = useProjectionStore.getState();
  if (state.base?.kind !== "deck") return;
  // Never back: a report that lost its position must not return the deck to slide 1.
  const endMs = Math.max(endedAtMs, deck.cumulativeMs[state.base.slideIndex] ?? 0);
  const slide = slideAtAudioTime(deck, endMs);
  const leftMs = (deck.cumulativeMs[slide + 1] ?? 0) - endMs;
  if (slideHoldMs(deck.slides, slide) === null || (slide >= deck.slides.length && leftMs <= 0)) {
    state.setAutoplay("finished");
    return;
  }
  if (slide !== state.base.slideIndex) state.setSlideIndex(slide);
  navEpoch += 1;
  // Arms the chain with the slide's whole time (the subscription), replaced at once by what is left of it.
  state.setAutoplayMode("detached");
  scheduleDetached(Math.max(0, leftMs));
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
  frozenLeft = null;
  state.setAutoplay("paused");
  // Declarative now — see `AudioTrackPush.paused` — instead of a play/pause
  // command, so the pause survives a projection-window reload the same way
  // the rest of "what's live" does.
  if (state.liveDeck?.soundtrack) useAudioStore.getState().setPaused(DECK_SOUNDTRACK_TRACK_ID, true);
}

export function resumeAutoplay(): void {
  const state = useProjectionStore.getState();
  if (state.autoplay !== "paused" && state.autoplay !== "finished") return;
  frozenLeft = null;
  // A deck that finished with its music plays again from the top, slides and music together: unpausing an ended
  // `<audio>` restarted the music alone, under a deck no longer following it.
  if (state.autoplay === "finished" && state.liveDeck?.soundtrack && musicIsOver(state)) {
    restartDeck();
    return;
  }
  state.setAutoplay("playing");
  deadline = performance.now();
  // Past the music's end (`runPastMusic`) there is nothing to unpause: playing an ended track starts it over.
  if (state.liveDeck?.soundtrack && !musicIsOver(state)) useAudioStore.getState().setPaused(DECK_SOUNDTRACK_TRACK_ID, false);
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
    const boundaryMs = state.liveDeck.cumulativeMs[2] ?? 0;
    restartGuard = { epoch: state.soundtrackEpoch, boundaryMs, until: performance.now() + RESTART_GUARD_MS };
    useAudioStore.getState().setPaused(DECK_SOUNDTRACK_TRACK_ID, false);
    // Under BLACK/LOGO only rewind: «restart» is a `play()` in the projector,
    // which beat the cover's declarative pause and sang behind the black.
    // Uncovering resumes it from 0, and the slides with it (`isFrozenByCover`).
    void api.projection.mediaCommand(
      state.overlay === "none"
        ? { target: DECK_AUDIO_TARGET, action: "restart" }
        : { target: DECK_AUDIO_TARGET, action: "seek", timeSeconds: 0 },
    );
  }
  if (state.liveDeck?.autoAdvance) {
    state.setAutoplay("playing");
    // `setAutoplay` may already have armed the chain (its subscription);
    // building on that deadline gave slide 1 two advances on every loop.
    deadline = performance.now();
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
  // Ended music has no clock to rejoin: its last report would hold the deck on one slide for good.
  if (musicIsOver(state)) return;
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
  const arm = () => {
    const state = useProjectionStore.getState();
    if (state.autoplay !== "playing") {
      clearTimer();
      // Every GO LIVE passes through "off" (`setLiveDeck`). Without this
      // the next deck inherited the previous one's chain (`scheduleDetached`
      // builds on `max(deadline, now)`), and its first slide stayed up for
      // whatever was left of the old one's, putting every later slide that
      // much behind the singers. A resume sets its own fresh deadline.
      deadline = 0;
      return;
    }
    // Without a soundtrack there's no audio clock to sync to.
    if (!state.liveDeck?.soundtrack || state.autoplayMode === "detached") {
      scheduleDetached();
    }
  };
  const unsubscribeDeck = useProjectionStore.subscribe(
    (state) => `${state.liveDeck?.assetId ?? "none"}:${state.autoplay}:${state.autoplayMode}`,
    arm,
  );
  // A control page that started over a deck already playing (`effects/live-copy.ts`) has no change to arm on: slide 1
  // stayed up (2026-11-15 audit, A30). ponytail: its slide gets its whole time again, since `deadline` was on the dead
  // page's clock; carry the time left in the copy if a slide shown twice as long ever matters.
  arm();

  const unsubscribeStatus = useProjectionStore.subscribe(
    (state) => state.mediaStatus[DECK_AUDIO_STATUS_KEY],
    (status) => {
      if (!status) return;
      const state = useProjectionStore.getState();
      const deck = state.liveDeck;
      if (!deck?.soundtrack || state.base?.kind !== "deck") return;
      // Another play's report (the previous deck's music, still in flight) is not this deck's clock.
      if (status.epoch !== state.soundtrackEpoch) return;
      if (restartGuard) {
        const stale = restartGuard.epoch === status.epoch && status.currentTimeSeconds * 1000 >= restartGuard.boundaryMs;
        if (stale && performance.now() < restartGuard.until) return;
        restartGuard = null;
      }

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
        // Held paused: an ended `<audio>` told to play again starts over from 0, as uncovering BLACK/LOGO did under the
        // tail's slides or a finished deck (the push folds the cover into `paused`). `restartDeck` plays it again.
        const track = useAudioStore.getState().tracks.find((t) => t.trackId === DECK_SOUNDTRACK_TRACK_ID);
        if (track && !track.paused) useAudioStore.getState().setPaused(DECK_SOUNDTRACK_TRACK_ID, true);
        // A detached deck (the operator stepped back to repeat a chorus) still has slides on its own clock, and
        // whichever of the two ends LAST decides (`end-of-playback.ts`): finishing here cut it to the logo with
        // slides still unshown. A synced one whose slides outlast the music goes on without it (`runPastMusic`).
        if (state.autoplayMode !== "synced") return;
        clearTimer();
        if (state.autoplay === "playing") runPastMusic(deck, status.currentTimeSeconds * 1000);
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
      // What a cover froze is good for that cover only, whatever went live under it: a GO LIVE of a picture uncovers
      // over the picture, and a value kept from there gave a later deck's slide its time left plus a whole time.
      const held = frozenLeft;
      if (overlay === "none") frozenLeft = null;
      if (!state.liveDeck?.soundtrack || state.base?.kind !== "deck") return;
      if (overlay !== "none") {
        // BLACK to LOGO finds no timer (the first cover cleared it) and keeps what BLACK froze.
        if (timer !== null) {
          frozenLeft = { epoch: navEpoch, slide: state.base.slideIndex, ms: Math.max(0, deadline - performance.now()) };
        }
        clearTimer();
        return;
      }
      const left = held?.epoch === navEpoch && held.slide === state.base.slideIndex ? held.ms : undefined;
      if (state.autoplay === "playing" && state.autoplayMode === "detached") scheduleDetached(left);
    },
  );

  // The music failed — a file the projector cannot open, an engine that died: a synced deck waited
  // on a clock that never runs, stuck on slide 1 with «next in 2 s» frozen (2026-11-10 review, A13).
  // It goes on with its slides' own timings, detached, as if the operator had taken it by hand.
  // `setAutoplayMode` arms the chain itself (the subscription above), from this fresh deadline.
  const unsubscribeError = useProjectionStore.subscribe(
    (state) => state.mediaErrors[DECK_AUDIO_STATUS_KEY],
    (error) => {
      const state = useProjectionStore.getState();
      if (!error || state.base?.kind !== "deck" || error.url !== state.liveDeck?.soundtrack?.url) return;
      if (state.autoplayMode !== "synced") return;
      navEpoch += 1;
      deadline = performance.now();
      state.setAutoplayMode("detached");
    },
  );

  return () => {
    // Always: these belong to this instance alone.
    unsubscribeDeck();
    unsubscribeStatus();
    unsubscribeOverlay();
    unsubscribeError();

    // The shared scheduler state belongs to whichever instance is current —
    // resetting it from a superseded one would clear the live deck's clock.
    if (instance !== activeInstance) return;
    clearTimer();
    // Retires any timeout that escaped `clearTimer` by already being in its
    // callback: they all re-check `navEpoch` before touching the store.
    navEpoch += 1;
    deadline = 0;
    seededEpoch = -1;
    restartGuard = null;
    frozenLeft = null;
  };
}
