import { useEffect, useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Box, Caption, Icon, IconTile, Kbd, Monitor, Title, type IconName } from "@renderer/components/ui";
import { OutputView } from "@renderer/components/shared/output-view";
import { useLogoPreview } from "@renderer/components/shared/settings-groups/use-logo-preview";
import type { ProjectionOutput } from "@shared/types/projection";
import { StepLayout } from "./StepLayout";
import { useSampleVerses } from "./use-sample-verses";

/** How long each beat of the demo lasts: pick, send, pick the next, send it. */
const BEAT_MS = 2_500;
const BEATS = ["pick", "send", "pickNext", "sendNext"] as const;

const POINTS: readonly { icon: IconName; id: "free" | "enter" | "back" }[] = [
  { icon: "play", id: "free" },
  { icon: "keyboard", id: "enter" },
  { icon: "restart", id: "back" },
];

/**
 * «Novedades» 2.11: what goes live leaves PREVIEW (owner, 2026-11-15, audit A3). The two monitors of the work screen,
 * drawn by the same `Monitor` and `OutputView`, play a made-up service by themselves: John 3:16 picked into PREVIEW,
 * sent (PREVIEW empties, LIVE takes it with its red edge), the next verse picked, sent. Beside it, what changed.
 */
export function PreviewNewsStep() {
  const t = useT();
  return (
    <StepLayout
      asideFromNarrow
      aside={
        <Box className="flex flex-col gap-4 p-4">
          <ul className="flex flex-col gap-4">
            {POINTS.map(({ icon, id }) => (
              <li className="flex items-start gap-3" key={id}>
                <IconTile>
                  <Icon name={icon} />
                </IconTile>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <Title as="h3">{t(`whatsNew.preview.${id}.title`)}</Title>
                  <span className="text-sm text-muted-foreground">{t(`whatsNew.preview.${id}.body`)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Box>
      }
      subtitle={t("whatsNew.preview.subtitle")}
      title={t("whatsNew.preview.title")}
    >
      <PreviewDemo />
    </StepLayout>
  );
}

function PreviewDemo() {
  const t = useT();
  const logo = useLogoPreview();
  const [first, second] = useSampleVerses();
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setBeat((n) => (n + 1) % BEATS.length), BEAT_MS);
    return () => clearInterval(timer);
  }, []);

  const step = BEATS[beat]!;
  const preview: ProjectionOutput | null = step === "pick" ? first : step === "pickNext" ? second : null;
  const live: ProjectionOutput = step === "pick" ? logo : step === "sendNext" ? second : first;
  const sent = step === "send" || step === "sendNext";

  return (
    // A picture for assistive tech: the beats would be announced every 2.5 s. The points beside say the same.
    <div aria-label={t("whatsNew.preview.demo")} className="flex flex-col gap-3" role="img">
      <div aria-hidden="true" className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex min-w-0 flex-col gap-2">
            <Caption>{t("slides.title")}</Caption>
            <Monitor className="p-0" empty={t("preview.placeholder")}>
              {preview ? <OutputView mode="preview" output={preview} /> : undefined}
            </Monitor>
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <Caption>{t("live.title")}</Caption>
            <Monitor className="p-0" onAir={step !== "pick"}>
              <OutputView mode="preview" output={live} />
            </Monitor>
          </div>
        </div>
        <p className="flex min-h-6 items-center gap-2 text-sm text-muted-foreground">
          {sent ? <Kbd className="ml-0">{t("keys.enter")}</Kbd> : null}
          <span>{t(`whatsNew.preview.beats.${step}`)}</span>
        </p>
      </div>
    </div>
  );
}
