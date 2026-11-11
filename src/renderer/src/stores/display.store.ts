import { create } from "zustand";
import { api } from "@renderer/lib/api";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useUiStore } from "@renderer/stores/ui.store";
import { claimLiveIntent } from "@renderer/lib/actions/live-intent";
import { freezeLivePositions } from "@renderer/lib/actions/live-positions";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import type { DisplayInfo } from "@shared/types/display";

/** Dedupes concurrent `load()` calls. The app boots one at startup and
 *  `openIfNeeded()` needs one whenever the operator's first GO LIVE beats it —
 *  two would list the screens twice and race to write the same resolution. */
let loadInFlight: Promise<void> | null = null;

/** Dedupes `openIfNeeded()`. `projection:open` answers only once the new page
 *  has mounted, and a second GO LIVE pressed in that wait would otherwise open
 *  the projector again — closing the window that was about to show. */
let openInFlight: Promise<void> | null = null;

/** There is no screen to project on: `displays.list()` came back empty.
 *  Giving up in silence is the one thing this must not do — `goLive()` carries
 *  on regardless, the monitors fill with content and nothing ever reaches a
 *  projector. Nothing is on air, so the app isn't lying (the LIVE header still
 *  reads "Projector off"); what was missing was the nudge to go and pick one,
 *  which is why the toast carries the action rather than just the diagnosis. */
function warnNoScreen(): void {
  toast.warning(t("projector.noScreen"), {
    action: {
      label: t("projector.chooseScreen"),
      onClick: () => useUiStore.getState().openSettings("projection"),
    },
  });
}

type DisplayStoreState = {
  displays: DisplayInfo[];
  displayId: number | null;
  loaded: boolean;

  /** Lists the available screens and resolves which one to target: the
   *  persisted `projection.displayId` setting when it still points at a
   *  connected display, otherwise the first that isn't the operator's own (the one
   *  hosting the control window) — the
   *  projector, in every real setup. */
  load: () => Promise<void>;
  setDisplayId: (id: number) => Promise<void>;
  /** Opens the projection window on the resolved display and immediately
   *  cuts it to BLACK — a projector that just connected mid-service must
   *  never flash whatever was last on screen. Used only for the explicit
   *  "Open projector" control in Settings. */
  open: () => Promise<void>;
  /** Opens the projection window on demand, on whatever is about to be shown
   *  (BLACK/LOGO/GO LIVE), without forcing BLACK first — a no-op once it's
   *  already open. This is what lets the app start with nothing projected at
   *  all: no window opens on launch, the operator's first tap on BLACK, LOGO
   *  or GO LIVE is what turns the projector on. */
  openIfNeeded: () => Promise<void>;
  close: () => Promise<void>;
  /** A screen came or went (`displays-changed`): re-lists them, so Settings
   *  shows a projector turned on after launch and the next GO LIVE targets it.
   *  It never moves the window — main already did, without rebuilding it
   *  (`windows/projector-screen.ts`). */
  refresh: () => Promise<void>;
};

export const useDisplayStore = create<DisplayStoreState>((set, get) => ({
  displays: [],
  displayId: null,
  loaded: false,

  load: async () => {
    loadInFlight ??= (async () => {
      try {
        const [displays, settings] = await Promise.all([
          api.displays.list(),
          useSettingsStore.getState().loaded
            ? Promise.resolve(useSettingsStore.getState().settings)
            : api.settings.get(),
        ]);
        const persisted = settings["projection.displayId"];
        const resolved =
          displays.find((d) => d.id === persisted) ?? displays.find((d) => !d.operator) ?? displays[0];
        set({ displays, displayId: resolved?.id ?? null, loaded: true });
      } finally {
        loadInFlight = null;
      }
    })();
    await loadInFlight;
  },

  setDisplayId: async (id) => {
    // Recreating the projection window rebuilds every media element inside it,
    // so the positions have to be folded into what main will replay BEFORE the
    // new window exists — see `freezeLivePositions`. Done here, ahead of the
    // `await` below: the output push is coalesced into a microtask
    // (`projection-sync.ts`), which drains while that await is pending, so main
    // holds the frozen values before `projection:open` is even sent.
    if (useProjectionStore.getState().presentationOpen) freezeLivePositions();
    set({ displayId: id });
    await useSettingsStore.getState().update({ "projection.displayId": id });
    // Moving the projector IS what picking a screen means. Nothing else in the
    // renderer reacts to `displayId`, so without this the window stayed on the
    // old display while the Select looked like it had done something — with no
    // hint that the fix was to close and reopen the window from the row below.
    // `projection:open` already closes the existing window and recreates it on
    // the chosen display, and the new one repaints itself from
    // `projection:getSnapshot`.
    if (useProjectionStore.getState().presentationOpen) await api.projection.open(id);
  },

  open: async () => {
    const { displayId } = get();
    if (displayId === null) {
      warnNoScreen();
      return;
    }
    if (!(await api.projection.open(displayId))) return;
    // Opening onto BLACK changes what the projector shows, so it claims an
    // intent like every other such action — otherwise a deck still converting
    // would lift the black the moment it finished. See `live-intent.ts`.
    claimLiveIntent();
    useProjectionStore.getState().setOverlay("black");
    useProjectionStore.getState().setPresentationOpen(true);
  },

  openIfNeeded: async () => {
    if (useProjectionStore.getState().presentationOpen) return;
    openInFlight ??= (async () => {
      try {
        // The operator's first GO LIVE/BLACK/LOGO can land before the boot's
        // `load()` has resolved, and "not listed yet" used to be indistinguishable
        // from "no screen at all" — both gave up here without a word.
        if (!get().loaded) await get().load();
        const { displayId } = get();
        if (displayId === null) {
          warnNoScreen();
          return;
        }
        // `false`: the window closed while it was still loading, and
        // `projection-closed` has already marked the projector closed.
        if (await api.projection.open(displayId)) useProjectionStore.getState().setPresentationOpen(true);
      } finally {
        openInFlight = null;
      }
    })();
    await openInFlight;
  },

  close: async () => {
    // Same reason as in `setDisplayId`: whatever is sounding right now should
    // resume where it was if the operator opens the projector again, instead
    // of restarting from the point they originally chose.
    freezeLivePositions();
    await api.projection.close();
    useProjectionStore.getState().setPresentationOpen(false);
  },

  refresh: () => get().load(),
}));
