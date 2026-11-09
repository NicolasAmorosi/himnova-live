import { useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Modal, ModalTitle } from "@renderer/components/shared/modal";
import { BrandMark, Button, Caption, Icon, TabPanel, TabPanels, Tabs, Wordmark, type IconName } from "@renderer/components/ui";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useUiStore } from "@renderer/stores/ui.store";
import { BiblesStep } from "./BiblesStep";
import { ChurchStep } from "./ChurchStep";
import { DoneStep } from "./DoneStep";
import { EndingsStep } from "./EndingsStep";
import { FoldersStep } from "./FoldersStep";
import { HelloStep } from "./HelloStep";
import { ScreensStep } from "./ScreensStep";
import { StreamStep } from "./StreamStep";
import { TourStep } from "./TourStep";
import type { WelcomeStepId } from "./welcome-steps";

const STEP_ID_BASE = "welcome";

const STEPS: readonly { icon: IconName; id: WelcomeStepId }[] = [
  { icon: "home", id: "hello" },
  { icon: "image", id: "church" },
  { icon: "display", id: "screens" },
  { icon: "next", id: "endings" },
  { icon: "folder", id: "folders" },
  { icon: "bible", id: "bibles" },
  { icon: "broadcast", id: "stream" },
  { icon: "help", id: "tour" },
  { icon: "circleCheck", id: "done" },
];

/**
 * The first-run welcome (owner, 2026-11-09): full screen, the steps on a rail on the left — any of them
 * reachable at any time —, the step in the middle, «Back» and «Next: …» at the foot, and «Skip» always
 * there. Opened on its own only for a NEW profile (`welcome.pending`, set by main), and by hand from
 * Settings ▸ About.
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
  const [visited, setVisited] = useState<ReadonlySet<WelcomeStepId>>(() => new Set(["hello"]));
  // The tour's switch, applied when the guide closes: the checklist must not appear over the guide itself.
  const [firstSteps, setFirstSteps] = useState(true);

  const index = STEPS.findIndex((s) => s.id === step);
  const next = STEPS[index + 1];
  const previous = STEPS[index - 1];

  function go(target: WelcomeStepId) {
    setStep(target);
    setVisited((current) => new Set(current).add(target));
  }

  /** Finished or skipped: what was chosen is already saved. The checklist opens for a first launch either
   *  way (skipping is for the hurried, and a small list in a corner does not stop anybody), and when the
   *  guide was reopened by hand only if its switch says so. */
  function close(finished: boolean) {
    const firstLaunch = useSettingsStore.getState().settings["welcome.pending"];
    void update({
      "welcome.pending": false,
      ...(finished || firstLaunch ? { "welcome.firstStepsOpen": finished ? firstSteps : true } : {}),
    });
    closeWelcome();
    setStep("hello");
    setVisited(new Set(["hello"]));
  }

  return (
    <Modal onOpenChange={() => undefined} open={open} size="screen">
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-60 shrink-0 flex-col border-r border-border bg-background">
          <div className="flex items-center gap-3 px-4 pt-5 pb-4">
            <BrandMark className="size-9" />
            <Wordmark className="text-xl" />
            <ModalTitle className="sr-only">{t("welcome.title")}</ModalTitle>
          </div>
          <Tabs
            className="min-h-0 w-full flex-1 border-r-0"
            idBase={STEP_ID_BASE}
            onChange={go}
            tabs={STEPS.map(({ icon, id }) => ({
              // A step already seen reads as done: every step is optional, so seeing it is doing it.
              icon: visited.has(id) && id !== step ? "check" : icon,
              label: t(`welcome.steps.${id}`),
              value: id,
            }))}
            value={step}
            variant="sidebar"
          />
          <div className="shrink-0 border-t border-border p-2">
            <Button className="w-full justify-start" onClick={() => close(false)} size="sm" variant="ghost">
              <Icon name="close" />
              {t("welcome.skip")}
            </Button>
          </div>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col bg-card">
          <TabPanels>
            {STEPS.map(({ id }) => (
              <TabPanel active={id === step} idBase={STEP_ID_BASE} key={id} value={id}>
                {/* Only the step on screen is mounted: each one reads its settings when it appears. One
                    scrollbar, its room kept on both sides, like Settings'. */}
                {id === step ? (
                  <div className="min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
                    <StepBody firstSteps={firstSteps} go={go} id={id} onFirstStepsChange={setFirstSteps} />
                  </div>
                ) : null}
              </TabPanel>
            ))}
          </TabPanels>
          <footer className="flex h-strip shrink-0 items-center gap-2 border-t border-border px-3">
            <Caption className="flex-1">{t("welcome.stepOf", { current: index + 1, total: STEPS.length })}</Caption>
            {previous ? (
              <Button onClick={() => go(previous.id)} size="sm" variant="ghost">
                <Icon name="arrowLeft" />
                {t("welcome.back")}
              </Button>
            ) : null}
            {next ? (
              <Button onClick={() => go(next.id)} size="sm" variant="primary">
                {t("welcome.next", { step: t(`welcome.steps.${next.id}`) })}
                <Icon name="arrowRight" />
              </Button>
            ) : (
              <Button onClick={() => close(true)} size="sm" variant="primary">
                {t("welcome.finish")}
              </Button>
            )}
          </footer>
        </div>
      </div>
    </Modal>
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
