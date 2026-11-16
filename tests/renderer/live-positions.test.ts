/**
 * `freezeLivePositions` — what makes losing the projection window survivable.
 *
 * `startAtSeconds` is a mount-time seek, not a position: replaying main's
 * snapshot into a fresh window remounts every element at the point the
 * operator originally chose. For a deck with a soundtrack that was worse than
 * restarted music — in "synced" mode the slide cursor is derived from the
 * audio clock, so the deck went back to slide 1 in front of the congregation.
 *
 * The two negatives matter as much as the positive: a report describing a
 * previous epoch must never be written back, and `paused` is the operator's
 * own declarative state and has to survive untouched.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { freezeLivePositions } from "@renderer/lib/actions/live-positions";
import { useAudioStore, type LiveAudioTrack } from "@renderer/stores/audio.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import type { MediaStatus } from "@shared/types/projection";
import { assetUrl } from "@shared/urls";

const initialProjection = useProjectionStore.getState();
const initialAudio = useAudioStore.getState();

function track(trackId: string, epoch: number, overrides: Partial<LiveAudioTrack> = {}): LiveAudioTrack {
  return {
    trackId,
    source: "asset",
    assetId: 1,
    label: trackId,
    url: `worship://asset/1`,
    epoch,
    paused: false,
    startAtSeconds: 0,
    volume: 1,
    loop: false,
    ...overrides,
  };
}

function status(target: MediaStatus["target"], epoch: number, currentTimeSeconds: number): MediaStatus {
  return { target, epoch, currentTimeSeconds, durationSeconds: 300, paused: false, ended: false };
}

function trackById(trackId: string): LiveAudioTrack | undefined {
  return useAudioStore.getState().tracks.find((t) => t.trackId === trackId);
}

beforeEach(() => {
  useProjectionStore.setState(initialProjection, true);
  useAudioStore.setState(initialAudio, true);
});

describe("audio tracks", () => {
  test("a track's resume point becomes where it actually is", () => {
    useAudioStore.getState().addTrack(track("asset:1:1", 1));
    useProjectionStore.getState().setMediaStatus(status({ kind: "audio", trackId: "asset:1:1" }, 1, 137.5));

    freezeLivePositions();

    expect(trackById("asset:1:1")?.startAtSeconds).toBe(137.5);
  });

  test("a report from a previous epoch is never written back", () => {
    // The deck's soundtrack reuses one status key across decks and plays, so a
    // stale report describes a different piece of music entirely.
    useAudioStore.getState().addTrack(track("deck-soundtrack", 4, { source: "deck", assetId: null, startAtSeconds: 20 }));
    useProjectionStore.getState().setMediaStatus(status({ kind: "audio", trackId: "deck-soundtrack" }, 3, 999));

    freezeLivePositions();

    expect(trackById("deck-soundtrack")?.startAtSeconds).toBe(20);
  });

  test("a track that never reported keeps the point it had", () => {
    useAudioStore.getState().addTrack(track("asset:2:1", 1, { startAtSeconds: 8 }));

    freezeLivePositions();

    expect(trackById("asset:2:1")?.startAtSeconds).toBe(8);
  });

  test("nothing else about a track is touched — least of all pause", () => {
    useAudioStore.getState().addTrack(track("asset:3:1", 1, { paused: true, volume: 0.25 }));
    useProjectionStore.getState().setMediaStatus(status({ kind: "audio", trackId: "asset:3:1" }, 1, 42));

    freezeLivePositions();

    expect(trackById("asset:3:1")).toMatchObject({ paused: true, volume: 0.25, epoch: 1, startAtSeconds: 42 });
  });

  test("freezing several tracks at once keeps each one's own clock", () => {
    useAudioStore.getState().addTrack(track("asset:1:1", 1));
    useAudioStore.getState().addTrack(track("asset:2:2", 2));
    useProjectionStore.getState().setMediaStatus(status({ kind: "audio", trackId: "asset:1:1" }, 1, 10));
    useProjectionStore.getState().setMediaStatus(status({ kind: "audio", trackId: "asset:2:2" }, 2, 70));

    freezeLivePositions();

    expect(trackById("asset:1:1")?.startAtSeconds).toBe(10);
    expect(trackById("asset:2:2")?.startAtSeconds).toBe(70);
  });
});

describe("the live slide's video (2026-11-15 audit, P3)", () => {
  // A modern deck's MP4 plays through Chromium in the slide: moving or reopening the projector mid-clip mounts it
  // again at `slideVideoStartAt`.
  function deckLive(): number {
    useProjectionStore.getState().setBase({ kind: "deck", assetId: 7, slideIndex: 2 });
    return useProjectionStore.getState().slideVideoEpoch;
  }

  test("its resume point becomes where it actually is", () => {
    const epoch = deckLive();
    useProjectionStore.getState().setMediaStatus(status({ kind: "slideVideo" }, epoch, 42.5));

    freezeLivePositions();

    expect(useProjectionStore.getState().slideVideoStartAt).toBe(42.5);
  });

  test("a report from the slide before is ignored", () => {
    const epoch = deckLive();
    useProjectionStore.getState().setMediaStatus(status({ kind: "slideVideo" }, epoch - 1, 900));

    freezeLivePositions();

    expect(useProjectionStore.getState().slideVideoStartAt).toBe(0);
  });
});

describe("the live video", () => {
  test("its resume point becomes where it actually is, without a remount", () => {
    useProjectionStore.getState().setBase({ kind: "video", assetId: 5, url: assetUrl(5), epoch: 2, startAtSeconds: 0 });
    useProjectionStore.getState().setMediaStatus(status({ kind: "video" }, 2, 64.25));

    freezeLivePositions();

    expect(useProjectionStore.getState().base).toMatchObject({ epoch: 2, startAtSeconds: 64.25 });
  });

  test("a report from a previous epoch is ignored", () => {
    useProjectionStore.getState().setBase({ kind: "video", assetId: 5, url: assetUrl(5), epoch: 3, startAtSeconds: 5 });
    useProjectionStore.getState().setMediaStatus(status({ kind: "video" }, 2, 900));

    freezeLivePositions();

    expect(useProjectionStore.getState().base).toMatchObject({ startAtSeconds: 5 });
  });

  test("a base that is not a video is left alone", () => {
    useProjectionStore.getState().setBase({ kind: "image", assetId: 3 });
    useProjectionStore.getState().setMediaStatus(status({ kind: "video" }, 1, 30));

    freezeLivePositions();

    expect(useProjectionStore.getState().base).toEqual({ kind: "image", assetId: 3 });
  });

  test("nothing live at all is not an error", () => {
    expect(() => {
      freezeLivePositions();
    }).not.toThrow();
  });
});
