// The wdth+wght file, not the default wght-only one: titles and the wordmark use
// the ExtraCondensed cut of this same family (`font-stretch-extra-condensed`).
import "@fontsource-variable/noto-sans/wdth.css";
import "./styles/globals.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installDropGuard } from "@renderer/lib/drop-guard";
import { LocaleProvider } from "@renderer/lib/i18n/locale-provider";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { LoadingState } from "@renderer/components/ui";
import { App } from "@renderer/app/App";
import { recoverLiveState } from "@renderer/effects/live-copy";
import { queueProjectionPushesFirst } from "@renderer/effects/projection-sync";

installDropGuard();
// Before any component subscribes to the stores: what goes to the projector leaves before this window draws again.
queueProjectionPushesFirst();

const container = document.getElementById("root");
if (!container) throw new Error("#root element not found");
const root = createRoot(container);

// A page starting over what is live puts it back before anything is drawn or listens (`effects/live-copy.ts`). One
// that cannot stays inert: no effect starts, so nothing reaches the room, and the operator is told to restart.
void recoverLiveState().then((start) =>
  root.render(
    <StrictMode>
      <LocaleProvider>
        {start === "failed" ? (
          <div className="flex h-full items-center justify-center p-6">
            <LoadingState icon="alert" surface="panel" title={t("app.controlRecoveryFailed")} tone="failed" />
          </div>
        ) : (
          <App />
        )}
      </LocaleProvider>
    </StrictMode>,
  ),
);
