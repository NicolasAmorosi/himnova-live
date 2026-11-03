import { api } from "@renderer/lib/api";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import { sofficeBlocks, useDeckStore } from "@renderer/stores/deck.store";
import { useSettingsStore } from "@renderer/stores/settings.store";

/** «Check again»: a new sweep, for a LibreOffice installed while the
 *  app was open. Answered either way — the gate it lifts may not be on
 *  screen, and a button that changes nothing visible looks broken. */
export async function recheckSoffice(): Promise<void> {
  await useDeckStore.getState().loadEnvironment(true);
  const environment = useDeckStore.getState().environment;
  if (environment?.available) {
    retireStartupToast();
    toast.success(t("deck.noLibreOffice.found", { version: environment.version ?? "" }));
  } else toast.warning(environment?.message ?? t("deck.noLibreOffice.title"));
}

export function silenceSofficeWarning(): Promise<void> {
  retireStartupToast();
  return useSettingsStore.getState().update({ "slides.warnMissingSoffice": false });
}

/** Once per process: StrictMode runs the boot effect twice in development,
 *  which is how the draft-restored toast came out doubled (see `App`). */
let announced = false;
/** The launch warning while it may still be on screen. */
let startupToastId: string | null = null;

/** Retired by hand when it stops applying, before its 10 s are up: it stayed
 *  up saying «isn't available» beside «is ready», and after «Don't show again»
 *  was pressed on the PPT tab's strip. */
function retireStartupToast(): void {
  if (startupToastId) toast.dismiss(startupToastId);
  startupToastId = null;
}

/** The launch-time warning, which also loads the answer every deck gate reads.
 *  Run after the settings are loaded: it reads the operator's choice to
 *  silence it, and `t` reads the locale from there. */
export async function announceMissingSoffice(): Promise<void> {
  await useDeckStore.getState().loadEnvironment();
  if (announced || useDeckStore.getState().environment?.available !== false) return;
  announced = true;
  if (!useSettingsStore.getState().settings["slides.warnMissingSoffice"]) return;
  // Timed although it carries an action: it sits over PREVIEW, and kept up
  // it hid «Relocate…» until someone closed it. The PPT tab's strip and the
  // deck gates keep saying it, «Don't show again» included.
  startupToastId = toast.warning(t("deck.noLibreOffice.startup"), {
    action: { label: t("deck.noLibreOffice.dontWarn"), onClick: () => void silenceSofficeWarning() },
    durationMs: 10_000,
  });
}

/**
 * Says why a GO LIVE on a deck changed nothing, when the reason is a missing
 * LibreOffice. The panel that explains it may not be the one the operator is
 * looking at, and a press that does nothing in silence reads as a frozen app.
 *
 * Asked after the failure, not before the press: whether the deck is already
 * converted — and so projects without LibreOffice — is main's to answer, and a
 * check made up front refused a converted deck double-clicked before its
 * cache lookup came back.
 */
export async function explainSofficeRefusal(assetId: number): Promise<void> {
  // Re-read: the failed conversion just swept for LibreOffice again.
  const [asset] = await Promise.all([api.library.get(assetId), useDeckStore.getState().loadEnvironment()]);
  const { environment, byAssetId } = useDeckStore.getState();
  if (asset && sofficeBlocks(environment, asset.ext, byAssetId[assetId])) {
    toast.warning(t("deck.noLibreOffice.liveRefused", { name: asset.name }));
  }
}
