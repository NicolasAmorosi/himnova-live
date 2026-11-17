/**
 * The media engine's decision for a file that is already live (2026-11-10 review, agent2v-01): an AVI sent
 * live within ~0.5 s of its import went out as a `<video>` Chromium cannot open — black and silent — and
 * nothing re-armed it when main's decision arrived.
 */
import { beforeEach, expect, test } from "vitest";
import { rearmLive, rearmLiveClips } from "@renderer/effects/engine-assets-sync";
import { useDeckStore } from "@renderer/stores/deck.store";
import { useAudioStore } from "@renderer/stores/audio.store";
import { useEngineAssetsStore } from "@renderer/stores/engine-assets.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { assetUrl, deckVideoUrl, engineAssetUrl, engineClipUrl } from "@shared/urls";
import type { DeckDTO } from "@shared/types/deck";
import { resolveSong } from "@renderer/stores/song.store";
import { songBackgroundVideo } from "@renderer/lib/song-output";
import { parseLyrics } from "@shared/song-text";
import { DEFAULT_SONG_THEME, type SongTheme } from "@shared/types/song";

const initialProjection = useProjectionStore.getState();

beforeEach(() => {
  useProjectionStore.setState(initialProjection, true);
  useAudioStore.getState().clear();
  useEngineAssetsStore.getState().reset([]);
});

test("a live video the engine takes is re-pointed in place: same scene, the engine's url", () => {
  const projection = useProjectionStore.getState();
  projection.beginScene();
  projection.setBase({ kind: "video", assetId: 7, url: assetUrl(7), epoch: 3, startAtSeconds: 0 });
  const epoch = useProjectionStore.getState().sceneEpoch;

  useEngineAssetsStore.getState().apply({ assetId: 7, engine: true });
  rearmLive(7);

  expect(useProjectionStore.getState().base).toMatchObject({ kind: "video", assetId: 7, url: engineAssetUrl(7), epoch: 3 });
  expect(useProjectionStore.getState().sceneEpoch).toBe(epoch);
});

test("a live audio track of that file follows it; anything else is left alone", () => {
  const audio = useAudioStore.getState();
  audio.addTrack({ trackId: "a:7", source: "asset", assetId: 7, label: "", url: assetUrl(7), epoch: 1000, paused: false, startAtSeconds: 0, volume: 1, loop: false });
  audio.addTrack({ trackId: "a:8", source: "asset", assetId: 8, label: "", url: assetUrl(8), epoch: 2, paused: false, startAtSeconds: 0, volume: 1, loop: false });

  useEngineAssetsStore.getState().apply({ assetId: 7, engine: true });
  rearmLive(7);

  const [seven, eight] = useAudioStore.getState().tracks;
  expect(seven).toMatchObject({ url: engineAssetUrl(7) });
  expect(seven?.epoch).not.toBe(1000);
  expect(eight).toMatchObject({ url: assetUrl(8), epoch: 2 });
});

test("a live song's video background the engine gave back goes to Chromium in place: same scene, same slide", () => {
  // The engine failed under it (owner, 2026-11-17): main took it off the engine, and the background follows.
  useEngineAssetsStore.getState().reset([5]);
  const theme: SongTheme = { ...DEFAULT_SONG_THEME, background: { kind: "video", assetId: 5, fit: "cover" } };
  const song = {
    id: 7,
    title: "Sublime gracia",
    number: null,
    authors: null,
    copyright: null,
    ccliNumber: null,
    notes: null,
    sections: parseLyrics("[Estrofa 1]\nuno\n\ndos", "es").sections,
    order: [],
    themeId: null,
    sourceFolder: null,
    file: null,
    updatedAt: 1,
  };
  const projection = useProjectionStore.getState();
  projection.beginScene();
  projection.setBase({
    kind: "song",
    songId: 7,
    song: resolveSong(song, theme, null),
    slideIndex: 2,
    detour: null,
    lyricsHidden: false,
    enterSeq: 0,
    theme,
    sizeCqw: 4,
    backgroundVideo: songBackgroundVideo(theme, null),
    language: "both",
  });
  const epoch = useProjectionStore.getState().sceneEpoch;
  expect(useProjectionStore.getState().base).toMatchObject({ backgroundVideo: { url: engineAssetUrl(5) } });

  useEngineAssetsStore.getState().apply({ assetId: 5, engine: false });
  rearmLive(5);

  expect(useProjectionStore.getState().base).toMatchObject({ kind: "song", slideIndex: 2, backgroundVideo: { url: assetUrl(5) } });
  expect(useProjectionStore.getState().sceneEpoch).toBe(epoch);
});

test("a live slide's clip the engine gave back goes to Chromium in place: same slide, the music not restarted", () => {
  const clip = (url: string) => ({ slideIndex: 2, url, rect: { x: 0, y: 0, width: 1, height: 1 }, aspectRatio: 16 / 9, loop: false, volume: null, name: "c.mp4" });
  const slides = [1, 2, 3].map((index) => ({ index, url: "", thumbUrl: "", transition: null })) as unknown as DeckDTO["slides"];
  const projection = useProjectionStore.getState();
  projection.setLiveDeck({ assetId: 9, deckId: 4, slides, soundtrack: null, sounds: [], videos: [clip(engineClipUrl("video", 11))], cumulativeMs: [0, 0, 0, 0], autoAdvance: false });
  projection.setBase({ kind: "deck", assetId: 9, slideIndex: 2 });
  const { soundtrackEpoch, slideVideoEpoch } = useProjectionStore.getState();
  projection.setMediaStatus({ target: { kind: "slideVideo" }, epoch: slideVideoEpoch, currentTimeSeconds: 12.5, durationSeconds: 30, paused: false, ended: false });

  // A deck converted again names other clips: never mixed into what is live.
  const dto = (url: string) => ({ deckId: 4, videos: [clip(url)] }) as unknown as DeckDTO;
  useDeckStore.setState({ byAssetId: { 9: { status: "ready", progress: { done: 3, total: 3 }, deck: dto(deckVideoUrl(12, "c.mp4")), error: null } } });
  rearmLiveClips();
  expect(useProjectionStore.getState().liveDeck?.videos[0]?.url).toBe(engineClipUrl("video", 11));

  useDeckStore.setState({ byAssetId: { 9: { status: "ready", progress: { done: 3, total: 3 }, deck: dto(deckVideoUrl(11, "c.mp4")), error: null } } });
  rearmLiveClips();
  const after = useProjectionStore.getState();
  expect(after.liveDeck?.videos[0]?.url).toBe(deckVideoUrl(11, "c.mp4"));
  expect(after.base).toMatchObject({ kind: "deck", slideIndex: 2 });
  expect(after.soundtrackEpoch).toBe(soundtrackEpoch);
  expect(after.slideVideoEpoch).toBe(slideVideoEpoch);
  expect(after.slideVideoStartAt).toBe(12.5);
});
