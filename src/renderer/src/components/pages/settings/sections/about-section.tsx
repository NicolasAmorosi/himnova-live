import { useEffect, useState } from "react";
import { useI18n, type Translate } from "@renderer/lib/i18n/i18n-provider";
import {
  Badge,
  BrandMark,
  Button,
  Caption,
  FieldGroup,
  FieldRow,
  ProgressMeter,
  Switch,
  Wordmark,
} from "@renderer/components/ui";
import { ConfirmModal } from "@renderer/components/shared/modal";
import { quitRisks } from "@renderer/effects/draft-autosave";
import { api } from "@renderer/lib/api";
import { onIpc } from "@renderer/lib/ipc";
import { toast } from "@renderer/lib/toast";
import { useSettingsStore } from "@renderer/stores/settings.store";
import type { CloseGuardReasons } from "@renderer/stores/ui.store";
import type { Locale } from "@shared/types/settings";
import { canCheck, type UpdateStatus } from "@shared/types/updates";

/** Main's update status, kept current. Subscribed before asking, and the
 *  answer never overwrites an event that arrived first. */
function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    const stop = onIpc("update-status", setStatus);
    api.updates
      .getStatus()
      .then((current) => setStatus((pushed) => pushed ?? current))
      .catch((error: unknown) => console.warn("[updates] status failed", error));
    return stop;
  }, []);
  return status;
}

/** The version on offer, while there is one. */
function offeredVersion(status: UpdateStatus | null): string | null {
  return status?.kind === "available" || status?.kind === "downloading" || status?.kind === "downloaded"
    ? status.version
    : null;
}

function describe(status: UpdateStatus | null, t: Translate, locale: Locale): string | undefined {
  switch (status?.kind) {
    case undefined:
      return undefined;
    case "unsupported":
    case "idle":
    case "checking":
      return t(`settings.updatesState.${status.kind}`);
    case "upToDate":
      return t("settings.updatesState.upToDate", {
        time: new Date(status.checkedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }),
      });
    case "available":
      return t("settings.updatesState.available", { version: status.version });
    case "downloading":
      return t("settings.updatesState.downloading", { version: status.version });
    case "downloaded":
      return t(
        status.opensInstaller
          ? status.installOnQuit
            ? "settings.updatesState.readyDmgOnQuit"
            : "settings.updatesState.readyDmg"
          : status.installOnQuit
            ? "settings.updatesState.readyOnQuit"
            : "settings.updatesState.ready",
        { version: status.version },
      );
    case "error":
      return t(`settings.updatesErrors.${status.code}`);
  }
}

/** Megabytes as the operating system counts them (Finder, Explorer's «MB»). */
const megabytes = (bytes: number, locale: Locale) =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(bytes / 1_000_000);

/** Which build this is, whether a newer one is out — and getting it —, and
 *  where its logs are: the things someone on the phone asks for first, under
 *  the product's own name and mark. */
export function AboutSection() {
  const { t, locale } = useI18n();
  const status = useUpdateStatus();
  const autoCheck = useSettingsStore((s) => s.settings["updates.autoCheck"]);
  const updateSettings = useSettingsStore((s) => s.update);
  /** «Restart and update» with something at risk: the close's own question. */
  const [risks, setRisks] = useState<CloseGuardReasons | null>(null);
  const offered = offeredVersion(status);
  const failed = () => toast.danger(t("settings.updatesErrors.unknown"));
  const installLabel =
    status?.kind === "downloaded" && status.opensInstaller
      ? t("settings.updatesOpenInstaller")
      : t("settings.updatesInstallNow");

  /** Installing quits the app, so it asks exactly when a quit would — and
   *  before main starts the installer, which kills the app within seconds
   *  whatever is answered after. */
  function installNow() {
    const found = quitRisks();
    if (found) setRisks(found);
    else void api.updates.install("now").catch(failed);
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-5 py-2">
        <BrandMark className="size-20" />
        <div className="flex flex-col gap-2">
          <Wordmark className="text-5xl" />
          <Caption className="select-text">
            {/* The version is the row below, once (2026-11-05 review). */}
            {t("settings.aboutTagline")}
          </Caption>
        </div>
      </div>

      <FieldGroup title={t("settings.groups.about")}>
        <FieldRow description={t("settings.versionDesc")} label={t("settings.version")}>
          <Caption className="select-text">{__APP_VERSION__}</Caption>
        </FieldRow>
        <FieldRow
          description={
            // Under the words, across the row: next to the buttons, a bar fits
            // only as a sliver (owner, 2026-11-05).
            status?.kind === "downloading" ? (
              <ProgressMeter
                aria-label={t("settings.updatesProgress")}
                className="mt-2"
                detail={
                  status.total > 0
                    ? t("settings.updatesSize", {
                        transferred: megabytes(status.transferred, locale),
                        total: megabytes(status.total, locale),
                      })
                    : undefined
                }
                label={describe(status, t, locale)}
                readout={new Intl.NumberFormat(locale, { style: "percent" }).format(status.percent / 100)}
                value={status.percent / 100}
              />
            ) : (
              describe(status, t, locale)
            )
          }
          label={
            <span className="flex items-center gap-2">
              {t("settings.updates")}
              {offered ? <Badge variant="blue">{t("settings.updatesNew")}</Badge> : null}
            </span>
          }
        >
          {offered ? (
            <Button onClick={() => void api.updates.openReleaseNotes().catch(failed)} size="sm" variant="outline">
              {t("settings.updatesNotes")}
            </Button>
          ) : null}
          {status?.kind === "available" ? (
            <Button onClick={() => void api.updates.download().catch(failed)} size="sm" variant="primary">
              {t("settings.updatesDownload")}
            </Button>
          ) : status?.kind === "downloading" ? null : status?.kind === "downloaded" ? (
            <>
              {status.installOnQuit ? null : (
                <Button onClick={() => void api.updates.install("onQuit").catch(failed)} size="sm" variant="outline">
                  {t("settings.updatesInstallOnQuit")}
                </Button>
              )}
              <Button onClick={installNow} size="sm" variant="primary">
                {installLabel}
              </Button>
            </>
          ) : (
            <Button
              disabled={status === null || !canCheck(status)}
              onClick={() => void api.updates.check().catch(failed)}
              size="sm"
              variant="outline"
            >
              {t("settings.updatesCheck")}
            </Button>
          )}
        </FieldRow>
        {/* A build that cannot update itself never checks either. */}
        {status && status.kind !== "unsupported" ? (
          <FieldRow description={t("settings.updatesAutoCheckDesc")} label={t("settings.updatesAutoCheck")}>
            <Switch
              checked={autoCheck}
              onChange={(e) => void updateSettings({ "updates.autoCheck": e.target.checked })}
            />
          </FieldRow>
        ) : null}
        <FieldRow description={t("settings.logsDesc")} label={t("settings.logs")}>
          <Button
            onClick={() => void api.system.openLogsFolder().catch(() => toast.danger(t("settings.logsError")))}
            size="sm"
            variant="outline"
          >
            {t("settings.logsOpen")}
          </Button>
        </FieldRow>
      </FieldGroup>

      <ConfirmModal
        confirmLabel={installLabel}
        danger
        description={[
          risks?.unsaved ? t("schedule.closeConfirmBody") : null,
          risks?.onAir ? t("schedule.closeOnAirBody") : null,
        ]
          .filter(Boolean)
          .join(" ")}
        onConfirm={() => api.updates.install("now")}
        onOpenChange={(open) => {
          if (!open) setRisks(null);
        }}
        open={risks !== null}
        title={t("settings.updatesInstallTitle")}
      />
    </div>
  );
}
