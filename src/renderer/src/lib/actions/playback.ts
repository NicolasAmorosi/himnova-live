import { useProgramStore } from "@renderer/stores/program.store";
import { buildCumulativeMs, useProjectionStore } from "@renderer/stores/projection.store";
import { useDeckStore } from "@renderer/stores/deck.store";
import { useDisplayStore } from "@renderer/stores/display.store";
import { usePreviewStore, type PreviewTarget } from "@renderer/stores/preview.store";
import { findPlate, useOverlayStore } from "@renderer/stores/overlay.store";
import { bibleVersionLabel, useBibleStore } from "@renderer/stores/bible.store";
import { useAudioStore, nextAssetTrack, type LiveAudioTrack } from "@renderer/stores/audio.store";
import { findScene, useUtilityStore } from "@renderer/stores/utility.store";
import { notifyManualNavigation, restartDeck } from "@renderer/effects/deck-autoplay";
import { handLiveItemToTab, projectVerse, scheduleItemParallel } from "@renderer/lib/actions/bible";
import { stopPreviewPlayback } from "@renderer/lib/actions/preview-playback";
import { previewedScheduleItem } from "@renderer/lib/actions/preview";
import { defaultMediaVolume, useSettingsStore } from "@renderer/stores/settings.store";
import { api } from "@renderer/lib/api";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import type { MediaAsset } from "@shared/types/media";
import type { DeckDTO } from "@shared/types/deck";
import type { LiveDeck } from "@renderer/stores/projection.store";
import type { OverlayState } from "@shared/types/projection";
import { claimLiveIntent, currentLiveIntent, isCurrentLiveIntent } from "@renderer/lib/actions/live-intent";
import { playableAssetUrl } from "@renderer/stores/engine-assets.store";
import { getCachedMediaAsset } from "@renderer/lib/hooks/use-media-asset";
import type { AssetKind } from "@shared/constants";
import { prepareSong } from "@renderer/lib/actions/songs";
import { songBackgroundVideo } from "@renderer/lib/song-output";
import { jumpTo, stepSong, type SongJumpTarget } from "@shared/song-jump";

let videoEpoch = 0;

/** Sends a standalone audio asset live. Unlike every other kind of content,
 *  this never touches `base`/`overlay` — audio is never what's on screen, so
 *  it can coexist with a PPT or a video already live. What gets cut is only
 *  the deck-soundtrack slot; every other audio track already sounding keeps
 *  playing.
 *
 *  One asset, one track: if this asset is already in the live list, GO LIVE
 *  never stacks a second instance of it. Already sounding → no-op, the
 *  existing track plays on untouched. Already there but paused → restarted
 *  in place instead of duplicated. */
function goLiveWithAudioAsset(
  asset: MediaAsset,
  startAtSeconds: number,
  fromItemId?: number,
  volume = defaultMediaVolume(),
): void {
  const audioStore = useAudioStore.getState();
  const existing = audioStore.tracks.find((t) => t.source === "asset" && t.assetId === asset.id);
  if (existing) {
    if (!existing.paused) return;
    audioStore.restartTrack(existing.trackId, startAtSeconds);
    return;
  }

  const { trackId, epoch } = nextAssetTrack(asset.id);
  audioStore.addTrack({
    trackId,
    source: "asset",
    assetId: asset.id,
    label: asset.name,
    url: playableAssetUrl(asset.id),
    epoch,
    paused: false,
    startAtSeconds,
    volume,
    loop: false,
    ...(fromItemId !== undefined ? { fromItemId } : {}),
  });
}

function toLiveDeck(deck: DeckDTO): LiveDeck {
  return {
    assetId: deck.assetId,
    deckId: deck.deckId,
    slides: deck.slides,
    soundtrack: deck.soundtrack,
    sounds: deck.sounds,
    videos: deck.videos,
    cumulativeMs: buildCumulativeMs(deck.slides),
    autoAdvance: deck.autoAdvance,
  };
}

/**
 * Note the ordering in here: the deck is fully ready BEFORE `base` changes, so
 * hitting GO LIVE on a not-yet-converted file leaves whatever is currently on
 * the projector untouched instead of cutting to black for the length of a
 * conversion.
 *
 * That same ordering is what makes `intent` necessary: waiting for the
 * conversion means the commit lands at a moment the operator has had time to
 * act on. See `liveIntent`.
 */
/**
 * Says why a GO LIVE on a deck changed nothing, with main's reason — a file
 * that won't open says what the operator can do about it. The panel that
 * explains it may not be the one the operator is looking at, and a press that
 * does nothing in silence reads as a frozen app. Nothing changes on the
 * projector either way.
 */
async function explainDeckFailure(assetId: number): Promise<void> {
  const entry = useDeckStore.getState().byAssetId[assetId];
  if (entry?.status !== "failed") return;
  const asset = await api.library.get(assetId);
  toast.warning(t("deck.liveFailed", { name: asset?.name ?? "", reason: entry.error ?? t("deck.failed") }));
}

async function goLiveWithDeck(assetId: number, startSlideIndex: number, intent: number): Promise<boolean> {
  const deckStore = useDeckStore.getState();
  const cached = deckStore.byAssetId[assetId];
  let deck: DeckDTO | null;
  if (cached?.status === "ready" && cached.deck && cached.deck.slides.length > 0) {
    // Already known ready in the store — go live with it immediately instead
    // of waiting on an `ensure()` round-trip. For an already-prewarmed deck
    // that round-trip is a pure cache hit on main's side anyway (same DTO,
    // a beat later); waiting on it is exactly what made GO LIVE on a
    // prepared deck feel slow. Still revalidate in the background (a
    // relocate, a source file that changed on disk) so a real change is
    // caught on the next go-live rather than never.
    deck = cached.deck;
    void deckStore.ensure(assetId);
  } else {
    deck = await deckStore.ensure(assetId);
  }
  if (!deck || deck.status !== "ready" || deck.slides.length === 0) {
    void explainDeckFailure(assetId);
    return false;
  }
  // The conversion above may have taken seconds. Anything the operator did to
  // the projector in the meantime outranks this deck.
  if (!isCurrentLiveIntent(intent)) return false;

  const store = useProjectionStore.getState();
  // Begins the new scene right here, at the commit — not before the `await`
  // above — so a not-yet-converted deck (which returns `false` before this
  // point) never burns an epoch on a projector that ends up unchanged.
  store.beginScene();
  store.setLiveDeck(toLiveDeck(deck));
  store.setBase({
    kind: "deck",
    assetId: deck.assetId,
    slideIndex: Math.min(Math.max(1, startSlideIndex), deck.slides.length),
  });
  // Going live always cuts straight from BLACK/LOGO to the new content — the
  // operator never has to remember to press GO LIVE/LOGO twice.
  store.setOverlay("none");

  const epoch = useProjectionStore.getState().soundtrackEpoch;
  // `label` is a placeholder: the media panel derives the deck's own display
  // label from the live heading (title/asset name), which can change without
  // this track being re-created.
  useAudioStore
    .getState()
    .setDeckTrack(
      deck.soundtrack
        ? {
            url: deck.soundtrack.url,
            epoch,
            paused: false,
            startAtSeconds: 0,
            label: "",
            volume: defaultMediaVolume(),
            loop: false,
          }
        : null,
    );

  // A deck that carries its own timings starts playing on its own, the way
  // PowerPoint did — that IS the "PPTs that pass by themselves" behaviour.
  if (deck.autoAdvance) store.setAutoplay("playing");
  return true;
}

type MediaLiveResult = "base" | "audio" | "failed" | "superseded";

/**
 * Video and image replace `base` like everything else. Audio never does —
 * it is sound, not a picture, so it is added as one more live audio track
 * instead (see `goLiveWithAudioAsset`) and the projector keeps showing
 * whatever it already was.
 */
async function goLiveWithMediaAsset(
  assetId: number,
  startAtSeconds: number,
  intent: number,
  fromItemId?: number,
): Promise<MediaLiveResult> {
  const asset = await api.library.get(assetId);
  if (!asset) return "failed";
  // A file PREVIEW already calls missing never reaches the projector: sending
  // it anyway cut what was live to a black, silent stage. Said the way a deck
  // that won't open is said, and nothing on the projector changes.
  if (asset.missingSince !== null) {
    toast.warning(t("deck.liveFailed", { name: asset.name, reason: t("preview.missingHint") }));
    return "failed";
  }
  // A DB read, so a far narrower window than a conversion — but the audio
  // branch below is guarded by the same check on purpose: CLEAR means
  // silence, and a track that starts just after it would outlive the button
  // that was meant to kill it.
  if (!isCurrentLiveIntent(intent)) return "superseded";

  if (asset.kind === "audio") {
    goLiveWithAudioAsset(asset, startAtSeconds, fromItemId);
    return "audio";
  }

  const { base, beginScene, mediaErrors, mediaStatus, setBase, setOverlay } = useProjectionStore.getState();
  if (asset.kind === "video") {
    // The video already on air, playing fine: GO LIVE only uncovers it (owner,
    // 2026-11-10), like a countdown already live. Re-sending it restarted it
    // from 0:00 in front of the congregation on an extra Enter. A failed one
    // is re-sent — that is the operator's retry (`beginScene` clears its
    // error) — and so is one that already ended.
    if (base?.kind === "video" && base.assetId === asset.id) {
      const failed = mediaErrors.video?.url === base.url;
      const status = mediaStatus.video;
      const ended = status?.ended === true && status.epoch === base.epoch;
      if (!failed && !ended) {
        setOverlay("none");
        return "base";
      }
    }
    beginScene();
    videoEpoch += 1;
    setBase({ kind: "video", assetId: asset.id, url: playableAssetUrl(asset.id), epoch: videoEpoch, startAtSeconds });
  } else if (asset.kind === "image") {
    beginScene();
    setBase({ kind: "image", assetId: asset.id });
  } else {
    return "failed";
  }
  setOverlay("none");
  // Whatever this replaces on the projector, its deck (if any) is no longer
  // showing — its music stops with it. Standalone audio tracks are untouched.
  useAudioStore.getState().setDeckTrack(null);
  return "base";
}

/**
 * A utility scene replaces `base` like any other content — it is full-screen
 * content, not an overlay (decision of 2026-09-17).
 *
 * Synchronous, so the `isCurrentLiveIntent` check `goLive()` already made
 * after opening the projector still holds: there is no `await` between there
 * and the commit below.
 *
 * `scheduleIndex` is the row that claims the on-air rail — a scene sent from
 * the Utilities panel is live content that is not in the schedule, so it
 * passes `null` and no row may claim it. Returns whether anything reached the
 * projector: a scene whose row was deleted between the drag and the press
 * changes nothing, and must not light up a rail either.
 */
function goLiveWithUtilityScene(sceneId: number, scheduleIndex: number | null): boolean {
  const utility = useUtilityStore.getState();
  const scene = findScene(utility.scenes, sceneId);
  if (!scene) return false;

  // Already on the projector: nothing to send, only to uncover. Taking the
  // path below restarted a running countdown at its full duration — PREVIEW
  // had just shown 03:21, because what is live wins (`clockForScene`) — and
  // threw away the clock the operator had armed on another scene.
  const live = useProjectionStore.getState().base;
  if (live?.kind === "utility" && live.sceneId === scene.id) {
    useProgramStore.getState().setActive(scheduleIndex);
    useProjectionStore.getState().setOverlay("none");
    return true;
  }

  // GO LIVE on a countdown nobody started means "start it": projecting a
  // frozen 10:00 is never what the operator meant by pressing it. One they
  // paused on purpose is left exactly as it is — same rule as a video's
  // declarative `paused`.
  const clock = utility.ensureStarted(scene);

  useProgramStore.getState().setActive(scheduleIndex);
  useAudioStore.getState().setDeckTrack(null);
  useBibleStore.getState().setCurrentVerseIndex(null);

  const store = useProjectionStore.getState();
  store.beginScene();
  store.setBase({ kind: "utility", sceneId: scene.id, scene, clock });
  store.setOverlay("none");
  return true;
}

/**
 * A song replaces `base` like a verse, starting at the preview cursor's slide.
 *
 * Measured BEFORE `base` changes (`prepareSong`, a few milliseconds the first
 * time), so the projector never shows it at a size it is about to change —
 * and, like a deck, guarded by the live intent across that wait. Says whether
 * it went live; the caller places the on-air rail (`settleRail`).
 */
async function goLiveWithSong(songId: number, startSlideIndex: number, intent: number): Promise<boolean> {
  const prepared = await prepareSong(songId);
  if (!prepared || prepared.resolved.slides.length === 0 || !isCurrentLiveIntent(intent)) return false;
  useAudioStore.getState().setDeckTrack(null);
  useBibleStore.getState().setCurrentVerseIndex(null);
  const store = useProjectionStore.getState();
  store.beginScene();
  store.setBase({
    kind: "song",
    songId,
    song: prepared.resolved,
    slideIndex: Math.min(Math.max(1, startSlideIndex), prepared.resolved.slides.length),
    detour: null,
    lyricsHidden: false,
    enterSeq: 0,
    theme: prepared.theme,
    sizeCqw: prepared.sizeCqw,
    backgroundVideo: songBackgroundVideo(prepared.theme, null),
    // Both languages first (owner, 2026-11-05); the LIVE row switches.
    language: "both",
  });
  store.setOverlay("none");
  return true;
}

/** ←/→ on the live song: a cut, like a verse — through a detour and back to
 *  the order after it (`stepSong`). Past its last slide it ends, like a deck
 *  (`endLiveContent`). */
export function advanceSong(direction: 1 | -1, repeat = false): void {
  const { base, setSongPosition } = useProjectionStore.getState();
  if (base?.kind !== "song") return;
  const next = stepSong(base.song, base, direction);
  if (!next && direction === 1 && !repeat) endLiveContent();
  if (!next) return;
  claimLiveIntent();
  setSongPosition(next);
}

/** A slide of the order, from the LIVE grid: leaves any detour. */
export function gotoSongSlide(index: number): void {
  if (useProjectionStore.getState().base?.kind !== "song") return;
  claimLiveIntent();
  useProjectionStore.getState().setSongPosition({ slideIndex: index, detour: null });
}

/** A section's key or button: its next time in the order (`direction` 1),
 *  or its previous one (-1, Shift); a detour when it is not there. Says
 *  whether the song moved. */
export function jumpSong(target: SongJumpTarget, direction: 1 | -1): boolean {
  const { base, setSongPosition } = useProjectionStore.getState();
  if (base?.kind !== "song") return false;
  const next = jumpTo(base.song, base, target, direction);
  if (!next) return false;
  claimLiveIntent();
  setSongPosition(next);
  return true;
}

/** T: the live song's lyrics off the projector — its background stays — or back. */
export function toggleSongLyrics(): void {
  const { base, setLyricsHidden } = useProjectionStore.getState();
  if (base?.kind !== "song") return;
  claimLiveIntent();
  setLyricsHidden(!base.lyricsHidden);
}

/**
 * A plate does not replace `base`: it goes UP over whatever is projected, and
 * replaces only the plate of its own kind (`showPlate`). Everything that makes
 * GO LIVE "send new content" is deliberately skipped — no `beginScene()`
 * (the stage would fade into itself), no rail on the schedule (the content
 * row below keeps it), and BLACK/LOGO stay up: a plate is covered with
 * everything else, and pressing GO LIVE on a name must never uncover the
 * stage behind the operator's back.
 *
 * Nor does it claim the live intent. A deck still converting from an earlier
 * GO LIVE must still land: putting a name over it is not the operator
 * changing their mind about the content (see `liveIntent`).
 *
 * Already up → a no-op, like an audio track that is already sounding: GO LIVE
 * twice must not replay its entrance or restart its count.
 */
async function goLiveWithPlate(plateId: number): Promise<void> {
  const plate = findPlate(useOverlayStore.getState().plates, plateId);
  if (!plate) return;
  await useDisplayStore.getState().openIfNeeded();
  const store = useProjectionStore.getState();
  if (store.livePlates.some((live) => live.id === plate.id)) return;
  store.showPlate(plate);
}

/** The plate a preview target puts up, if it is one — straight from the
 *  Overlays list or from a `plate` row of the schedule. */
function previewedPlateId(target: PreviewTarget): number | null {
  if (target.kind === "plate") return target.plateId;
  if (target.kind !== "scheduleItem") return null;
  const item = previewedScheduleItem();
  return item?.kind === "plate" ? item.overlayPlateId : null;
}

/** Says whether the row changed what is on the projector — a deck that
 *  won't open, a missing file, a scene or a song deleted since, or a plate
 *  (which only goes up over it) did not. */
async function goLiveWithScheduleItem(
  index: number,
  startSlideIndex: number,
  startAtSeconds: number,
  intent: number,
): Promise<boolean> {
  const { items } = useProgramStore.getState();
  const item = items[index];
  if (!item) return false;
  /** Where that row is NOW: a deck can take seconds to convert, and a row
   *  dropped above it or deleted meanwhile used to put the on-air rail on
   *  whatever row ended up at the old position. */
  const settleRail = () => {
    const at = useProgramStore.getState().items.indexOf(item);
    useProgramStore.getState().setActive(at >= 0 ? at : null);
  };

  switch (item.kind) {
    case "ppt": {
      const live = await goLiveWithDeck(item.mediaAssetId, startSlideIndex, intent);
      if (live) settleRail();
      return live;
    }
    case "media": {
      // Audio never claims the on-air rail — that rail means "this is what's
      // on the projector", and audio never is. Its own "sounding" indicator
      // (schedule-row.tsx) is driven by the audio store instead.
      const result = await goLiveWithMediaAsset(item.mediaAssetId, startAtSeconds, intent, item.id);
      if (result === "base") settleRail();
      return result === "base";
    }
    case "bible": {
      // The parallel version's same passage is a lookup in main; anything the
      // operator did meanwhile wins (`liveIntent`).
      const parallel = await scheduleItemParallel(item);
      if (!isCurrentLiveIntent(intent)) return false;
      settleRail();
      useAudioStore.getState().setDeckTrack(null);
      // Not driven by projectVerse() — this reference doesn't necessarily
      // belong to the chapter currently loaded in the Bible browser, so any
      // stale live-verse cursor from earlier browsing must not linger until
      // `handLiveItemToTab` (below) loads the row's own chapter there.
      useBibleStore.getState().setCurrentVerseIndex(null);
      useProjectionStore.getState().beginScene();
      useProjectionStore.getState().setBase({
        kind: "bible",
        text: item.text,
        reference: item.reference,
        // The row's own version, which may be gone — the FK is `set null`, so
        // a program saved before a version was deleted keeps its text and its
        // reference and loses only the label.
        versionLabel: bibleVersionLabel(useBibleStore.getState().versions, item.bibleVersionId),
        parallel,
      });
      useProjectionStore.getState().setOverlay("none");
      const { bibleBookId, chapter, verseFrom, verseTo } = item;
      if (bibleBookId !== null && chapter !== null && verseFrom !== null) {
        useBibleStore.getState().recordRecent(bibleBookId, chapter, verseFrom, verseTo ?? verseFrom);
      }
      void handLiveItemToTab(item);
      return true;
    }
    case "utility": {
      // The same commit the Utilities panel uses, with the row claiming the
      // rail. `setActive` is inside it rather than here because the scene may
      // be gone — a program saved months ago whose scene was force-deleted
      // since — and a rail lit on a projector that never changed is the kind
      // of lie the monitors exist to prevent.
      return goLiveWithUtilityScene(item.utilitySceneId, index);
    }
    case "song": {
      const live = await goLiveWithSong(item.songId, startSlideIndex, intent);
      if (live) settleRail();
      return live;
    }
    case "plate":
      // Handled before the live intent is claimed — see `goLive()`.
      return false;
  }
}

async function goLiveWithAsset(
  assetId: number,
  assetKind: AssetKind,
  startSlideIndex: number,
  startAtSeconds: number,
  intent: number,
): Promise<void> {
  const result =
    assetKind === "ppt"
      ? (await goLiveWithDeck(assetId, startSlideIndex, intent))
        ? "base"
        : "failed"
      : await goLiveWithMediaAsset(assetId, startAtSeconds, intent);
  // Live content that isn't in the schedule: no row can claim the on-air rail.
  if (result === "base") useProgramStore.getState().setActive(null);
}

/**
 * The schedule's next item that changes the picture, straight to the
 * projector: a video's end set to «next» (`projection.videoEnd`, owner
 * 2026-11-05). A plate or an audio never changes the picture, so it is
 * skipped. False when the live video was not a schedule row (nothing claims
 * the rail), nothing after it shows anything, or that row could not go live
 * (a deck that won't open): the caller's logo, rather than the ended video
 * frozen under a rail. True as well when the operator acted meanwhile — what
 * they did wins over the logo too. PREVIEW stays where the operator left it.
 */
export async function goLiveWithNextScheduleItem(): Promise<boolean> {
  const { activeIndex, items } = useProgramStore.getState();
  if (activeIndex === null) return false;
  const next = items.findIndex(
    (item, index) =>
      index > activeIndex &&
      item.kind !== "plate" &&
      !(item.kind === "media" && getCachedMediaAsset(item.mediaAssetId)?.kind === "audio"),
  );
  if (next < 0) return false;
  const intent = claimLiveIntent();
  return (await goLiveWithScheduleItem(next, 1, 0, intent)) || !isCurrentLiveIntent(intent);
}

/**
 * A standalone audio that played to its end with `projection.audioEnd` set to
 * «next» (owner, 2026-11-09): the schedule row right after the one it was
 * sent from — plates skipped, they make no sound — plays, at the level the
 * ended one had, so a list of background music keeps the operator's volume.
 * Only when that row is an audio too: the offertory's music further down
 * never starts on its own mid-service. Nothing when it was not sent from the
 * schedule, or its row is gone.
 */
export async function goLiveWithNextScheduleAudio(ended: LiveAudioTrack): Promise<void> {
  if (ended.fromItemId === undefined) return;
  const { items } = useProgramStore.getState();
  // Saving the program gives every row a new id (`adoptSaved`), so then its row
  // is the one with its audio. ponytail: the first such row if the same audio
  // is in the schedule twice and the program was saved while it played.
  const byId = items.findIndex((item) => item.id === ended.fromItemId);
  const from = byId >= 0 ? byId : items.findIndex((item) => item.kind === "media" && item.mediaAssetId === ended.assetId);
  if (from < 0) return;
  const next = items.slice(from + 1).find((item) => item.kind !== "plate");
  if (next?.kind !== "media") return;
  // Observed, never claimed — an audio is not what is on screen; CLEAR during
  // the read below still means silence.
  const intent = currentLiveIntent();
  const asset = await api.library.get(next.mediaAssetId);
  if (asset?.kind !== "audio" || !isCurrentLiveIntent(intent)) return;
  goLiveWithAudioAsset(asset, 0, next.id, ended.volume);
}

/** Whether a preview target is a standalone audio, which goes live without
 *  changing the picture. A schedule row only says "media", so its asset says
 *  the kind — already cached, since PREVIEW resolved it to show it. */
function isAudioTarget(target: PreviewTarget): boolean {
  if (target.kind === "asset") return target.assetKind === "audio";
  if (target.kind !== "scheduleItem") return false;
  const item = previewedScheduleItem();
  return item?.kind === "media" && getCachedMediaAsset(item.mediaAssetId)?.kind === "audio";
}

/**
 * Stage two: send whatever is in the preview pane to the projector. The single
 * implementation behind the GO LIVE button, the Enter shortcut and
 * double-clicking a row, a tile or a verse — so all four can never diverge.
 */
export async function goLive(): Promise<void> {
  const { slideIndex, positionSeconds, target } = usePreviewStore.getState();
  if (!target) return;

  const plateId = previewedPlateId(target);
  if (plateId !== null) {
    await goLiveWithPlate(plateId);
    return;
  }

  // A verse that is not in the loaded chapter any more has nothing to send.
  // Checked before any side effect: past this point the verse branch clears
  // the rail, cuts the deck's music and lifts BLACK/LOGO — and then
  // `projectVerse` would have done nothing.
  if (target.kind === "verse" && !useBibleStore.getState().verses[target.verseIndex]) return;

  // Claimed before the first `await` below, so this press supersedes anything
  // still in flight — typically an earlier GO LIVE on a deck that is still
  // converting — and is in turn superseded by whatever the operator does
  // next. See `liveIntent`. Except an audio, which is never what is on
  // screen: sending the accompaniment while the hymn's deck converts used to
  // drop the deck's commit for good. It only observes the intent.
  const intent = isAudioTarget(target) ? currentLiveIntent() : claimLiveIntent();

  // `beginScene()` is NOT called here at the top: `goLiveWithDeck`/
  // `goLiveWithMediaAsset` below can fail (asset missing, deck not yet
  // converted) or resolve to an audio-only track that never touches `base` —
  // none of those actually change what the projector shows. Each branch
  // calls `beginScene()` itself, right at its own commit point, so an epoch
  // is only ever spent on a push that really changes the picture.

  // Whatever the preview video was doing, it stops the moment its file goes
  // live — the projector picks up from `positionSeconds` below, so there is
  // never more than one active decode of the same file at once.
  stopPreviewPlayback();

  // If nothing is projected yet, the very act of going live is what turns the
  // projector on — the app itself never opens it on launch any more.
  await useDisplayStore.getState().openIfNeeded();
  // Opening the projector is an IPC round-trip of its own, and the verse
  // branch below commits with no further await — so it is checked here rather
  // than inside each branch.
  if (!isCurrentLiveIntent(intent)) return;

  switch (target.kind) {
    case "scheduleItem": {
      const index = useProgramStore.getState().selectedIndex;
      if (index !== null) await goLiveWithScheduleItem(index, slideIndex, positionSeconds, intent);
      return;
    }
    case "asset":
      await goLiveWithAsset(target.assetId, target.assetKind, slideIndex, positionSeconds, intent);
      return;
    case "verse":
      useProgramStore.getState().setActive(null);
      useAudioStore.getState().setDeckTrack(null);
      useProjectionStore.getState().beginScene();
      projectVerse(target.verseIndex);
      useProjectionStore.getState().setOverlay("none");
      return;
    case "utility":
      goLiveWithUtilityScene(target.sceneId, null);
      return;
    case "song":
      // Not in the schedule: no row may claim the rail.
      if (await goLiveWithSong(target.songId, slideIndex, intent)) useProgramStore.getState().setActive(null);
      return;
    case "plate":
      // Handled above, before the live intent is claimed.
      return;
  }
}

/** Takes everything off the projector — the CLEAR row in Settings ->
 *  Live content (it is destructive, so it does not sit in the toolbar).
 *  The projection
 *  window is never hidden, so "nothing live" is just the logo output. Cuts
 *  every audio track too, not just the deck's — CLEAR means silence. */
export function clearLive(): void {
  claimLiveIntent();
  const store = useProjectionStore.getState();
  store.beginScene();
  store.setOverlay("none");
  store.setBase(null);
  store.setLiveDeck(null);
  useProgramStore.getState().setActive(null);
  useBibleStore.getState().setCurrentVerseIndex(null);
  useAudioStore.getState().clear();
}

/** Synchronous: the slide cursor lives in the store and flows out through
 *  `selectOutput`, so there is no IPC round-trip to wait on any more. A step
 *  past the last slide ends the deck (`endLiveContent`) — never on a held key's
 *  repeat, or holding → on the last slide would run through the next item. */
export function advanceSlide(direction: 1 | -1, repeat = false): void {
  const { base, liveDeck, setSlideIndex } = useProjectionStore.getState();
  if (base?.kind !== "deck" || !liveDeck) return;
  const next = base.slideIndex + direction;
  if (next > liveDeck.slides.length && !repeat) endLiveContent();
  if (next < 1 || next > liveDeck.slides.length) return;
  // Claimed here and not at the top: a keypress that bails out above changed
  // nothing on the projector, so it must not cancel a conversion in flight.
  claimLiveIntent();
  setSlideIndex(next);
  notifyManualNavigation();
}

export function gotoSlide(index: number): void {
  const { base, liveDeck, setSlideIndex } = useProjectionStore.getState();
  if (base?.kind !== "deck" || !liveDeck) return;
  claimLiveIntent();
  setSlideIndex(index);
  notifyManualNavigation();
}

/**
 * What the live deck or song does at its end (`projection.deckEnd` /
 * `projection.songEnd`, owner 2026-11-09): a deck that finished advancing on
 * its own (`end-of-playback.ts`), or the operator stepping past the last
 * slide. «next» under BLACK/LOGO only clears, as before the setting: going
 * live lifts the cover, and nobody asked to uncover the projector.
 */
export function endLiveContent(): void {
  const song = useProjectionStore.getState().base?.kind === "song";
  const action = useSettingsStore.getState().settings[song ? "projection.songEnd" : "projection.deckEnd"];
  if (action === "logo" || action === "black") clearBaseContentUnder(action);
  if (action === "loop") {
    if (song) gotoSongSlide(1);
    else restartDeck();
  }
  if (action !== "next") return;
  if (useProjectionStore.getState().overlay !== "none") clearBaseContent();
  else void goLiveWithNextScheduleItem().then((moved) => moved || clearBaseContent());
}

/** Clears just what's on the projector right now — a live video, PPT deck or
 *  image — back to nothing, via each row's own delete button. Unlike
 *  `clearLive` (the CLEAR button), it never touches independent audio
 *  tracks: deleting the video shouldn't silence a soundtrack playing
 *  alongside it.
 *
 *  BLACK/LOGO are unaffected on purpose: `selectOutputWithoutUnderlay` shows
 *  black/the logo regardless of `base` while either is up, so deleting
 *  what's underneath is invisible to the congregation — the operator stays
 *  exactly where they were, nothing to fade. Only `overlay === "none"` (the
 *  live content itself was on screen) actually loses something visible, so
 *  only that case begins a new scene and forces the overlay to LOGO — with
 *  no base left, BLACK/LOGO/LIVE would otherwise keep showing LIVE selected
 *  while the projector is actually rendering the logo fallback. */
export function clearBaseContent(): void {
  clearBaseContentUnder("logo");
}

/** `clearBaseContent`, with what goes over the cleared stage: LOGO (black
 *  without one), or BLACK when the operator chose it for a video's end
 *  (`projection.videoEnd`). Its own function because `clearBaseContent` is
 *  handed straight to `onClick`, which would pass the click as the cover. */
export function clearBaseContentUnder(cover: "logo" | "black"): void {
  // Claimed even when this runs unattended (`end-of-playback.ts`, a video that
  // reached its end): the rule is about the projector changing, not about who
  // changed it, and a deck landing on top of an auto-cleared stage is exactly
  // as unexplainable to the operator as one landing on top of BLACK.
  claimLiveIntent();
  const store = useProjectionStore.getState();
  const wasLive = store.overlay === "none";
  if (wasLive) store.beginScene();
  store.setBase(null);
  store.setLiveDeck(null);
  if (wasLive) store.setOverlay(cover);
  useAudioStore.getState().setDeckTrack(null);
  useProgramStore.getState().setActive(null);
  // Otherwise the Bible browser would keep showing the deleted verse as
  // on-air (bible-browser.tsx reads this independently of `base`) — the same
  // reason clearLive() resets it.
  useBibleStore.getState().setCurrentVerseIndex(null);
}

/** Toggles BLACK/LOGO — shared by the status-bar buttons and the B/L
 *  shortcuts so there's one definition of "toggle" (press again to clear).
 *  What plays under it — a video, a deck's soundtrack and its auto-advance —
 *  pauses and keeps its place (since 2026-09-09); a standalone audio track
 *  keeps sounding. Also opens the projection window on demand, the same as
 *  `goLive()`. */
export async function toggleOverlay(kind: Extract<OverlayState, "black" | "logo">): Promise<void> {
  claimLiveIntent();
  await useDisplayStore.getState().openIfNeeded();
  const { beginScene, overlay, setOverlay } = useProjectionStore.getState();
  beginScene();
  setOverlay(overlay === kind ? "none" : kind);
}

/** Shared by the three status-bar buttons (LOGO/BLACK/LIVE) — each always
 *  forces its own state (never "un-toggles" on a second press, unlike B/L's
 *  `toggleOverlay`). Opens the projection window on demand, same as
 *  `goLive()`, and begins a new scene so switching overlays fades like every
 *  other "send something new" action. */
export async function setOverlayDirect(kind: OverlayState): Promise<void> {
  // Claimed before the early return below, unlike `advanceSlide`: pressing
  // LOGO while the logo is already up changes no pixels, but it is still the
  // operator saying "keep showing this", and a deck that finished converting
  // must not overrule it.
  claimLiveIntent();
  await useDisplayStore.getState().openIfNeeded();
  const store = useProjectionStore.getState();
  // Pressing a button for the state that's already showing must not fade —
  // there is nothing to fade between, and under "fade through black" it would
  // flash the whole scene out and back in for no visible change.
  if (store.overlay === kind) return;
  store.beginScene();
  store.setOverlay(kind);
}
