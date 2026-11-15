import { useEffect, useState } from "react";
import { useI18n } from "@renderer/lib/i18n/i18n-provider";
import { Box, Button, Caption, Icon, IconTile, Segmented, Title, type IconName } from "@renderer/components/ui";
import { StageView } from "@renderer/components/shared/stage-view";
import { stageHour12, TEXT_SCALE } from "@renderer/lib/stage-output";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useUiStore } from "@renderer/stores/ui.store";
import type { StageOutput } from "@shared/types/projection";
import type { StageLayout, StageMessage } from "@shared/types/stage";
import { StepLayout } from "./StepLayout";
import { useSampleVerses } from "./use-sample-verses";

/** The demo's loop: the pastor's view while a 12-second count goes green, amber, red and past zero, then the
 *  musicians' while it keeps counting, each with a message from the panel's own ready phrases. */
const LOOP_MS = 24_000;
const PREACHER_MS = 14_000;
const COUNT_MS = 12_000;
// The colour steps of a 12-second count: the church's own thresholds (5:00 and 1:00 or more) never fit in it.
const WARN_MS = 8_000;
const ALERT_MS = 4_000;
/** When each message is on, and which of the language's ready phrases (`stage.defaultPhrases`) it says. */
const MESSAGES: readonly { from: number; to: number; phrase: number }[] = [
  { from: 2_000, to: 7_000, phrase: 4 },
  { from: 16_000, to: 22_000, phrase: 1 },
];
const TICK_MS = 250;

type DemoView = Extract<StageLayout, "preacher" | "musicians">;
const VIEWS: readonly DemoView[] = ["preacher", "musicians"];

const POINTS: readonly { icon: IconName; id: "countdown" | "message" | "views" }[] = [
  { icon: "timer", id: "countdown" },
  { icon: "message", id: "message" },
  { icon: "columns", id: "views" },
];

/**
 * «Novedades» 2.10: the stage screen, drawn by the stage's own `StageView` (what its window and the stage panel's
 * monitor draw) over a made-up service that plays by itself: John 3:16 live, the count changing colour, a message
 * band coming and going, and the two views taking turns until one is picked. Beside it, what the panel does, and
 * the way to Settings ▸ Screens, which opens over this screen and gives it back on close.
 */
export function StageNewsStep() {
  const { t } = useI18n();
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
                  <Title as="h3">{t(`whatsNew.stage.${id}.title`)}</Title>
                  <span className="text-sm text-muted-foreground">{t(`whatsNew.stage.${id}.body`)}</span>
                </span>
              </li>
            ))}
          </ul>
          <Button className="self-start" onClick={() => useUiStore.getState().openSettings("screens")} size="sm" variant="outline">
            <Icon name="columns" />
            {t("whatsNew.stage.configure")}
          </Button>
        </Box>
      }
      subtitle={t("whatsNew.stage.subtitle")}
      title={t("whatsNew.stage.title")}
    >
      <StageDemo />
    </StepLayout>
  );
}

function StageDemo() {
  const { t } = useI18n();
  const clockFormat = useSettingsStore((s) => s.settings["stage.clockFormat"]);
  const textSize = useSettingsStore((s) => s.settings["stage.textSize"]);
  const uiLocale = useSettingsStore((s) => s.settings["ui.locale"]);
  const [current, next] = useSampleVerses();
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  const [picked, setPicked] = useState<DemoView | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const loop = Math.floor((now - start) / LOOP_MS);
  const at = (now - start) % LOOP_MS;
  const layout = picked ?? (at < PREACHER_MS ? "preacher" : "musicians");
  const phrases = t("stage.defaultPhrases").split("\n");
  const shown = MESSAGES.findIndex(({ from, to }) => at >= from && at < to);
  const message: StageMessage | null =
    shown < 0 ? null : { text: phrases[MESSAGES[shown]!.phrase] ?? "", urgent: false, seq: loop * MESSAGES.length + shown };

  const stage: StageOutput = {
    current,
    next,
    videoStill: { posterUrl: null, videoUrl: null },
    videoMotion: false,
    countdown: {
      clock: { mode: "countdown", state: "running", endsAtMs: start + loop * LOOP_MS + COUNT_MS },
      warnMs: WARN_MS,
      alertMs: ALERT_MS,
    },
    message,
    layout,
    hour12: stageHour12(clockFormat, uiLocale),
    textScale: TEXT_SCALE[textSize],
  };

  return (
    <div className="flex flex-col gap-3">
      <Caption>{t("stagePanel.monitor")}</Caption>
      {/* The stage panel's monitor, at the stage's usual 16:9. Its inner count and message band are a picture here:
          hidden from assistive tech so a reader does not announce the demo's message every cycle. */}
      <div aria-label={t("stagePanel.monitor")} className="aspect-video w-full overflow-hidden rounded-md border border-border bg-clip-padding" role="img">
        <div aria-hidden="true" className="size-full">
          <StageView stage={stage} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented<DemoView>
          label={t("stagePanel.layout")}
          onChange={setPicked}
          options={VIEWS.map((value) => ({ label: t(`stagePanel.layouts.${value}`), value }))}
          value={layout}
        />
        <Caption className="min-w-0 flex-1 font-normal">{t(`stagePanel.layoutHints.${layout}`)}</Caption>
      </div>
    </div>
  );
}
