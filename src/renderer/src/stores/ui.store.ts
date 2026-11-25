import { create } from "zustand";

export type SettingsSection =
  | "projection"
  | "screens"
  | "stream"
  | "sound"
  | "slides"
  | "bible"
  | "songs"
  | "system"
  | "backups"
  | "about";

/**
 * App-level chrome that something outside React has to be able to open.
 *
 * Modal visibility normally belongs in `App.tsx`'s own state, and `programsOpen`
 * still lives there. Settings is the exception: two toasts offer a way into it
 * — "Choose screen" from `display.store` when there is no screen to project
 * on, «View» from `effects/update-announcement.ts` when a new version is out —
 * and a toast action is a plain function with no component tree under it.
 * Routing Settings and its section through a store is what lets each offer
 * land on the section it names (Screen, About) instead of only naming it.
 */
type UiStoreState = {
  /** The Settings section on screen; `null` while Settings is closed. */
  settingsSection: SettingsSection | null;
  /** Opens Settings on `section`, or switches to it when already open. */
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  /** The first-run welcome (`WelcomeScreen`): opened by `App` on a new profile, or by hand from
   *  Settings ▸ About — which it then replaces, the two being full screens. */
  welcomeOpen: boolean;
  openWelcome: () => void;
  closeWelcome: () => void;
  /** «Novedades» (`WhatsNewScreen`): opened by `App` once after an update, or by hand from Settings ▸ About, which
   *  it then replaces like the welcome. Settings opened FROM it stacks on top and gives it back on close. */
  whatsNewOpen: boolean;
  openWhatsNew: () => void;
  closeWhatsNew: () => void;
  /** The asset whose "remove anyway" confirmation is open, `null` when
   *  none. Here for the same reason as `settingsSection`: the offer is a toast
   *  action raised from `lib/actions/remove-asset.ts`, with no component tree
   *  under it. Global also means the dialog can be rendered ONCE, in `App`,
   *  rather than by every mounted `MediaBrowser` — see `F1`. */
  removeAssetConfirmId: number | null;
  setRemoveAssetConfirmId: (id: number | null) => void;
  /** "Close anyway?" — raised from `effects/draft-autosave.ts` when main
   *  asks whether the window may close, which again is not a component's
   *  question to ask. `null` when closed; otherwise why it is asking. */
  closeGuard: CloseGuardReasons | null;
  setCloseGuard: (reasons: CloseGuardReasons | null) => void;
  /** How many full-screen editors are open with unsaved changes: each
   *  `EditorScreen` counts itself in (`holdUnsavedEditor`), so a quit asks
   *  about them like it asks about the schedule (2026-11-06). */
  unsavedEditors: number;
};

/** Why closing needs a confirmation: work that is not saved — the schedule
 *  (`unsaved`) or an open editor's (`editor`) —, and/or something the
 *  congregation is looking at right now. */
/** `sound`: the name of what is playing in the room when nothing is on the projector (the prelude over the resting
 *  LOGO): closing silences it. */
export type CloseGuardReasons = { unsaved: boolean; editor: boolean; onAir: boolean; sound: string | null };

export const useUiStore = create<UiStoreState>((set) => ({
  settingsSection: null,
  openSettings: (section = "projection") => set({ settingsSection: section }),
  closeSettings: () => set({ settingsSection: null }),
  welcomeOpen: false,
  // Never both full screens at once: the welcome covers what «Novedades» would say.
  openWelcome: () => set({ settingsSection: null, welcomeOpen: true, whatsNewOpen: false }),
  closeWelcome: () => set({ welcomeOpen: false }),
  whatsNewOpen: false,
  openWhatsNew: () => set({ settingsSection: null, whatsNewOpen: true }),
  closeWhatsNew: () => set({ whatsNewOpen: false }),
  removeAssetConfirmId: null,
  setRemoveAssetConfirmId: (removeAssetConfirmId) => set({ removeAssetConfirmId }),
  closeGuard: null,
  setCloseGuard: (closeGuard) => set({ closeGuard }),
  unsavedEditors: 0,
}));

/** An editor with unsaved changes counts itself in; the returned function counts it out. */
export function holdUnsavedEditor(): () => void {
  useUiStore.setState((state) => ({ unsavedEditors: state.unsavedEditors + 1 }));
  return () => useUiStore.setState((state) => ({ unsavedEditors: state.unsavedEditors - 1 }));
}
