import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { mediaErrorKey, mediaTargetKey } from "@shared/types/projection";
import type {
  BaseContent,
  MediaStatus,
  OverlayState,
  ProjectionMediaError,
  ProjectionOutput,
  ProjectionOutputKind,
  SceneTransition,
  SlideVideo,
  SongVideo,
  LogoScene,
  VideoEndAction,
  VideoUnderlay,
} from "@shared/types/projection";
import type { SlideTransition, TransitionStyle } from "@shared/types/transition";
import type { DeckSlide, DeckSlideVideo, DeckSound, DeckSoundtrack } from "@shared/types/deck";
import type { TimerClock } from "@shared/types/timer";
import { hasReachedZero, holdClock, resumeClock } from "@shared/timer";
import type { UtilityScene } from "@shared/types/utility";
import { PLATE_KINDS, platesCollide, type Plate } from "@shared/types/overlay";
import { assetUrl } from "@shared/urls";
import { DEFAULT_BIBLE_STYLE, type BibleStyle } from "@shared/types/bible-style";
import type { SlideTextSettings } from "@shared/types/slide-model";
import { bibleOutputFor } from "@renderer/lib/bible-output";
import { timerOutputFor } from "@renderer/lib/utility-output";
import { plateOutputFor } from "@renderer/lib/plate-output";
import { footerAt, songBackgroundUrl, songBackgroundVideo, songOutputFor } from "@renderer/lib/song-output";
import { linesAt, translationAt, type SongPosition } from "@shared/song-jump";
import type { ResolvedSong, SongLanguage, SongTheme } from "@shared/types/song";
import { defaultMediaVolume } from "@renderer/stores/settings.store";

/** The deck currently loaded for projection — slide urls are durable, DB-backed
 *  and stable across restarts, so this is plain data with no session lifecycle. */
export type LiveDeck = {
  assetId: number;
  deckId: number;
  slides: DeckSlide[];
  soundtrack: DeckSoundtrack | null;
  /** The file's other sounds, each on its own slides (`effects/deck-sounds.ts`). */
  sounds: DeckSound[];
  /** The slides that carry a playable embedded video, by slide index. Almost
   *  always empty — a `.pps` hymnal deck never has one. */
  videos: DeckSlideVideo[];
  /** Audio timestamp at which slide i should appear; index 0 unused, so
   *  `cumulativeMs[n]` is the boundary for the 1-based slide n. */
  cumulativeMs: number[];
  autoAdvance: boolean;
};

export type AutoplayState = "off" | "playing" | "paused" | "finished";

/**
 * "synced" = the slide index is a function of audio time, so the schedule can
 * never drift. The first manual navigation switches to "detached": the operator
 * chose a slide, the music keeps playing where it was, and auto-advance
 * continues on a relative timer from that slide instead of snapping back.
 */
export type AutoplayMode = "synced" | "detached";

export type ProjectionStoreState = {
  base: BaseContent | null;
  overlay: OverlayState;
  logoUrl: string | null;
  /** LOGO without an image: `logo.name` and `logo.background`, mirrored by `App.tsx`. */
  logoScene: LogoScene;
  presentationOpen: boolean;
  /** Declarative, operator-set pause for the live video — see `VideoUnderlay`.
   *  Reset to `false` whenever `base` changes, so a fresh GO LIVE always
   *  starts playing. */
  videoPaused: boolean;
  /** 0..1 for the live video — the counterpart of `videoPaused`, and pushed
   *  the same way (inside `VideoUnderlay`). Reset by `setBase` to the
   *  `media.volume` default, so a level balanced for one clip never carries
   *  into the next one silently. */
  videoVolume: number;

  /** Identity of the live slide's video element — see `SlideVideo.epoch`.
   *  Advanced by everything that can change WHICH slide is live, and by
   *  nothing else: an overlay going up must not remount the element, or the
   *  video restarts every time the operator presses BLACK. */
  slideVideoEpoch: number;
  /** Operator's declarative pause for the live slide's video. Reset with the
   *  epoch, so a new slide always starts playing. */
  slideVideoPaused: boolean;
  /** Operator's level, or `null` while they haven't set one — the file's own
   *  declared level then applies, and the app default when it declares none.
   *  Three layers because each answers a different question, and collapsing
   *  them would make a deck authored at 40% come back at 100% the moment
   *  anyone touched any slider. */
  slideVideoVolume: number | null;
  /** Where the element would resume if it had to be mounted again — the same
   *  mount-time seek `VideoUnderlay.startAtSeconds` is, written by
   *  `freezeLivePositions()`. */
  slideVideoStartAt: number;
  /** The transition the live slide entered with: its own, when the deck
   *  moved forward onto it; `null` after a move back and at the start of a
   *  scene, which keeps the scene's own fade (decided by the owner,
   *  2026-10-26). Its identity in the output is `slideVideoEpoch`, which
   *  advances with every change of slide and nothing else. */
  slideEntry: SlideTransition | null;

  liveDeck: LiveDeck | null;
  autoplay: AutoplayState;
  autoplayMode: AutoplayMode;
  soundtrackEpoch: number;
  /** Keyed by `mediaTargetKey` — one slot per media element (the video, each
   *  live audio track) so two elements reporting at once can never overwrite
   *  each other's clock. */
  mediaStatus: Record<string, MediaStatus>;
  /** Keyed by `mediaErrorKey`, so it shares "video"/"audio:<id>" with
   *  `mediaStatus` and adds "scene" for the still image. At most one entry per
   *  element — a later failure of the same element replaces the earlier one.
   *
   *  Nothing here is authoritative about what the operator sees: a stored
   *  error only surfaces while its `url` is still what's live (see
   *  `ProjectionMediaError`), which is why an entry going stale costs nothing
   *  and needs no timer. */
  mediaErrors: Record<string, ProjectionMediaError>;

  /** Bumped exactly once per "send something new live" action — `goLive()`,
   *  `clearLive()`, `clearBaseContent()`, `toggleOverlay()`,
   *  `setOverlayDirect()` — never by
   *  `setBase`/`setSlideIndex`/`projectVerse` themselves. That asymmetry is
   *  what makes advancing a slide or a verse an instant cut while sending a
   *  new scene live fades: the projection window fades only when this
   *  changes, not merely because the pixels changed. See `beginScene()`. */
  sceneEpoch: number;
  transitionStyle: TransitionStyle;
  transitionDurationMs: number;
  /** `projection.videoEnd`, mirrored by `App.tsx` like the transition. */
  videoEnd: VideoEndAction;
  /**
   * How a verse is drawn, mirrored here from `settings["bible.style"]`.
   *
   * It lives in this store and not in `settings.store` because `selectOutput`
   * is a pure function of `ProjectionStoreState` and its memo compares that
   * tuple by reference — reaching into another store from inside it would
   * break both, exactly as the comment on `BaseContent`'s `utility` variant
   * says. Mirrored by an effect in `App.tsx`, the same way the two transition
   * settings already are.
   *
   * Changing it while a verse is live re-runs `selectOutput` WITHOUT touching
   * `sceneEpoch`, so the projector picks up the new look as an instant,
   * un-keyed swap (`OutputView`'s `sameEpoch` short-circuit) rather than
   * fading the verse into a near-identical copy of itself mid-service. That
   * is the same rule `setLiveScene` follows for a time scene, and here it
   * falls out of the epoch discipline for free.
   */
  bibleStyle: BibleStyle;
  /** `slides.fallbackFont` and `ui.locale`, mirrored by `App` like `bibleStyle`
   *  and carried by every `slide` output: the projector has no settings. */
  slideText: SlideTextSettings;
  /**
   * The overlay plates the operator has put up — RESOLVED copies, none
   * colliding with another (`platesCollide`), in `PLATE_KINDS` order so the projector's DOM order never
   * depends on which one went up first.
   *
   * Independent of `base` and of `overlay`: a plate stays "up" under BLACK and
   * while nothing is live, and `selectOutput` is what keeps it off the stage
   * then. None of the three actions below calls `beginScene()` — a plate is
   * not a new scene.
   */
  livePlates: readonly Plate[];
  /**
   * The auto-hide count of every live plate that has one, keyed by plate id —
   * a countdown `TimerClock`, the same absolute mark a time scene uses, so a
   * pause and a resume are `holdClock`/`resumeClock` and nothing new.
   *
   * Control-window state only: the projector never sees it (it is not an
   * input of `selectOutput`), and `tickPlateClocks` is what keeps it RUNNING
   * exactly while the plates are visible. A plate is always put up HELD, and
   * the effect in `effects/plate-auto-hide.ts` starts it on the same tick.
   */
  plateHideClocks: Readonly<Record<number, TimerClock>>;

  setBase: (base: BaseContent | null) => void;
  setOverlay: (overlay: OverlayState) => void;
  setLogoUrl: (url: string | null) => void;
  setLogoScene: (scene: LogoScene) => void;
  setPresentationOpen: (open: boolean) => void;
  setVideoPaused: (paused: boolean) => void;
  /** Moves where the live video would resume from if its element had to be
   *  mounted again — a projection window that died or is about to be recreated
   *  (see `lib/actions/live-positions.ts`). Patches `base` in place instead of
   *  going through `setBase`, which resets `videoPaused` and means "something
   *  new is live"; nothing about what the projector shows changes here, and
   *  `epoch` deliberately stays put so no `<video>` remounts. */
  setVideoResumeAt: (startAtSeconds: number) => void;
  /** Clamped here, not at the call sites: `HTMLMediaElement.volume` throws on
   *  an out-of-range value, and a slider can overshoot by a rounding error. */
  setVideoVolume: (volume: number) => void;

  /** The three slide-video counterparts of `setVideoPaused`/`setVideoVolume`/
   *  `setVideoResumeAt`, and they patch state in place for the same reason:
   *  none of them is "something new is live". */
  setSlideVideoPaused: (paused: boolean) => void;
  setSlideVideoVolume: (volume: number) => void;
  setSlideVideoResumeAt: (startAtSeconds: number) => void;

  /** Moves the live utility scene's clock: a pause, a resume, a reset.
   *
   *  Patches `base` in place, like `setVideoResumeAt`, and for the same
   *  reason: neither is "something new is live". Nothing on this path may call
   *  `beginScene()` — pausing a countdown must not cross-fade the projector
   *  into an almost identical copy of itself, and the `sameEpoch`
   *  short-circuit in `OutputView` is what keeps it from doing so. */
  setTimerClock: (clock: TimerClock) => void;

  /** Re-dresses the live utility scene after the operator edited it in the
   *  «Scenes» modal — a new background, a bigger number, a different end
   *  message.
   *
   *  Same rule as `setTimerClock`, and it is the whole F2 gate: editing what is
   *  already on the projector is not a new scene. Patching `base` in place
   *  keeps `sceneEpoch` still, so `OutputView` cuts straight to the new look
   *  instead of cross-fading the projector into a slightly different copy of
   *  itself, and the mark inside `base.clock` is untouched, so the count does
   *  not restart. A no-op unless this exact scene is the one that is live. */
  setLiveScene: (scene: UtilityScene) => void;

  /** Re-dresses the live song after it, or its theme, was saved — the
   *  `setLiveScene` of a song: `base` patched in place, no new scene, the
   *  projector cuts to the new words. `slideIndex` is where it lands (the
   *  caller keeps the operator on the same section and slide when it still
   *  exists). A no-op unless this song is the one live. */
  setLiveSong: (song: ResolvedSong, theme: SongTheme, sizeCqw: number, slideIndex: number) => void;
  /** Moves within the live song — a slide of the order (1-based, clamped) or
   *  a detour off it. A cut, like a verse, and it shows the lyrics again. */
  setSongPosition: (position: SongPosition) => void;
  /** The live song in another language, re-resolved and re-measured by the
   *  caller: same slide, same detour, never a new scene. */
  setSongLanguage: (language: SongLanguage, song: ResolvedSong, sizeCqw: number) => void;
  /** T: only the theme's background on the projector, or the lyrics back. */
  setLyricsHidden: (hidden: boolean) => void;

  setLiveDeck: (deck: LiveDeck | null) => void;
  setSlideIndex: (index: number) => void;
  setAutoplay: (state: AutoplayState) => void;
  setAutoplayMode: (mode: AutoplayMode) => void;
  setMediaStatus: (status: MediaStatus) => void;
  /** Records what the projector reported it could not load or decode. */
  setMediaError: (error: ProjectionMediaError) => void;
  /** Drops the status slot of every audio track that no longer exists.
   *
   *  Needed because a track's key embeds its epoch (`asset:<id>:<epoch>`, see
   *  `audio.store.ts`) and the epoch is bumped on every go-live — so sending
   *  the same audio live ten times created ten keys, and nothing ever removed
   *  any of them: not `removeTrack`, not `clear`. A long rehearsal left
   *  hundreds of dead entries, each one copied again on every single
   *  `setMediaStatus` (which runs ~4x/second per playing element).
   *
   *  Prunes `mediaErrors`'s audio entries in the same pass — they are keyed
   *  the same way and go stale for exactly the same reason. */
  pruneMediaStatus: (liveTrackIds: readonly string[]) => void;

  /** Marks "this is a new scene" — see `sceneEpoch`. Called once by every
   *  action that sends something new live, before it touches `base`/`overlay`,
   *  so the very first output already carries the new epoch. */
  beginScene: () => void;
  setTransitionSettings: (style: TransitionStyle, durationMs: number) => void;
  setVideoEnd: (videoEnd: VideoEndAction) => void;
  setBibleStyle: (style: BibleStyle) => void;
  setSlideText: (text: SlideTextSettings) => void;
  /** Puts a plate up, taking down whichever plate it collides with (`platesCollide`). */
  showPlate: (plate: Plate) => void;
  hidePlate: (id: number) => void;
  /** Re-dresses a plate that is up after the operator edited it — the
   *  `setLiveScene` of a plate. A no-op unless this exact plate is up. */
  setLivePlate: (plate: Plate) => void;
  /** Takes down every plate whose count has run out, then runs the remaining
   *  counts if the plates are visible and holds them if they are covered.
   *  Idempotent, and a no-op (same state, no notification) when nothing is
   *  due — `effects/plate-auto-hide.ts` calls it on every change it watches. */
  tickPlateClocks: (now: number) => void;
};

function orderedPlates(plates: readonly Plate[]): readonly Plate[] {
  return [...plates].sort((a, b) => PLATE_KINDS.indexOf(a.kind) - PLATE_KINDS.indexOf(b.kind));
}

/** A plate's count as it starts: held at its full length, until the effect
 *  sees the plates are visible. `undefined` for a plate with no auto-hide. */
function freshHideClock(plate: Plate): TimerClock | undefined {
  const { enabled, afterMs } = plate.style.autoHide;
  return enabled ? { mode: "countdown", state: "held", remainingMs: afterMs } : undefined;
}

/** Keeps only the clocks of `plates`, and sets `id`'s to `clock`. */
function withHideClock(
  clocks: Readonly<Record<number, TimerClock>>,
  plates: readonly Plate[],
  id: number,
  clock: TimerClock | undefined,
): Record<number, TimerClock> {
  const next: Record<number, TimerClock> = {};
  for (const plate of plates) {
    const kept = plate.id === id ? clock : clocks[plate.id];
    if (kept) next[plate.id] = kept;
  }
  return next;
}

/** The plates are on the stage — the negation of `selectPlates`' guard. */
function platesVisible(state: Pick<ProjectionStoreState, "overlay" | "base">): boolean {
  return state.overlay === "none" && state.base !== null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** A new slide is a new element: a fresh identity, playing, at the level the
 *  file asks for, from the beginning. Written as one object so the three
 *  actions that can change which slide is live cannot each reset a different
 *  subset of it. */
function freshSlideVideo(epoch: number): {
  slideVideoEpoch: number;
  slideVideoPaused: boolean;
  slideVideoVolume: number | null;
  slideVideoStartAt: number;
} {
  return {
    slideVideoEpoch: epoch + 1,
    slideVideoPaused: false,
    slideVideoVolume: null,
    slideVideoStartAt: 0,
  };
}

export const useProjectionStore = create<ProjectionStoreState>()(
  subscribeWithSelector((set, get) => ({
    base: null,
    overlay: "none",
    logoUrl: null,
    logoScene: { name: null, background: { kind: "solid", color: "#000000" } },
    presentationOpen: false,
    videoPaused: false,
    videoVolume: defaultMediaVolume(),

    slideVideoEpoch: 0,
    slideVideoPaused: false,
    slideVideoVolume: null,
    slideVideoStartAt: 0,
    slideEntry: null,

    liveDeck: null,
    autoplay: "off",
    autoplayMode: "synced",
    soundtrackEpoch: 0,
    mediaStatus: {},
    mediaErrors: {},

    sceneEpoch: 0,
    transitionStyle: "crossfade",
    transitionDurationMs: 300,
    videoEnd: "logo",
    bibleStyle: DEFAULT_BIBLE_STYLE,
    slideText: { fallbackFont: null, locale: "es" },
    livePlates: [],
    plateHideClocks: {},

    setBase: (base) =>
      set((state) => ({
        base,
        videoPaused: false,
        videoVolume: defaultMediaVolume(),
        slideEntry: null,
        ...freshSlideVideo(state.slideVideoEpoch),
      })),
    setOverlay: (overlay) => set({ overlay }),
    setLogoUrl: (logoUrl) => set({ logoUrl }),
    setLogoScene: (logoScene) => set({ logoScene }),
    setPresentationOpen: (presentationOpen) => set({ presentationOpen }),
    setVideoPaused: (videoPaused) => set({ videoPaused }),
    setVideoVolume: (volume) =>
      set((state) => {
        const clamped = Math.min(1, Math.max(0, volume));
        // No-op when nothing moved: this field is an input of `selectOutput`,
        // and a slider drag reports the same rounded value many times over.
        return state.videoVolume === clamped ? state : { videoVolume: clamped };
      }),
    setVideoResumeAt: (startAtSeconds) =>
      set((state) => {
        const { base } = state;
        if (base?.kind !== "video" || base.startAtSeconds === startAtSeconds) return state;
        return { base: { ...base, startAtSeconds } };
      }),

    setSlideVideoPaused: (slideVideoPaused) => set({ slideVideoPaused }),
    setSlideVideoVolume: (volume) =>
      set((state) => {
        const clamped = Math.min(1, Math.max(0, volume));
        // Same no-op guard as `setVideoVolume`, for the same reason: this is
        // an input of `selectOutput`'s memo and a slider drag reports the same
        // rounded value many times over.
        return state.slideVideoVolume === clamped ? state : { slideVideoVolume: clamped };
      }),
    setSlideVideoResumeAt: (startAtSeconds) =>
      set((state) =>
        state.slideVideoStartAt === startAtSeconds ? state : { slideVideoStartAt: startAtSeconds },
      ),

    setTimerClock: (clock) =>
      set((state) => {
        const { base } = state;
        // No-op guard: `base` is an input of `selectOutput`'s memo, so handing
        // back a new object would push an identical output to the projector.
        if (base?.kind !== "utility" || base.clock === clock) return state;
        return { base: { ...base, clock } };
      }),

    setLiveScene: (scene) =>
      set((state) => {
        const { base } = state;
        if (base?.kind !== "utility" || base.sceneId !== scene.id || base.scene === scene) return state;
        return { base: { ...base, scene } };
      }),

    setLiveSong: (song, theme, sizeCqw, slideIndex) =>
      set((state) => {
        const { base } = state;
        if (base?.kind !== "song" || base.songId !== song.id) return state;
        const index = clamp(slideIndex, 1, Math.max(1, song.slides.length));
        // A detour survives while its section does, on a slide it still has.
        const section = base.detour && song.sections.find((s) => s.key === base.detour?.sectionKey);
        const detour =
          base.detour && section
            ? {
                ...base.detour,
                slideIndex: clamp(base.detour.slideIndex, 1, section.slides.length),
                returnTo: index,
              }
            : null;
        // The same video file goes on; another theme's starts.
        const backgroundVideo = songBackgroundVideo(theme, base.backgroundVideo);
        if (
          base.song === song &&
          base.theme === theme &&
          base.sizeCqw === sizeCqw &&
          base.slideIndex === index &&
          base.backgroundVideo === backgroundVideo &&
          JSON.stringify(base.detour) === JSON.stringify(detour)
        ) {
          return state;
        }
        return { base: { ...base, song, theme, sizeCqw, slideIndex: index, detour, backgroundVideo } };
      }),

    setSongLanguage: (language, song, sizeCqw) =>
      set((state) => {
        const { base } = state;
        if (base?.kind !== "song" || base.songId !== song.id) return state;
        return { base: { ...base, language, song, sizeCqw } };
      }),

    setSongPosition: (position) =>
      set((state) => {
        const { base } = state;
        if (base?.kind !== "song") return state;
        const slideIndex = clamp(position.slideIndex, 1, Math.max(1, base.song.slides.length));
        const same =
          slideIndex === base.slideIndex &&
          JSON.stringify(position.detour) === JSON.stringify(base.detour) &&
          !base.lyricsHidden;
        return same
          ? state
          : {
              base: {
                ...base,
                slideIndex,
                detour: position.detour,
                lyricsHidden: false,
                enterSeq: base.enterSeq + 1,
              },
            };
      }),

    setLyricsHidden: (hidden) =>
      set((state) => {
        const { base } = state;
        if (base?.kind !== "song" || base.lyricsHidden === hidden) return state;
        return { base: { ...base, lyricsHidden: hidden } };
      }),

    setLiveDeck: (liveDeck) =>
      set((state) => ({
        liveDeck,
        autoplay: "off",
        autoplayMode: "synced",
        soundtrackEpoch: state.soundtrackEpoch + 1,
        slideEntry: null,
        ...freshSlideVideo(state.slideVideoEpoch),
      })),

    // Writing the cursor into `base` is what makes a slide change flow through
    // selectOutput -> projection:show like every other content change. The COM
    // version kept it in a side field that the output never read, which is why
    // BLACK/LOGO over a deck needed the window hide/show dance.
    setSlideIndex: (index) => {
      const { base, liveDeck } = get();
      if (base?.kind !== "deck" || !liveDeck) return;
      const next = clamp(index, 1, Math.max(1, liveDeck.slides.length));
      if (next === base.slideIndex) return;
      // The slide changed, so whatever video was on the old one is a different
      // element now — even when the new slide has none, in which case the
      // fresh identity is simply never used.
      // Forward onto a slide plays that slide's own way in, as the file says;
      // back is a cut — correcting a mistake mid-service must be instant.
      set((state) => ({
        base: { ...base, slideIndex: next },
        slideEntry: next > base.slideIndex ? (liveDeck.slides[next - 1]?.transition ?? null) : null,
        ...freshSlideVideo(state.slideVideoEpoch),
      }));
    },

    setAutoplay: (autoplay) => set({ autoplay }),
    setAutoplayMode: (autoplayMode) => set({ autoplayMode }),
    setMediaStatus: (status) =>
      set((state) => ({
        mediaStatus: { ...state.mediaStatus, [mediaTargetKey(status.target)]: status },
      })),

    setMediaError: (error) =>
      set((state) => ({
        mediaErrors: { ...state.mediaErrors, [mediaErrorKey(error.target)]: error },
      })),

    pruneMediaStatus: (liveTrackIds) =>
      set((state) => {
        const keep = new Set(
          liveTrackIds.map((trackId) => mediaTargetKey({ kind: "audio", trackId })),
        );
        const isStale = (key: string) => key.startsWith("audio:") && !keep.has(key);
        const staleStatus = Object.keys(state.mediaStatus).filter(isStale);
        const staleErrors = Object.keys(state.mediaErrors).filter(isStale);
        // No-op when there is nothing to drop: this runs on every change to
        // the live track list, and handing back a fresh object would make
        // every subscriber recompute for nothing.
        if (staleStatus.length === 0 && staleErrors.length === 0) return state;
        const mediaStatus = { ...state.mediaStatus };
        for (const key of staleStatus) delete mediaStatus[key];
        const mediaErrors = { ...state.mediaErrors };
        for (const key of staleErrors) delete mediaErrors[key];
        return { mediaStatus, mediaErrors };
      }),

    // Dropping the scene/video error slots here is what makes re-sending the
    // very same file a real retry: matching on url alone would keep painting
    // the old warning over a file the operator has since fixed or plugged
    // back in. Audio slots are deliberately untouched — they belong to the
    // track list's lifecycle, and `pruneMediaStatus` is what retires them.
    beginScene: () =>
      set((state) => {
        const sceneEpoch = state.sceneEpoch + 1;
        const keys = [
          mediaErrorKey({ kind: "scene" }),
          mediaErrorKey({ kind: "video" }),
          mediaErrorKey({ kind: "slideVideo" }),
        ];
        // The common case by far is that there is nothing to drop, and this
        // runs on every go-live: handing back a fresh `mediaErrors` object
        // would make its subscribers recompute for nothing.
        if (!keys.some((key) => key in state.mediaErrors)) return { sceneEpoch };
        const mediaErrors = { ...state.mediaErrors };
        for (const key of keys) delete mediaErrors[key];
        return { sceneEpoch, mediaErrors };
      }),
    setTransitionSettings: (transitionStyle, transitionDurationMs) =>
      set({ transitionStyle, transitionDurationMs }),
    setVideoEnd: (videoEnd) => set({ videoEnd }),
    setBibleStyle: (bibleStyle) => set({ bibleStyle }),
    setSlideText: (slideText) => set({ slideText }),
    showPlate: (plate) =>
      set((state) => {
        const livePlates = orderedPlates([...state.livePlates.filter((p) => !platesCollide(p, plate)), plate]);
        return {
          livePlates,
          plateHideClocks: withHideClock(state.plateHideClocks, livePlates, plate.id, freshHideClock(plate)),
        };
      }),
    hidePlate: (id) =>
      set((state) => {
        if (!state.livePlates.some((p) => p.id === id)) return state;
        const livePlates = state.livePlates.filter((p) => p.id !== id);
        return { livePlates, plateHideClocks: withHideClock(state.plateHideClocks, livePlates, id, undefined) };
      }),
    setLivePlate: (plate) =>
      set((state) => {
        const current = state.livePlates.find((p) => p.id === plate.id);
        if (!current || current === plate) return state;
        // A kind or position change can land on another plate: re-run the rule.
        const livePlates = orderedPlates([
          ...state.livePlates.filter((p) => p.id !== plate.id && !platesCollide(p, plate)),
          plate,
        ]);
        // An edit that leaves the auto-hide alone keeps the count where it
        // is — re-dressing a plate is not putting it up again. Changing the
        // auto-hide itself starts it over with what the operator just set.
        const sameAutoHide =
          current.style.autoHide.enabled === plate.style.autoHide.enabled &&
          current.style.autoHide.afterMs === plate.style.autoHide.afterMs;
        const clock = sameAutoHide ? state.plateHideClocks[plate.id] : freshHideClock(plate);
        return { livePlates, plateHideClocks: withHideClock(state.plateHideClocks, livePlates, plate.id, clock) };
      }),
    tickPlateClocks: (now) =>
      set((state) => {
        const visible = platesVisible(state);
        let changed = false;
        const plateHideClocks: Record<number, TimerClock> = {};
        const due = new Set<number>();
        for (const [key, clock] of Object.entries(state.plateHideClocks)) {
          const id = Number(key);
          if (visible && hasReachedZero(clock, now)) {
            due.add(id);
            changed = true;
            continue;
          }
          const next = visible ? resumeClock(clock, now) : holdClock(clock, now);
          if (next !== clock) changed = true;
          plateHideClocks[id] = next;
        }
        if (!changed) return state;
        return { plateHideClocks, livePlates: state.livePlates.filter((p) => !due.has(p.id)) };
      }),
  })),
);

/**
 * The single function that replaces the legacy `restorePrevious()`
 * (app.js:408-418). There is no "restore" step anymore: `base` already IS the
 * last thing chosen, so leaving black/logo is just `overlay = 'none'` and this
 * selector recomputes. The switch below is exhaustive — TypeScript refuses to
 * compile if a new BaseContent variant is added and not handled here.
 */
/** `base`'s own video identity, regardless of BLACK/LOGO — see `VideoUnderlay`. */
function selectVideoUnderlay(state: ProjectionStoreState): VideoUnderlay {
  if (state.base?.kind !== "video") return null;
  return {
    url: state.base.url,
    epoch: state.base.epoch,
    paused: state.videoPaused,
    startAtSeconds: state.base.startAtSeconds,
    volume: state.videoVolume,
    loop: state.videoEnd === "loop",
  };
}

/**
 * The video embedded in the live slide, if that slide has one.
 *
 * Reads `base`/`liveDeck` and deliberately NOT `overlay`: a slide video has to
 * survive BLACK/LOGO as a mounted, paused element, exactly like
 * `selectVideoUnderlay`'s does — the projector is what covers it. Asking about
 * the overlay here would unmount the element on every toggle and restart the
 * clip each time the operator uncovered the stage.
 */
function selectSlideVideo(state: ProjectionStoreState): SlideVideo {
  if (state.base?.kind !== "deck") return null;
  const deck = state.liveDeck;
  if (!deck || deck.assetId !== state.base.assetId || deck.slides.length === 0) return null;
  const index = clamp(state.base.slideIndex, 1, deck.slides.length);
  const video = deck.videos.find((candidate) => candidate.slideIndex === index);
  if (!video) return null;
  return {
    url: video.url,
    epoch: state.slideVideoEpoch,
    rect: video.rect,
    aspectRatio: video.aspectRatio,
    loop: video.loop,
    paused: state.slideVideoPaused,
    startAtSeconds: state.slideVideoStartAt,
    volume: state.slideVideoVolume ?? video.volume ?? defaultMediaVolume(),
  };
}

/** The live song's video background, kept under BLACK/LOGO like the slide's
 *  video — see `SongVideo`. */
function selectSongVideo(state: ProjectionStoreState): SongVideo | null {
  const { base } = state;
  if (base?.kind !== "song" || !base.backgroundVideo || base.theme.background.kind !== "video") return null;
  const posterUrl = songBackgroundUrl(base.theme);
  if (!posterUrl) return null;
  return { ...base.backgroundVideo, fit: base.theme.background.fit, posterUrl };
}

function logoKind(state: ProjectionStoreState): ProjectionOutputKind {
  const { background } = state.logoScene;
  return {
    kind: "logo",
    url: state.logoUrl,
    scene: state.logoScene,
    backgroundUrl: background.kind === "image" && background.assetId > 0 ? assetUrl(background.assetId) : null,
  };
}

function selectOutputWithoutUnderlay(state: ProjectionStoreState): ProjectionOutputKind {
  if (state.overlay === "black") return { kind: "black" };
  // `logoUrl` is null while no logo has been chosen (`App.tsx` mirrors
  // `logo.path` into it), and that null travels to the projector as-is: a
  // logo-less LOGO is a black stage, not a broken <img>. It used to fall back
  // to the bare `worship://logo`, which main answers with a 404 when there is
  // no `logo.path` — so the projector painted the browser's own broken-image
  // icon and reported a media error for a file nobody ever picked. Without
  // an image the projector draws the logo scene instead (black, unless the
  // operator or the starter look dressed it).
  if (state.overlay === "logo" || state.base === null) return logoKind(state);

  switch (state.base.kind) {
    case "deck": {
      const deck = state.liveDeck;
      // Defensive: presentSelected() doesn't set `base` until the deck is
      // ready, so this only trips if the window reloads before the store
      // repopulates.
      if (!deck || deck.assetId !== state.base.assetId || deck.slides.length === 0) {
        return { kind: "black" };
      }
      const index = clamp(state.base.slideIndex, 1, deck.slides.length);
      const current = deck.slides[index - 1]!;
      // A slide drawn from its model is warmed through its model (which also
      // decodes its pictures), an image slide through its image.
      const warm = (slide: DeckSlide | undefined): string | undefined => slide?.modelUrl ?? slide?.url;
      const preload = [warm(deck.slides[index]), warm(deck.slides[index - 2])].filter(
        (url): url is string => url !== undefined,
      );
      return {
        kind: "slide",
        deckAssetId: deck.assetId,
        url: current.url,
        modelUrl: current.modelUrl,
        index,
        total: deck.slides.length,
        preload,
        enter: state.slideEntry ? { ...state.slideEntry, seq: state.slideVideoEpoch } : null,
        text: state.slideText,
      };
    }
    case "video":
      return { kind: "video", url: state.base.url, epoch: state.base.epoch };
    case "image":
      return { kind: "image", url: assetUrl(state.base.assetId) };
    case "bible":
      // Shared with the PREVIEW monitor's own output, for the same reason a
      // time scene's is: two translations of one verse are two chances for a
      // monitor to disagree with the projector.
      return bibleOutputFor(state.base, state.bibleStyle);
    case "utility":
      // Shared with the PREVIEW monitor's own output, so the two can never
      // translate the same scene differently.
      return timerOutputFor(state.base.scene, state.base.clock);
    case "song":
    {
      const { base } = state;
      // The first slide enters with the scene's own transition; every move
      // after it, with the theme's fade (`enterSeq` is its identity).
      const fade = base.theme.slideTransition;
      return songOutputFor(
        base.song,
        base.lyricsHidden ? [] : linesAt(base.song, base),
        base.theme,
        base.sizeCqw,
        base.lyricsHidden ? null : footerAt(base.song, base.theme, base),
        fade.style === "fade" && fade.durationMs > 0 && base.enterSeq > 0
          ? { style: "crossfade", durationMs: fade.durationMs, seq: base.enterSeq }
          : null,
        base.lyricsHidden ? null : translationAt(base.song, base),
      );
    }
  }
}

function selectTransition(state: ProjectionStoreState): SceneTransition {
  return {
    epoch: state.sceneEpoch,
    style: state.transitionStyle,
    durationMs: state.transitionDurationMs,
  };
}

/** BLACK is black and LOGO is the logo, with no exception the operator has to
 *  remember mid-service — and "nothing live" is the same logo, so it covers
 *  the plates too (decided 2026-09-24). The plates stay up in the store and
 *  come back the moment something is live again. */
function selectPlates(state: ProjectionStoreState): ProjectionOutput["plates"] {
  if (!platesVisible(state)) return [];
  return state.livePlates.map(plateOutputFor);
}

export function selectOutput(state: ProjectionStoreState): ProjectionOutput {
  const songVideo = selectSongVideo(state);
  return {
    ...selectOutputWithoutUnderlay(state),
    videoUnderlay: selectVideoUnderlay(state),
    slideVideo: selectSlideVideo(state),
    ...(songVideo ? { songVideo } : {}),
    plates: selectPlates(state),
    transition: selectTransition(state),
  };
}

/**
 * `selectOutput` builds a fresh object every call, and `preload` makes it
 * deeply nested — so neither `Object.is` nor `useShallow` can tell "same
 * output" from "new object". Memoizing identity in ONE place lets both the
 * effect subscription and the live monitor use the default comparator, instead
 * of each carrying its own workaround (a JSON equalityFn here, a useShallow
 * there) for the same problem.
 *
 * The memo compares the *inputs* `selectOutput` actually reads, by reference,
 * rather than serializing its result. It used to build the output and
 * `JSON.stringify` it on every single store notification — and the store's
 * busiest writer by far is `setMediaStatus`, which the projection window
 * drives at roughly 4 Hz per playing element and which no field of the output
 * depends on. Every one of those notifications paid for a full object build
 * plus a serialization of a deck's worth of slide urls, only to conclude
 * nothing had changed.
 *
 * Reference comparison is sound here because every one of these fields is
 * replaced immutably by the store, never mutated in place. It is also what
 * makes the identity stable no matter which subscriber calls first: two
 * states that differ only in `mediaStatus` produce the same input tuple and
 * therefore the same cached object, instead of racing over one slot of
 * serialized output — the single-slot thrash React documents as a cause of
 * `useSyncExternalStore` render loops.
 */
type OutputInputs = readonly [
  ProjectionStoreState["base"],
  ProjectionStoreState["overlay"],
  ProjectionStoreState["logoUrl"],
  ProjectionStoreState["logoScene"],
  // Only whether it loops reaches the output: «logo», «black», «hold» and
  // «next» are the end-of-playback effect's, and must not rebuild it.
  boolean,
  ProjectionStoreState["videoPaused"],
  ProjectionStoreState["videoVolume"],
  ProjectionStoreState["slideVideoEpoch"],
  ProjectionStoreState["slideVideoPaused"],
  ProjectionStoreState["slideVideoVolume"],
  ProjectionStoreState["slideVideoStartAt"],
  ProjectionStoreState["slideEntry"],
  ProjectionStoreState["liveDeck"],
  ProjectionStoreState["sceneEpoch"],
  ProjectionStoreState["transitionStyle"],
  ProjectionStoreState["transitionDurationMs"],
  ProjectionStoreState["bibleStyle"],
  ProjectionStoreState["slideText"],
  ProjectionStoreState["livePlates"],
];

function outputInputs(state: ProjectionStoreState): OutputInputs {
  return [
    state.base,
    state.overlay,
    state.logoUrl,
    state.logoScene,
    state.videoEnd === "loop",
    state.videoPaused,
    state.videoVolume,
    state.slideVideoEpoch,
    state.slideVideoPaused,
    state.slideVideoVolume,
    state.slideVideoStartAt,
    state.slideEntry,
    state.liveDeck,
    state.sceneEpoch,
    state.transitionStyle,
    state.transitionDurationMs,
    state.bibleStyle,
    state.slideText,
    state.livePlates,
  ];
}

let lastInputs: OutputInputs | null = null;
let lastOutput: ProjectionOutput | null = null;

export function selectOutputMemo(state: ProjectionStoreState): ProjectionOutput {
  const inputs = outputInputs(state);
  if (lastOutput !== null && lastInputs !== null && lastInputs.every((value, i) => Object.is(value, inputs[i]))) {
    return lastOutput;
  }
  lastInputs = inputs;
  lastOutput = selectOutput(state);
  return lastOutput;
}

/** Cumulative audio timestamps for a deck's slides, used by the autoplay
 *  scheduler. `cumulativeMs[1] === 0`; `cumulativeMs[n+1]` is when slide n
 *  should hand over. */
export function buildCumulativeMs(slides: DeckSlide[]): number[] {
  const cumulative: number[] = [0, 0];
  for (let i = 0; i < slides.length; i += 1) {
    const advance = slides[i]?.advanceAfterMs ?? 0;
    cumulative[i + 2] = (cumulative[i + 1] ?? 0) + advance;
  }
  return cumulative;
}
