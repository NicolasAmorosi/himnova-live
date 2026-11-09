import type { ReactNode } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import {
  BrandMark,
  Caption,
  ChoiceGroup,
  Icon,
  StageSketch,
  Title,
  type IconName,
  type SketchContent,
  type SketchScene,
} from "@renderer/components/ui";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { logoLook, type SettingsMap } from "@shared/types/settings";
import { AUDIO_END_ACTIONS, VIDEO_END_ACTIONS, type AudioEndAction, type VideoEndAction } from "@shared/types/projection";
import { StepLayout } from "./StepLayout";

type EndKey = "projection.videoEnd" | "projection.deckEnd" | "projection.songEnd";

/** How each choice is drawn: what stays on the stage after the end, and the sign that names it. */
const VIDEO_SKETCH: Record<VideoEndAction, { after: "content" | "black" | "logo"; badge?: IconName }> = {
  logo: { after: "logo" },
  black: { after: "black" },
  loop: { after: "content", badge: "loop" },
  hold: { after: "content", badge: "pause" },
  next: { after: "content", badge: "next" },
};
const AUDIO_SKETCH: Record<AudioEndAction, { after: "content" | "black"; badge: IconName }> = {
  stop: { after: "black", badge: "stop" },
  loop: { after: "content", badge: "loop" },
  next: { after: "content", badge: "next" },
};

const ROWS: readonly { content: Exclude<SketchContent, "audio">; icon: IconName; key: EndKey; options: "videoEndOptions" | "deckEndOptions"; row: "video" | "deck" | "song" }[] = [
  { content: "video", icon: "video", key: "projection.videoEnd", options: "videoEndOptions", row: "video" },
  { content: "ppt", icon: "ppt", key: "projection.deckEnd", options: "deckEndOptions", row: "deck" },
  // A song's choices read like a deck's in Settings («the first slide», «the last slide»).
  { content: "song", icon: "song", key: "projection.songEnd", options: "deckEndOptions", row: "song" },
];

/** «Al terminar» — the four choices of Settings ▸ Projection as pictures: each card plays what was on the
 *  projector and then what comes after it, only the chosen one moving. */
export function EndingsStep() {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const logo = <LogoMark settings={settings} />;

  return (
    <StepLayout subtitle={t("welcome.endings.subtitle")} title={t("welcome.endings.title")}>
      {ROWS.map(({ content, icon, key, options, row }) => (
        <EndRow
          caption={t(`settings.${options}.${settings[key]}`)}
          hint={t(`welcome.endings.${row}Hint`)}
          icon={icon}
          key={key}
          title={t(`welcome.endings.${row}`)}
        >
          <ChoiceGroup<VideoEndAction>
            className="max-w-2xl"
            columns={VIDEO_END_ACTIONS.length}
            label={t(`welcome.endings.${row}`)}
            onChange={(value) => void update({ [key]: value })}
            options={VIDEO_END_ACTIONS.map((value) => ({
              label: t(`welcome.endings.short.${value}`),
              value,
              visual: (
                <StageSketch
                  after={scene(VIDEO_SKETCH[value].after, content)}
                  animate={settings[key] === value}
                  badge={VIDEO_SKETCH[value].badge}
                  content={content}
                  logo={logo}
                />
              ),
            }))}
            value={settings[key]}
          />
        </EndRow>
      ))}
      <EndRow
        caption={t(`settings.audioEndOptions.${settings["projection.audioEnd"]}`)}
        hint={t("welcome.endings.audioHint")}
        icon="audio"
        title={t("welcome.endings.audio")}
      >
        <ChoiceGroup<AudioEndAction>
          // As wide as three of the five cards above, so the cards keep one size.
          className="max-w-[calc(42rem*3/5)]"
          columns={AUDIO_END_ACTIONS.length}
          label={t("welcome.endings.audio")}
          onChange={(value) => void update({ "projection.audioEnd": value })}
          options={AUDIO_END_ACTIONS.map((value) => ({
            label: t(`welcome.endings.short.${value}`),
            value,
            visual: (
              <StageSketch
                after={scene(AUDIO_SKETCH[value].after, "audio")}
                animate={settings["projection.audioEnd"] === value}
                badge={AUDIO_SKETCH[value].badge}
                content="audio"
              />
            ),
          }))}
          value={settings["projection.audioEnd"]}
        />
      </EndRow>
    </StepLayout>
  );
}

function scene(after: "content" | "black" | "logo", content: SketchContent): SketchScene {
  return after === "content" ? { kind: "content", content } : { kind: after };
}

function EndRow({
  caption,
  children,
  hint,
  icon,
  title,
}: {
  caption: string;
  children: ReactNode;
  hint: string;
  icon: IconName;
  title: string;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <Icon className="self-center text-muted-foreground" name={icon} />
        <Title as="h3">{title}</Title>
        <Caption className="truncate">{hint}</Caption>
      </div>
      {children}
      {/* The chosen card in Settings' own words: the short label on a card is a name, this is the sentence. */}
      <p className="text-xs text-muted-foreground">
        <Icon className="mr-1 inline size-3.5 align-[-0.125rem] text-accent-ink" name="check" />
        {caption}
      </p>
    </section>
  );
}

/** What LOGO shows, in small: the church's image, else its name, else the app's flame. */
function LogoMark({ settings }: { settings: SettingsMap }) {
  const look = logoLook(settings);
  if (look.url) return <img alt="" className="max-h-[60%] max-w-[70%] object-contain" src={look.url} />;
  if (look.scene.name) return <span className="line-clamp-2">{look.scene.name}</span>;
  return <BrandMark className="size-5" />;
}
