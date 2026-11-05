import { useEffect, useRef, useState } from "react";
import { AppShell } from "@renderer/components/pages/layout/AppShell";
import { ProgramsModal } from "@renderer/components/pages/programs/ProgramsModal";
import { SettingsModal } from "@renderer/components/pages/settings/SettingsModal";
import { RemoveAssetConfirm } from "@renderer/components/pages/resources/remove-asset-confirm";
import {
  ConfirmModal,
  useAnyModalOpen,
} from "@renderer/components/shared/modal";
import { ErrorBoundary } from "@renderer/components/shared/error-boundary";
import { ModalBoundary } from "@renderer/components/shared/modal-boundary";
import { Button, LoadingState, ToastHost } from "@renderer/components/ui";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { installGlobalErrorHandlers } from "@renderer/lib/global-error-handlers";
import { api } from "@renderer/lib/api";
import { toast } from "@renderer/lib/toast";
import { restoreDraft } from "@renderer/lib/actions/programs";
import { loadScenes } from "@renderer/lib/actions/utility";
import { loadPlates } from "@renderer/lib/actions/overlays";
import { loadSongs, refreshLiveSong } from "@renderer/lib/actions/songs";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { LOGO_URL } from "@shared/urls";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useBibleStore } from "@renderer/stores/bible.store";
import { useDisplayStore } from "@renderer/stores/display.store";
import { useLibraryStore } from "@renderer/stores/library.store";
import { useUiStore } from "@renderer/stores/ui.store";
import { startProjectionEffects } from "@renderer/effects/projection-sync";
import { startLibrarySyncEffects } from "@renderer/effects/library-sync";
import { startDraftAutosave } from "@renderer/effects/draft-autosave";
import { startEngineAssetsSync } from "@renderer/effects/engine-assets-sync";
import { startUpdateAnnouncement } from "@renderer/effects/update-announcement";
import { useGlobalShortcuts } from "@renderer/lib/hooks/use-global-shortcuts";

/**
 * The unsaved-schedule restore is a once-per-process event, so it is guarded
 * outside React rather than by an effect.
 *
 * StrictMode double-invokes effects in development, and that is enough to make
 * a one-shot visible: the boot effect ran twice and the operator got the
 * "recovered the schedule" toast twice. It is the same trap as `F1` in the
 * field-bug report — a one-shot consumed where it can run more than once —
 * and the same answer: make it impossible by construction instead of relying
 * on how many times the caller happens to fire.
 */
let draftRestoreStarted = false;

/** Control window shell: boot the stores, mount the effect layer, render the
 *  workspace. All layout lives in AppShell, all behaviour in the actions. */
export function App() {
  const t = useT();
  const [programsOpen, setProgramsOpen] = useState(false);
  const [programsInitialMode, setProgramsInitialMode] = useState<
    { kind: "create" } | undefined
  >(undefined);
  // The only modal whose flag lives outside this component: toasts offer to
  // open Settings on a given section, and a toast action has no component
  // tree under it. See `ui.store.ts`.
  const settingsOpen = useUiStore((s) => s.settingsSection !== null);
  const openSettings = useUiStore((s) => s.openSettings);
  const closeSettings = useUiStore((s) => s.closeSettings);
  // Same reasoning, and one more: mounted here it exists ONCE. Rendered by
  // `MediaBrowser` it was one dialog per resource tab the operator had
  // visited, since those panels stay mounted after their first visit.
  const removeAssetConfirmId = useUiStore((s) => s.removeAssetConfirmId);
  const setRemoveAssetConfirmId = useUiStore((s) => s.setRemoveAssetConfirmId);
  const closeGuard = useUiStore((s) => s.closeGuard);
  const setCloseGuard = useUiStore((s) => s.setCloseGuard);
  /** `ConfirmModal` reports the close the same way whether the operator
   *  confirmed or backed out, and the two mean opposite things to main: one
   *  resumes the quit, the other has to release it so the NEXT close asks
   *  again instead of finding a stale pending record. */
  const closeConfirmedRef = useRef(false);
  const loadSettings = useSettingsStore((s) => s.load);
  const logoPath = useSettingsStore((s) => s.settings["logo.path"]);
  const setLogoUrl = useProjectionStore((s) => s.setLogoUrl);
  const transitionStyle = useSettingsStore(
    (s) => s.settings["projection.transition.style"],
  );
  const transitionDurationMs = useSettingsStore(
    (s) => s.settings["projection.transition.durationMs"],
  );
  const setTransitionSettings = useProjectionStore(
    (s) => s.setTransitionSettings,
  );
  const bibleStyle = useSettingsStore((s) => s.settings["bible.style"]);
  const setBibleStyle = useProjectionStore((s) => s.setBibleStyle);
  const fallbackFont = useSettingsStore((s) => s.settings["slides.fallbackFont"]);
  const locale = useSettingsStore((s) => s.settings["ui.locale"]);
  const setSlideText = useProjectionStore((s) => s.setSlideText);

  useGlobalShortcuts(useAnyModalOpen());

  useEffect(() => installGlobalErrorHandlers(), []);

  // A song is measured at the projector's proportion: another screen chosen,
  // or a projector plugged in, re-measures the live one in place.
  useEffect(
    () =>
      useDisplayStore.subscribe((state, previous) => {
        if (state.displayId !== previous.displayId || state.displays !== previous.displays) void refreshLiveSong();
      }),
    [],
  );

  useEffect(() => {
    void (async () => {
      await loadSettings();
      const { settings } = useSettingsStore.getState();
      useLibraryStore
        .getState()
        .hydrateActiveViews(
          settings["library.activeView"],
          settings["library.linkedFolders"],
        );
      // Nothing opens the projection window on launch any more — it was
      // unreliable. The operator's first tap on BLACK, LOGO or GO LIVE opens
      // it on demand (see display.store's `openIfNeeded`).
      await useDisplayStore.getState().load();
      // After the settings, never before: `loadVersions` settles on
      // `bible.defaultVersionId`, and reading that key before it is loaded
      // would silently open on whichever version happens to be first. This is
      // why the Bible tab no longer loads them on its own mount — two
      // unordered callers is exactly how that race was won by the wrong one.
      void useBibleStore.getState().loadVersions();
      void useBibleStore.getState().loadBookmarks();
      // The saved time scenes. Not awaited before the draft restore below and
      // not blocking it either: nothing in the schedule references a scene
      // yet (that is F3), and the Utilities panel is perfectly able to paint
      // its empty state for the few milliseconds this takes.
      void loadScenes();
      // The saved overlay plates, for the same reasons and with the same
      // non-blocking rule.
      void loadPlates();
      // The song library, the same way: a schedule row of a song paints its
      // title as soon as this lands.
      void loadSongs();

      // Last, and only once the library is reachable: the draft's items point
      // at media assets, and main has already dropped the ones that no longer
      // exist (`DraftRepo.load`). A failure here is silent on purpose — the
      // app starting with an empty schedule is a bad morning, the app not
      // starting is a worse one.
      try {
        if (draftRestoreStarted) return;
        draftRestoreStarted = true;
        const draft = await api.draft.load();
        // `restoreDraft` raises its own toast — this effect must stay free of
        // the hook's `t`, or the whole boot (every `start*Effects()` included)
        // would re-run the moment `loadSettings` changed the locale.
        if (draft) await restoreDraft(draft);
      } catch (error) {
        console.warn("[draft] restore failed", error);
      }
    })();
    const stopProjectionEffects = startProjectionEffects();
    const stopLibrarySync = startLibrarySyncEffects();
    // Also what lets main decide what the media engine plays — see `engine-assets-sync.ts`.
    const stopEngineAssetsSync = startEngineAssetsSync();
    // Started BEFORE the restore above can finish: its first write is
    // debounced, and the restore itself only ever rewrites the same draft.
    const stopDraftAutosave = startDraftAutosave();
    // Main's launch check comes ten seconds after the window, long after the
    // settings it reads have loaded.
    const stopUpdateAnnouncement = startUpdateAnnouncement();
    return () => {
      stopProjectionEffects();
      stopLibrarySync();
      stopEngineAssetsSync();
      stopDraftAutosave();
      stopUpdateAnnouncement();
    };
  }, [loadSettings]);

  useEffect(() => {
    // The path itself is the cache-buster: `worship://logo` is always the
    // same host, so without something in the URL that changes along with the
    // file, the projector's <img> would keep the previous logo cached.
    setLogoUrl(
      logoPath ? `${LOGO_URL}?p=${encodeURIComponent(logoPath)}` : null,
    );
  }, [logoPath, setLogoUrl]);

  // Mirrors the projection settings into the store the same way the logo
  // does above — `selectOutput` reads them off `projection.store`, not
  // straight from settings, so the projection window's input stays a single
  // self-contained value with no settings dependency of its own.
  useEffect(() => {
    setTransitionSettings(transitionStyle, transitionDurationMs);
  }, [transitionStyle, transitionDurationMs, setTransitionSettings]);

  // The verse's own look, mirrored for the same reason and by the same route.
  // Editing it in Settings while scripture is on the projector therefore
  // reaches the room immediately and WITHOUT a scene transition: nothing here
  // touches `sceneEpoch`, so `OutputView` swaps the layer in place instead of
  // fading a verse into a near-identical copy of itself.
  useEffect(() => {
    setBibleStyle(bibleStyle);
  }, [bibleStyle, setBibleStyle]);

  // What a model slide leaves to the machine (the face for a missing font,
  // the language of chart numbers): same route, same in-place restyle.
  useEffect(() => {
    setSlideText({ fallbackFont, locale });
  }, [fallbackFont, locale, setSlideText]);

  return (
    <>
      {/* Scoped to the workspace, not to the whole app: the toast host stays
          mounted outside it, so whatever recovery message the operator needs
          is still on screen even with the shell replaced by its fallback. */}
      <ErrorBoundary
        fallback={({ error, reset }) => (
          <div className="flex h-full items-center justify-center p-6">
            <LoadingState
              action={
                <div className="flex gap-2">
                  <Button onClick={reset} size="sm" variant="primary">
                    {t("common.retry")}
                  </Button>
                  <Button
                    onClick={() => window.location.reload()}
                    size="sm"
                    variant="outline"
                  >
                    {t("app.reload")}
                  </Button>
                </div>
              }
              hint={error.message}
              icon="alert"
              surface="panel"
              title={t("app.crashed")}
              tone="failed"
            />
          </div>
        )}
      >
        <AppShell
          onOpenPrograms={(opts) => {
            setProgramsInitialMode(
              opts?.mode === "create" ? { kind: "create" } : undefined,
            );
            setProgramsOpen(true);
          }}
          onOpenSettings={() => openSettings()}
        />
      </ErrorBoundary>
      {/* One boundary per modal, deliberately NOT a share of the shell's:
          a throw in a dialog must cost the operator that dialog, not the
          order of service behind it. See `ModalBoundary`. */}
      <ModalBoundary
        onCrash={() => {
          setProgramsOpen(false);
          toast.danger(t("app.modalCrashed"));
        }}
        open={programsOpen}
      >
        <ProgramsModal
          initialMode={programsInitialMode}
          onOpenChange={setProgramsOpen}
          open={programsOpen}
        />
      </ModalBoundary>
      <ModalBoundary
        onCrash={() => {
          closeSettings();
          toast.danger(t("app.modalCrashed"));
        }}
        open={settingsOpen}
      >
        <SettingsModal />
      </ModalBoundary>
      <ModalBoundary
        onCrash={() => {
          setRemoveAssetConfirmId(null);
          toast.danger(t("app.modalCrashed"));
        }}
        open={removeAssetConfirmId !== null}
      >
        <RemoveAssetConfirm
          assetId={removeAssetConfirmId}
          onOpenChange={(open) => {
            if (!open) setRemoveAssetConfirmId(null);
          }}
        />
      </ModalBoundary>
      {/* Main vetoed a close and asked the control window what to do — see
          `main/windows/close-guard.ts` and `effects/draft-autosave.ts`.
          Its boundary has one extra job: main is blocked waiting for a
          decision, and a dialog that vanished without answering would leave
          the app uncloseable until the 4 s grace expires. Crashing means
          "cancel" — the safe answer, since the whole point of this dialog is
          unsaved work. */}
      <ModalBoundary
        onCrash={() => {
          closeConfirmedRef.current = false;
          setCloseGuard(null);
          void api.window.closeDecision("cancel");
          toast.danger(t("app.modalCrashed"));
        }}
        open={closeGuard !== null}
      >
        <ConfirmModal
          confirmLabel={t("schedule.closeAnyway")}
          danger
          description={[
            closeGuard?.unsaved ? t("schedule.closeConfirmBody") : null,
            closeGuard?.onAir ? t("schedule.closeOnAirBody") : null,
          ]
            .filter(Boolean)
            .join(" ")}
          onConfirm={async () => {
            closeConfirmedRef.current = true;
            await api.window.closeDecision("close");
          }}
          onOpenChange={(open) => {
            if (open) return;
            setCloseGuard(null);
            const confirmed = closeConfirmedRef.current;
            closeConfirmedRef.current = false;
            if (!confirmed) void api.window.closeDecision("cancel");
          }}
          open={closeGuard !== null}
          title={closeGuard?.unsaved === false ? t("schedule.closeOnAirTitle") : t("schedule.closeConfirmTitle")}
        />
      </ModalBoundary>
      <ToastHost />
    </>
  );
}
