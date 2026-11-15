import type { ReactNode } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Modal, ModalTitle } from "@renderer/components/shared/modal";
import { Button, Caption, Icon, TabPanel, TabPanels, Tabs, Wordmark, type IconName } from "@renderer/components/ui";

export type GuideStep<Id extends string> = { icon: IconName; id: Id; label: string };

/**
 * The full-screen guide the welcome and «Novedades» share: the steps on a rail on the left (any of them reachable at
 * any time), the step in the middle, «Back» and «Next: …» at the foot, and the rail's way out on every step but the
 * last, where finishing is the way out. Escape does nothing: a stray key must not throw the guide away. Only the step
 * on screen is mounted (`children`), so each one reads its settings when it appears.
 */
export function GuideScreen<Id extends string>({
  caption,
  children,
  finishLabel,
  idBase,
  onClose,
  onStep,
  open,
  skipLabel,
  step,
  steps,
  title,
}: {
  /** Under the wordmark, on the rail. */
  caption?: string;
  children: ReactNode;
  finishLabel: string;
  idBase: string;
  /** `true` from the last step's button, `false` from the rail's way out. */
  onClose: (finished: boolean) => void;
  onStep: (step: Id) => void;
  open: boolean;
  skipLabel: string;
  step: Id;
  steps: readonly GuideStep<Id>[];
  title: string;
}) {
  const t = useT();
  const index = steps.findIndex((s) => s.id === step);
  const next = steps[index + 1];
  const previous = steps[index - 1];

  return (
    <Modal onOpenChange={() => undefined} open={open} size="screen">
      <div className="flex min-h-0 flex-1">
        <nav aria-label={title} className="flex w-60 shrink-0 flex-col border-r border-border bg-background">
          <div className="flex flex-col gap-1 px-4 pt-5 pb-4">
            <Wordmark className="text-2xl" />
            <ModalTitle className="sr-only">{title}</ModalTitle>
            {caption ? <Caption>{caption}</Caption> : null}
          </div>
          <Tabs
            className="min-h-0 w-full flex-1 border-r-0"
            idBase={idBase}
            onChange={onStep}
            tabs={steps.map(({ icon, id, label }) => ({ icon, label, value: id }))}
            value={step}
            variant="sidebar"
          />
          <div className="flex h-strip shrink-0 items-center border-t border-border px-2">
            {next ? (
              <Button className="w-full justify-start" onClick={() => onClose(false)} size="sm" variant="ghost">
                <Icon name="close" />
                {skipLabel}
              </Button>
            ) : null}
          </div>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col bg-card">
          <TabPanels>
            {steps.map(({ id }) => (
              <TabPanel active={id === step} idBase={idBase} key={id} value={id}>
                {/* One scrollbar, its room kept on both sides, like Settings'. */}
                {id === step ? (
                  <div className="min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">{children}</div>
                ) : null}
              </TabPanel>
            ))}
          </TabPanels>
          <footer className="flex h-strip shrink-0 items-center gap-2 border-t border-border px-3">
            <Caption className="flex-1">{t("welcome.stepOf", { current: index + 1, total: steps.length })}</Caption>
            {/* The new step said out loud: «Next» keeps the focus where it was. */}
            <span aria-live="polite" className="sr-only">
              {steps[index]?.label}
            </span>
            {previous ? (
              <Button onClick={() => onStep(previous.id)} size="sm" variant="ghost">
                <Icon name="arrowLeft" />
                {t("welcome.back")}
              </Button>
            ) : null}
            {next ? (
              <Button onClick={() => onStep(next.id)} size="sm" variant="primary">
                {t("welcome.next", { step: next.label })}
                <Icon name="arrowRight" />
              </Button>
            ) : (
              <Button onClick={() => onClose(true)} size="sm" variant="primary">
                {finishLabel}
              </Button>
            )}
          </footer>
        </div>
      </div>
    </Modal>
  );
}
