import { bibleVersionLabel, useBibleStore } from "@renderer/stores/bible.store";
import { useDeckStore } from "@renderer/stores/deck.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { selectOutputMemo, useProjectionStore } from "@renderer/stores/projection.store";
import { usePlayableAssetUrl } from "@renderer/stores/engine-assets.store";
import { useMediaAsset } from "@renderer/lib/hooks/use-media-asset";
import { clockForScene, findScene, useUtilityStore } from "@renderer/stores/utility.store";
import { bibleOutputFor } from "@renderer/lib/bible-output";
import { timerOutputFor } from "@renderer/lib/utility-output";
import { platePreviewOutput } from "@renderer/lib/plate-output";
import { useLiveVideoPoster } from "@renderer/lib/hooks/use-live-video-poster";
import { findPlate, useOverlayStore } from "@renderer/stores/overlay.store";
import { findSong, resolveSong, themeForSong, useSongStore } from "@renderer/stores/song.store";
import { footerAt, slideLines, slideTranslation, songOutputFor } from "@renderer/lib/song-output";
import { useSongFit } from "@renderer/lib/song-fit";
import { useSettingsStore } from "@renderer/stores/settings.store";
import type { ResolvedSong, Song, SongTheme } from "@shared/types/song";
import { assetUrl } from "@shared/urls";
import type { MediaAsset } from "@shared/types/media";
import type { UtilityScene } from "@shared/types/utility";
import type { Plate } from "@shared/types/overlay";
import { INSTANT_TRANSITION } from "@shared/types/projection";
import type { ProjectionOutput } from "@shared/types/projection";

/**
 * The preview target resolved against the stores — one shape the whole right
 * column and the slide grid can switch on, instead of every panel re-deriving
 * "what am I looking at" from three stores.
 */
export type PreviewContent =
  | { kind: "deck"; assetId: number; title: string; missingSince: number | null }
  | { kind: "media"; asset: MediaAsset }
  | { kind: "bible"; reference: string; text: string; versionLabel: string | null; verseIndex: number | null }
  | { kind: "utility"; scene: UtilityScene }
  | { kind: "plate"; plate: Plate }
  | { kind: "song"; song: Song; resolved: ResolvedSong; theme: SongTheme };

export function usePreviewContent(): PreviewContent | null {
  const target = usePreviewStore((s) => s.target);
  const items = useProgramStore((s) => s.items);
  const verses = useBibleStore((s) => s.verses);
  const versionId = useBibleStore((s) => s.versionId);
  const versions = useBibleStore((s) => s.versions);
  const scenes = useUtilityStore((s) => s.scenes);
  const plates = useOverlayStore((s) => s.plates);
  const songs = useSongStore((s) => s.songs);
  const themes = useSongStore((s) => s.themes);
  const defaultThemeId = useSettingsStore((s) => s.settings["songs.defaultThemeId"]);
  const license = useSettingsStore((s) => s.settings["songs.ccliLicense"]);
  const songContent = (id: number): PreviewContent | null => {
    const song = findSong(songs, id);
    if (!song) return null;
    const theme = themeForSong(song, themes, defaultThemeId);
    return { kind: "song", song, resolved: resolveSong(song, theme, license), theme };
  };

  const selectedIndex = useProgramStore((s) => s.selectedIndex);
  const scheduleItem = target?.kind === "scheduleItem" && selectedIndex !== null ? items[selectedIndex] : undefined;
  const scheduleAssetId =
    scheduleItem?.kind === "media" || scheduleItem?.kind === "ppt" ? scheduleItem.mediaAssetId : null;
  // Both lookups are unconditional: hooks can't be called behind a branch, and
  // useMediaAsset(null) is a no-op.
  const scheduleAsset = useMediaAsset(scheduleAssetId);
  const directAsset = useMediaAsset(target?.kind === "asset" ? target.assetId : null);

  if (!target) return null;

  if (target.kind === "verse") {
    const verse = verses[target.verseIndex];
    if (!verse) return null;
    return {
      kind: "bible",
      reference: `${verse.bookName} ${verse.chapter}:${verse.verse}`,
      text: verse.text,
      versionLabel: bibleVersionLabel(versions, versionId),
      verseIndex: target.verseIndex,
    };
  }

  if (target.kind === "utility") {
    // Resolved on every render rather than copied into the target, so editing
    // a scene is reflected in the preview the moment it is saved.
    const scene = findScene(scenes, target.sceneId);
    return scene ? { kind: "utility", scene } : null;
  }

  if (target.kind === "plate") {
    const plate = findPlate(plates, target.plateId);
    return plate ? { kind: "plate", plate } : null;
  }

  if (target.kind === "song") return songContent(target.songId);

  if (target.kind === "asset") {
    if (!directAsset) return null;
    return target.assetKind === "ppt"
      ? {
          kind: "deck",
          assetId: directAsset.id,
          title: directAsset.name,
          missingSince: directAsset.missingSince,
        }
      : { kind: "media", asset: directAsset };
  }

  if (!scheduleItem) return null;
  switch (scheduleItem.kind) {
    case "ppt":
      return scheduleAsset
        ? {
            kind: "deck",
            assetId: scheduleAsset.id,
            title: scheduleItem.title ?? scheduleAsset.name,
            missingSince: scheduleAsset.missingSince,
          }
        : null;
    case "media":
      return scheduleAsset ? { kind: "media", asset: scheduleAsset } : null;
    case "bible":
      return {
        kind: "bible",
        reference: scheduleItem.reference,
        text: scheduleItem.text,
        // The row's own version rather than whatever the Bible tab happens to
        // be browsing: a program written against RV1909 previews as RV1909
        // even while the operator is looking at another one.
        versionLabel: bibleVersionLabel(versions, scheduleItem.bibleVersionId),
        verseIndex: null,
      };
    case "utility": {
      // Resolved against the list for the same reason a `utility` preview
      // target is: the row holds an id, so a scene edited since the program
      // was saved previews the way it will project. A scene that is gone
      // previews as nothing rather than as a broken tile — the draft's own
      // filter (`DraftRepo.load`) and the delete guard between them make that
      // a very narrow window, never an impossible one.
      const scene = findScene(scenes, scheduleItem.utilitySceneId);
      return scene ? { kind: "utility", scene } : null;
    }
    case "plate": {
      const plate = findPlate(plates, scheduleItem.overlayPlateId);
      return plate ? { kind: "plate", plate } : null;
    }
    case "song":
      return songContent(scheduleItem.songId);
  }
}

/**
 * The preview pane's own `ProjectionOutput` — the same value type the projector
 * consumes, so the preview monitor is literally the projection renderer fed a
 * different input. Returns null when there is nothing renderable (an audio-only
 * asset, or a deck still converting).
 */
export function usePreviewOutput(content: PreviewContent | null): ProjectionOutput | null {
  const isPlate = content?.kind === "plate";
  // Subscribed only while a plate is previewed: otherwise this monitor would
  // re-render on every slide the projector advances. `selectOutputMemo` keeps
  // the identity stable, so the default comparator is enough.
  const live = useProjectionStore((s) => (isPlate ? selectOutputMemo(s) : null));
  const liveVideoAssetId = useProjectionStore((s) => (isPlate && s.base?.kind === "video" ? s.base.assetId : null));
  const videoStillUrl = useLiveVideoPoster(liveVideoAssetId);
  const output = usePreviewOutputWithoutPlates(content);
  if (content?.kind === "plate" && live) return platePreviewOutput(live, content.plate, videoStillUrl);
  return output;
}

function usePreviewOutputWithoutPlates(content: PreviewContent | null): ProjectionOutput | null {
  const slideIndex = usePreviewStore((s) => s.slideIndex);
  const playing = usePreviewStore((s) => s.playing);
  const run = useUtilityStore((s) => s.run);
  const liveBase = useProjectionStore((s) => s.base);
  // Off `projection.store` and not `settings.store`: it is the very value the
  // projector is being pushed, mirrored there by `App` — reading the setting
  // directly would let the preview lead the projector by one render.
  const bibleStyle = useProjectionStore((s) => s.bibleStyle);
  const slideText = useProjectionStore((s) => s.slideText);
  const deckEntry = useDeckStore((s) => (content?.kind === "deck" ? s.byAssetId[content.assetId] : undefined));
  const playableUrl = usePlayableAssetUrl(content?.kind === "media" ? content.asset.id : null);
  // The size the projector will get: the same measurement, the same cache.
  const songFit = useSongFit(
    content?.kind === "song" ? content.resolved : null,
    content?.kind === "song" ? content.theme : null,
  );

  if (!content) return null;

  switch (content.kind) {
    case "deck": {
      const slides = deckEntry?.deck?.slides ?? [];
      const slide = slides[Math.min(slideIndex, slides.length) - 1];
      if (!slide) return null;
      return {
        kind: "slide",
        deckAssetId: content.assetId,
        url: slide.url,
        modelUrl: slide.modelUrl,
        index: slide.index,
        total: slides.length,
        // The projector warms neighbours; a monitor has no reason to.
        preload: [],
        // Stage one never animates (`INSTANT_TRANSITION`), a slide's own way
        // in included.
        enter: null,
        text: slideText,
        videoUnderlay: null,
        // Never plays here, even on a slide that carries one. Stage one of the
        // two-stage flow shows what the slide LOOKS like, and the slide
        // already draws the video's poster frame — starting a clip
        // because the operator arrowed past it is exactly the "selecting
        // projects" behaviour this flow exists to prevent.
        slideVideo: null,
        plates: [],
        // The preview monitor never fades — it moves with every ↑/↓, and
        // `OutputView` also forces this by `mode`, but the value has to be
        // here too since it's part of `ProjectionOutput`.
        transition: INSTANT_TRANSITION,
      };
    }
    case "media": {
      // A missing file has nothing to show — the preview monitor falls back
      // to its own black "not found" stage (see `PreviewMonitor`) instead of
      // pointing an <img>/<video> at a dead url.
      if (content.asset.missingSince !== null) return null;
      if (content.asset.kind === "image") {
        return {
          kind: "image",
          url: assetUrl(content.asset.id),
          videoUnderlay: null,
          slideVideo: null,
          plates: [],
          transition: INSTANT_TRANSITION,
        };
      }
      if (content.asset.kind === "video") {
        // The preview never autoplays — only the operator's own play button
        // (`togglePreviewPlayback`) sets `playing`, which this just mirrors
        // declaratively. `epoch` stays fixed at 0 so the element is reused
        // (only `src` changes) across every click in the library instead of
        // being torn down and rebuilt — the same churn that produces
        // PIPELINE_ERROR_DECODE on the live video. `startAtSeconds` stays 0
        // too: re-applying it as a prop would fight the element's own clock
        // on every re-render, so a scrub goes through `seekPreview` imperatively
        // instead, exactly like the live video's own seek.
        // `volume: 0` because this output only ever reaches the PREVIEW
        // monitor, which `OutputView` mutes by construction (every mode but
        // "live"). The field is here because the shape requires it, not
        // because anything reads it.
        const url = playableUrl ?? assetUrl(content.asset.id);
        const underlay = { url, epoch: 0, paused: !playing, startAtSeconds: 0, volume: 0 };
        return {
          kind: "video",
          url: underlay.url,
          epoch: underlay.epoch,
          videoUnderlay: underlay,
          slideVideo: null,
          plates: [],
          transition: INSTANT_TRANSITION,
        };
      }
      return null;
    }
    case "bible":
      // The same builder and the same style the projector reads, so this
      // monitor cannot dress a verse differently from the room.
      return {
        ...bibleOutputFor(content, bibleStyle),
        videoUnderlay: null,
        slideVideo: null,
        plates: [],
        transition: INSTANT_TRANSITION,
      };
    case "plate":
      // Drawn over the live stage by `usePreviewOutput`, never from here.
      return null;
    case "song":
      // Nothing until the song is measured — a frame, the first time — so the
      // monitor never shows it at a size the projector will not use.
      if (!songFit) return null;
      return {
        ...songOutputFor(
          content.resolved,
          slideLines(content.resolved, slideIndex),
          content.theme,
          songFit.sizeCqw,
          footerAt(content.resolved, content.theme, { slideIndex, detour: null }),
          null,
          slideTranslation(content.resolved, slideIndex),
        ),
        videoUnderlay: null,
        slideVideo: null,
        plates: [],
        transition: INSTANT_TRANSITION,
      };
    case "utility":
      // The SAME clock the row below shows, so an operator who started the
      // countdown sees it running here before deciding to send it — and the
      // same builder the projector's own output uses. Previewing the scene
      // that is already live reads the projector's copy, so this monitor can
      // never disagree with the one beside it.
      return {
        ...timerOutputFor(content.scene, clockForScene(liveBase, run, content.scene, Date.now())),
        videoUnderlay: null,
        slideVideo: null,
        plates: [],
        transition: INSTANT_TRANSITION,
      };
  }
}
