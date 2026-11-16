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
import { projectorDisplayFor } from "@shared/display-roles";

/** Dedupes concurrent `load()` calls. The app boots one at startup and
 *  `openIfNeeded()` needs one whenever the operator's first GO LIVE beats it —
 *  two would list the screens twice and race to write the same resolution. */
let loadInFlight: Promise<void> | null = null;

/** Dedupes `openIfNeeded()`. `projection:open` answers only once the new page
 *  has mounted, and a second GO LIVE pressed in that wait would otherwise open
 *  the projector again — closing the window that was about to show. */
let openInFlight: Promise<void> | null = null;

/** The operator closed the projector (Settings ▸ Screens): a screen coming or going does not open it again this
 *  session. Whatever opens it next — GO LIVE, BLACK, LOGO, «Abrir» — lets it open by itself again. */
let closedByOperator = false;
/** Off under the E2E suite (`projection:autoOpen`). */
let autoOpenEnabled = false;

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
      onClick: () => useUiStore.getState().openSettings("screens"),
    },
  });
}

type DisplayStoreState = {
  displays: DisplayInfo[];
  displayId: number | null;
  loaded: boolean;
  /** The projector's screen went away and main hid its window, still playing (`projector-screen`). */
  projectorHidden: boolean;

  /** Lists the available screens and resolves which one to target
   *  (`projectorDisplayFor`): the persisted `projection.displayId` while it is
   *  connected, otherwise the first that is neither the operator's own (the one
   *  hosting the control window) nor the stage's — the projector, in every
   *  real setup. */
  load: () => Promise<void>;
  setDisplayId: (id: number) => Promise<void>;
  /** Opens the projection window on the resolved display and immediately
   *  cuts it to BLACK — a projector that just connected mid-service must
   *  never flash whatever was last on screen. Used only for the explicit
   *  "Open projector" control in Settings. */
  open: () => Promise<void>;
  /** Opens the projection window on demand, on whatever is about to be shown
   *  (BLACK/LOGO/GO LIVE), without forcing BLACK first — a no-op once it's
   *  already open. `autoOpen` uses it at launch; a projector the operator
   *  closed, or one with no screen of its own, opens here on the next tap. */
  openIfNeeded: () => Promise<void>;
  close: () => Promise<void>;
  /**
   * Opens the projector by itself, like the stage (owner, 2026-11-13): at launch and when its screen appears, with
   * whatever is live (nothing yet: the LOGO). Never onto the operator's own screen — with one screen it waits for the
   * projector to be connected — and not after the operator closed it this session.
   */
  autoOpen: (enabled?: boolean) => Promise<void>;
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
  projectorHidden: false,

  load: async () => {
    loadInFlight ??= (async () => {
      try {
        const [displays, settings] = await Promise.all([
          api.displays.list(),
          useSettingsStore.getState().loaded
            ? Promise.resolve(useSettingsStore.getState().settings)
            : api.settings.get(),
        ]);
        const operatorId = displays.find((d) => d.operator)?.id ?? displays[0]?.id ?? -1;
        const displayId = projectorDisplayFor(
          displays.map((d) => d.id),
          operatorId,
          settings["projection.displayId"],
          settings["stage.displayId"],
        );
        set({ displays, displayId, loaded: true });
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
    closedByOperator = false;
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
    closedByOperator = false;
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
    closedByOperator = true;
    // Same reason as in `setDisplayId`: whatever is sounding right now should
    // resume where it was if the operator opens the projector again, instead
    // of restarting from the point they originally chose.
    freezeLivePositions();
    await api.projection.close();
    useProjectionStore.getState().setPresentationOpen(false);
    set({ projectorHidden: false });
  },

  autoOpen: async (enabled) => {
    if (enabled !== undefined) autoOpenEnabled = enabled;
    if (!autoOpenEnabled || closedByOperator || useProjectionStore.getState().presentationOpen) return;
    if (!get().loaded) await get().load();
    const { displayId, displays } = get();
    const target = displays.find((d) => d.id === displayId);
    if (!target || target.operator) return;
    await get().openIfNeeded();
  },

  refresh: async () => {
    await get().load();
    // A projector turned on after the app opened.
    await get().autoOpen();
  },
}));
