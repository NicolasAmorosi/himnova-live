import { useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Button, FieldGroup, FieldRow, Icon, type IconName } from "@renderer/components/ui";
import { useDisplayStore } from "@renderer/stores/display.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useUiStore } from "@renderer/stores/ui.store";
import { LATEST_WHATS_NEW, type WhatsNewKey } from "@shared/whats-new";
import { GuideScreen } from "./GuideScreen";
import { SoundStep } from "./SoundStep";
import { StageNewsStep } from "./StageNewsStep";
import { StepLayout } from "./StepLayout";
import { useSoundSummary } from "./use-sound-summary";

type WhatsNewStepId = "stage" | "sound" | "done";

/** Each version's «Novedades», in order; the last step closes it. A new version adds its key in `shared/whats-new.ts`
 *  and its steps here (a key without them does not compile). */
const WHATS_NEW: Record<WhatsNewKey, readonly { icon: IconName; id: WhatsNewStepId }[]> = {
  "2.10": [
    { icon: "columns", id: "stage" },
    { icon: "volume", id: "sound" },
    { icon: "circleCheck", id: "done" },
  ],
};

const STEP_ID_BASE = "whats-new";

/**
 * «Novedades» (owner, 2026-11-15, D4): what changed, shown once after an update to a profile that already existed (a
 * new one gets the welcome instead), with the app's own live pieces rather than screenshots. Opened by `App` when
 * `ui.whatsNewSeen` is older than the latest key, or by hand from Settings ▸ About. Like the welcome, every control
 * writes its setting as it changes; finishing or closing it stamps the latest key, so it never opens on its own again.
 */
export function WhatsNewScreen() {
  const t = useT();
  const open = useUiStore((s) => s.whatsNewOpen);
  const steps = WHATS_NEW[LATEST_WHATS_NEW];
  const [step, setStep] = useState<WhatsNewStepId>(steps[0]!.id);

  function close() {
    void useSettingsStore.getState().update({ "ui.whatsNewSeen": LATEST_WHATS_NEW });
    useUiStore.getState().closeWhatsNew();
    setStep(steps[0]!.id);
  }

  return (
    <GuideScreen
      caption={t("whatsNew.caption", { version: LATEST_WHATS_NEW })}
      finishLabel={t("whatsNew.finish")}
      idBase={STEP_ID_BASE}
      onClose={close}
      onStep={setStep}
      open={open}
      skipLabel={t("whatsNew.skip")}
      step={step}
      steps={steps.map(({ icon, id }) => ({ icon, id, label: t(`whatsNew.steps.${id}`) }))}
      title={t("whatsNew.title")}
    >
      {step === "stage" ? <StageNewsStep /> : step === "sound" ? <SoundStep /> : <DoneStep go={setStep} />}
    </GuideScreen>
  );
}

/** What this version's steps left chosen, each with its way back, and the smaller changes in one list. */
function DoneStep({ go }: { go: (step: WhatsNewStepId) => void }) {
  const t = useT();
  const stageId = useSettingsStore((s) => s.settings["stage.displayId"]);
  const mirror = useSettingsStore((s) => s.settings["stage.mirror"]);
  const stage = useDisplayStore((s) => s.displays.find((d) => d.id === stageId));
  const sound = useSoundSummary();

  return (
    <StepLayout subtitle={t("whatsNew.done.subtitle")} title={t("whatsNew.done.title")}>
      <FieldGroup title={t("welcome.done.group")}>
        <FieldRow
          description={
            stage ? t(mirror ? "welcome.done.mirror" : "welcome.done.stage", { name: stage.label }) : t("whatsNew.done.noStage")
          }
          label={t("whatsNew.steps.stage")}
        >
          <Button
            aria-label={`${t("whatsNew.done.screens")}: ${t("whatsNew.steps.stage")}`}
            onClick={() => useUiStore.getState().openSettings("screens")}
            size="sm"
            variant="outline"
          >
            {t("whatsNew.done.screens")}
          </Button>
        </FieldRow>
        <FieldRow description={sound} label={t("whatsNew.steps.sound")}>
          <Button
            aria-label={`${t("welcome.done.change")}: ${t("whatsNew.steps.sound")}`}
            onClick={() => go("sound")}
            size="sm"
            variant="outline"
          >
            {t("welcome.done.change")}
          </Button>
        </FieldRow>
      </FieldGroup>
      <FieldGroup title={t("whatsNew.done.alsoTitle")}>
        {(["projector", "minimize", "screens", "startVolume"] as const).map((id) => (
          <p className="flex items-start gap-2.5 px-4 py-3 text-sm" key={id}>
            <Icon className="mt-0.5 text-muted-foreground" name="check" />
            <span>{t(`whatsNew.done.also.${id}`)}</span>
          </p>
        ))}
      </FieldGroup>
    </StepLayout>
  );
}
