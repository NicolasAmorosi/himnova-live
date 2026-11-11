import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

/** One audio track playing right now in the projection window — either a
 *  standalone asset sent live or a deck's own soundtrack. Kept separate from
 *  `projection.store`'s `base` because, unlike every other kind of content,
 *  audio never replaces what's on screen: any number of these can coexist
 *  with a PPT or a video at the same time. */
export type LiveAudioTrack = {
  trackId: string;
  source: "asset" | "deck";
  /** `null` for the deck's own soundtrack — it isn't a library asset. */
  assetId: number | null;
  /** What the operator reads in the media panel; never sent over IPC. */
  label: string;
  url: string;
  epoch: number;
  paused: boolean;
  startAtSeconds: number;
  /** 0..1. Starts at `media.volume` (Settings) for every new track and is the
   *  operator's for as long as the track lives; it is deliberately not
   *  persisted, so nothing ever starts at a level left over from another
   *  service. */
  volume: number;
  /** Starts over at its end: a deck's sound the file says loops. A
   *  standalone one loops by `projection.audioEnd`, folded in when pushed. */
  loop: boolean;
  /** The id of the schedule row a standalone audio was sent from: «next»
   *  plays the row after it. An id, not the row: every edit of the schedule
   *  copies its rows (`reindex`). Absent for one sent from the library. */
  fromItemId?: number;
};

/** Stable id for the one deck-soundtrack slot — at most one at a time,
 *  replaced wholesale by `setDeckTrack` on every `goLiveWithDeck`. */
export const DECK_SOUNDTRACK_TRACK_ID = "deck-soundtrack";

let assetTrackEpoch = 0;

/** Bumps the shared epoch counter — mirrors `videoEpoch` in `playback.ts`.
 *  A track's `epoch` is used as (part of) its React key on the projection
 *  side, so handing out a new one is what makes an `<audio>` element remount
 *  and re-apply `startAtSeconds`, i.e. "restart from the top". */
function nextEpoch(): number {
  assetTrackEpoch += 1;
  return assetTrackEpoch;
}

/** `assetId` is folded into the id so two different assets never collide;
 *  callers are responsible for not calling this for an asset that already
 *  has a live track (see `goLiveWithAudioAsset` in `playback.ts`) — one
 *  asset, one track, always. */
export function nextAssetTrack(assetId: number): { trackId: string; epoch: number } {
  const epoch = nextEpoch();
  return { trackId: `asset:${assetId}:${epoch}`, epoch };
}

/** A deck's sound on its slides (`effects/deck-sounds.ts`): `deck_audio.id`
 *  after the prefix, one track per sound. */
export const DECK_SOUND_TRACK_PREFIX = "deck-sound:";

export function nextDeckSoundTrack(audioId: number): { trackId: string; epoch: number } {
  return { trackId: `${DECK_SOUND_TRACK_PREFIX}${audioId}`, epoch: nextEpoch() };
}

type AudioStoreState = {
  tracks: LiveAudioTrack[];

  addTrack: (track: LiveAudioTrack) => void;
  removeTrack: (trackId: string) => void;
  setPaused: (trackId: string, paused: boolean) => void;
  /** Clamped to 0..1 here rather than at the call sites, so a slider that
   *  overshoots by a rounding error can never push an out-of-range value into
   *  `HTMLMediaElement.volume`, which throws on one. */
  setVolume: (trackId: string, volume: number) => void;
  /** Restarts an already-live track in place: bumps its epoch (remounting
   *  the `<audio>` element so `startAtSeconds` re-applies) and unpauses it,
   *  without touching `trackId` — used when GO LIVE targets an asset that is
   *  already in the list but paused, so it plays again instead of stacking a
   *  second instance of the same audio. */
  restartTrack: (trackId: string, startAtSeconds: number) => void;
  /** Points a live track at another url for the same file (the media engine took it): a new
   *  element, from where it was meant to start. */
  setUrl: (trackId: string, url: string) => void;
  /** Rewrites where the named tracks would resume from if their elements had
   *  to be mounted again — see `lib/actions/live-positions.ts`. Deliberately
   *  does NOT bump `epoch`: nothing should remount while the projection window
   *  this describes is still on screen, and the value is only ever read by the
   *  NEXT mount. Tracks absent from the map keep the point they had. */
  setStartPositions: (positions: ReadonlyMap<string, number>) => void;
  /** Replaces the single deck-soundtrack slot; `null` clears it. Every other
   *  track (standalone audio assets) is untouched — a deck change never cuts
   *  audio the operator sent live independently. */
  setDeckTrack: (track: Omit<LiveAudioTrack, "trackId" | "source" | "assetId"> | null) => void;
  clear: () => void;
};

export const useAudioStore = create<AudioStoreState>()(
  subscribeWithSelector((set) => ({
    tracks: [],

    addTrack: (track) => set((state) => ({ tracks: [...state.tracks, track] })),

    removeTrack: (trackId) =>
      set((state) => ({ tracks: state.tracks.filter((t) => t.trackId !== trackId) })),

    setPaused: (trackId, paused) =>
      set((state) => ({
        tracks: state.tracks.map((t) => (t.trackId === trackId ? { ...t, paused } : t)),
      })),

    setVolume: (trackId, volume) =>
      set((state) => {
        const clamped = Math.min(1, Math.max(0, volume));
        const track = state.tracks.find((t) => t.trackId === trackId);
        // No-op when the level did not actually move: this list is what
        // `projection-sync` subscribes to, and a slider drag reports the same
        // rounded value many times over — each identical array would be one
        // more push of every live track to main for nothing.
        if (!track || track.volume === clamped) return state;
        return {
          tracks: state.tracks.map((t) => (t.trackId === trackId ? { ...t, volume: clamped } : t)),
        };
      }),

    restartTrack: (trackId, startAtSeconds) =>
      set((state) => ({
        tracks: state.tracks.map((t) =>
          t.trackId === trackId ? { ...t, epoch: nextEpoch(), paused: false, startAtSeconds } : t,
        ),
      })),

    setUrl: (trackId, url) =>
      set((state) => ({
        tracks: state.tracks.map((t) => (t.trackId === trackId ? { ...t, url, epoch: nextEpoch() } : t)),
      })),

    setStartPositions: (positions) =>
      set((state) => {
        let changed = false;
        const tracks = state.tracks.map((track) => {
          const at = positions.get(track.trackId);
          if (at === undefined || at === track.startAtSeconds) return track;
          changed = true;
          return { ...track, startAtSeconds: at };
        });
        // No-op when nothing moved, for the same reason as
        // `pruneMediaStatus`: this list is subscribed to by the push to main,
        // and a fresh array with identical contents would re-send every track
        // for nothing.
        return changed ? { tracks } : state;
      }),

    setDeckTrack: (track) =>
      set((state) => {
        const rest = state.tracks.filter((t) => t.trackId !== DECK_SOUNDTRACK_TRACK_ID);
        if (!track) return { tracks: rest };
        const deckTrack: LiveAudioTrack = {
          ...track,
          trackId: DECK_SOUNDTRACK_TRACK_ID,
          source: "deck",
          assetId: null,
        };
        return { tracks: [...rest, deckTrack] };
      }),

    clear: () => set({ tracks: [] }),
  })),
);
