import { useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Button, FieldGroup, FieldRow, Icon, type IconName } from "@renderer/components/ui";
import { useDisplayStore } from "@renderer/stores/display.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useUiStore } from "@renderer/stores/ui.store";
import type { Messages } from "@renderer/lib/i18n/messages/es";
import { LATEST_WHATS_NEW, whatsNewKeysFor, type WhatsNewKey } from "@shared/whats-new";
import { GuideScreen } from "./GuideScreen";
import { PreviewNewsStep } from "./PreviewNewsStep";
import { SoundStep } from "./SoundStep";
import { StageNewsStep } from "./StageNewsStep";
import { StepLayout } from "./StepLayout";
import { useSoundSummary } from "./use-sound-summary";

type WhatsNewStepId = "stage" | "sound" | "preview" | "done";

/** Each version's «Novedades»: its steps, and the smaller changes its summary lists. A new version adds its key in
 *  `shared/whats-new.ts` and its entry here (a key without one does not compile). Every screen ends on one summary. */
const WHATS_NEW: Record<
  WhatsNewKey,
  {
    steps: readonly { icon: IconName; id: Exclude<WhatsNewStepId, "done"> }[];
    also: readonly (keyof Messages["whatsNew"]["done"]["also"])[];
  }
> = {
  "2.10": {
    steps: [
      { icon: "columns", id: "stage" },
      { icon: "volume", id: "sound" },
    ],
    also: ["projector", "minimize", "screens", "startVolume"],
  },
  "2.11": {
    steps: [{ icon: "play", id: "preview" }],
    also: [
      "stageFreeze",
      "extraEnter",
      "coverSounds",
      "projectorBack",
      "controlBack",
      "damagedDb",
      "fader",
      "quitSound",
      "scannedPdf",
    ],
  },
};
const DONE_STEP = { icon: "circleCheck", id: "done" } as const;

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
  // Read as it opens: closing it stamps the latest, and the steps must not change under the operator meanwhile.
  const [keys] = useState(() => whatsNewKeysFor(useSettingsStore.getState().settings["ui.whatsNewSeen"]));
  const steps = [...keys.flatMap((key) => WHATS_NEW[key].steps), DONE_STEP];
  const [step, setStep] = useState<WhatsNewStepId>(steps[0]!.id);

  function close() {
    void useSettingsStore.getState().update({ "ui.whatsNewSeen": LATEST_WHATS_NEW });
    useUiStore.getState().closeWhatsNew();
    setStep(steps[0]!.id);
  }

  return (
    <GuideScreen
      caption={
        keys.length > 1 ? t("whatsNew.captionSince", { version: keys[0]! }) : t("whatsNew.caption", { version: keys[0]! })
      }
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
      {step === "stage" ? (
        <StageNewsStep />
      ) : step === "sound" ? (
        <SoundStep />
      ) : step === "preview" ? (
        <PreviewNewsStep />
      ) : (
        <DoneStep go={setStep} keys={keys} />
      )}
    </GuideScreen>
  );
}

/** What the steps left chosen (2.10's screens and sound, when it is among them), each with its way back, and the
 *  smaller changes of every version shown, in one list. */
function DoneStep({ go, keys }: { go: (step: WhatsNewStepId) => void; keys: readonly WhatsNewKey[] }) {
  const t = useT();
  const stageId = useSettingsStore((s) => s.settings["stage.displayId"]);
  const mirror = useSettingsStore((s) => s.settings["stage.mirror"]);
  const stage = useDisplayStore((s) => s.displays.find((d) => d.id === stageId));
  const sound = useSoundSummary();

  return (
    <StepLayout
      // Only 2.10's steps choose something (the stage screen, the strips).
      subtitle={t(keys.includes("2.10") ? "whatsNew.done.subtitle" : "whatsNew.done.subtitleNoChoices")}
      title={t("whatsNew.done.title")}
    >
      {keys.includes("2.10") ? (
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
      ) : null}
      <FieldGroup title={t("whatsNew.done.alsoTitle")}>
        {keys.flatMap((key) => WHATS_NEW[key].also).map((id) => (
          <p className="flex items-start gap-2.5 px-4 py-3 text-sm" key={id}>
            <Icon className="mt-0.5 text-muted-foreground" name="check" />
            <span>{t(`whatsNew.done.also.${id}`)}</span>
          </p>
        ))}
      </FieldGroup>
    </StepLayout>
  );
}
