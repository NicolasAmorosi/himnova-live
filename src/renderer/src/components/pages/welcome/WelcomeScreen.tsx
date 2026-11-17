import { useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import type { IconName } from "@renderer/components/ui";
import { LATEST_WHATS_NEW } from "@shared/whats-new";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useUiStore } from "@renderer/stores/ui.store";
import { BiblesStep } from "./BiblesStep";
import { ChurchStep } from "./ChurchStep";
import { DoneStep } from "./DoneStep";
import { EndingsStep } from "./EndingsStep";
import { FoldersStep } from "./FoldersStep";
import { GuideScreen } from "./GuideScreen";
import { HelloStep } from "./HelloStep";
import { ScreensStep } from "./ScreensStep";
import { SoundStep } from "./SoundStep";
import { StreamStep } from "./StreamStep";
import { TourStep } from "./TourStep";
import type { WelcomeStepId } from "./welcome-steps";

const STEP_ID_BASE = "welcome";

const STEPS: readonly { icon: IconName; id: WelcomeStepId }[] = [
  { icon: "home", id: "hello" },
  { icon: "image", id: "church" },
  { icon: "display", id: "screens" },
  { icon: "next", id: "endings" },
  { icon: "volume", id: "sound" },
  { icon: "folder", id: "folders" },
  { icon: "bible", id: "bibles" },
  { icon: "broadcast", id: "stream" },
  { icon: "help", id: "tour" },
  { icon: "circleCheck", id: "done" },
];

/**
 * The first-run welcome (owner, 2026-11-09), in the guide shell «Novedades» shares (`GuideScreen`). Opened on its
 * own only for a NEW profile (`welcome.pending`, set by main), and by hand from Settings ▸ About.
 *
 * Every control writes the same settings key Settings does, as it changes — most of them ARE Settings'
 * own groups (`components/shared/settings-groups/`) — so there is no draft to lose: skipping keeps what
 * was chosen so far, and Escape does nothing (a stray key must not throw the guide away).
 */
export function WelcomeScreen() {
  const t = useT();
  const open = useUiStore((s) => s.welcomeOpen);
  const closeWelcome = useUiStore((s) => s.closeWelcome);
  const update = useSettingsStore((s) => s.update);
  const [step, setStep] = useState<WelcomeStepId>("hello");
  // The tour's switch, applied when the guide closes: the checklist must not appear over the guide itself.
  const [firstSteps, setFirstSteps] = useState(true);

  /** Finished or skipped: what was chosen is already saved. The checklist opens for a first launch either
   *  way (skipping is for the hurried, and a small list in a corner does not stop anybody), and when the
   *  guide was reopened by hand only if its switch says so. Whoever went through the welcome has nothing
   *  «new» to be told (D4): a profile from an older build whose welcome was still pending included. */
  function close(finished: boolean) {
    const firstLaunch = useSettingsStore.getState().settings["welcome.pending"];
    const openList = finished ? firstSteps : firstLaunch;
    void update({
      "welcome.pending": false,
      "ui.whatsNewSeen": LATEST_WHATS_NEW,
      ...(finished || firstLaunch ? { "welcome.firstStepsOpen": openList } : {}),
      // A checklist opened again starts with nothing ticked: finished a second time, it kept the old ticks
      // (2026-11-15 audit, U9).
      ...(openList ? { "welcome.firstStepsDone": [] } : {}),
    });
    closeWelcome();
    setStep("hello");
  }

  return (
    <GuideScreen
      finishLabel={t("welcome.finish")}
      idBase={STEP_ID_BASE}
      onClose={close}
      onStep={setStep}
      open={open}
      skipLabel={t("welcome.skip")}
      step={step}
      steps={STEPS.map(({ icon, id }) => ({ icon, id, label: t(`welcome.steps.${id}`) }))}
      title={t("welcome.title")}
    >
      <StepBody firstSteps={firstSteps} go={setStep} id={step} onFirstStepsChange={setFirstSteps} />
    </GuideScreen>
  );
}

function StepBody({
  firstSteps,
  go,
  id,
  onFirstStepsChange,
}: {
  firstSteps: boolean;
  go: (step: WelcomeStepId) => void;
  id: WelcomeStepId;
  onFirstStepsChange: (on: boolean) => void;
}) {
  switch (id) {
    case "hello":
      return <HelloStep />;
    case "church":
      return <ChurchStep />;
    case "screens":
      return <ScreensStep />;
    case "endings":
      return <EndingsStep />;
    case "sound":
      return <SoundStep />;
    case "folders":
      return <FoldersStep />;
    case "bibles":
      return <BiblesStep />;
    case "stream":
      return <StreamStep />;
    case "tour":
      return <TourStep firstSteps={firstSteps} onFirstStepsChange={onFirstStepsChange} />;
    case "done":
      return <DoneStep go={go} />;
  }
}
