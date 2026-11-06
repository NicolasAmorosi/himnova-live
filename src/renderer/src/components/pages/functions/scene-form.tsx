import { useState } from "react";
import { useT, type Translate } from "@renderer/lib/i18n/i18n-provider";
import {
  ColorField,
  DependentFields,
  FieldRow,
  Input,
  InspectorSection,
  Select,
  Switch,
  type SelectOption,
} from "@renderer/components/ui";
import {
  BackgroundFields,
  FontFamilyFields,
  TextStyleFields,
  VerticalAlignField,
} from "@renderer/components/shared/style-fields";
import { transitionDurationOptions, transitionStyleOptions } from "@renderer/lib/transition";
import { SCENE_TEXT_MAX_LENGTH } from "@shared/scene-validators";
import { formatDuration, formatMinuteOfDay, parseDuration, parseMinuteOfDay } from "@shared/timer";
import type { SceneStyle, SceneTextStyle } from "@shared/types/scene-style";
import {
  isCountdownTool,
  TIMER_MAX_DURATION_MS,
  TIMER_MIN_DURATION_MS,
  TIMER_TOOLS,
  type TimerTool,
} from "@shared/types/timer";
import type { MediaAsset } from "@shared/types/media";
import type { TransitionStyle } from "@shared/types/transition";
import { TOOL_LABEL } from "./tool-display";
import type { SceneDraft } from "./scene-draft";

type SceneFormProps = {
  /** Its «when it ends» section took focus: the canvas shows the end. */
  onEndFocus?: () => void;
  /** The image assets a background can point at, plus the button that adds
   *  more — owned by the modal, which is where the loading state lives. */
  imageAssets: readonly MediaAsset[];
  onAddImages: () => void;
  addingImages: boolean;
  onChange: (next: SceneDraft) => void;
  value: SceneDraft;
};

/** What a countdown's colour triggers start from when switched on. */
const DEFAULT_TRIGGERS: NonNullable<SceneStyle["triggers"]> = { warningAtMs: 60_000, warningColor: "#ffa92d", endColor: "#dd1f1f" };

/**
 * Everything about one scene but its name (which is the editor's title), as the
 * sections of the editor's inspector: what the scene IS first (its tool, its
 * clock, its texts), then how it looks, then what happens at zero (owner,
 * 2026-11-05: the look right after the content it dresses).
 *
 * The rows that edit the parts of `SceneStyle` the Bible verse style ALSO has
 * — the background, the typeface, the vertical alignment, a text role's four
 * knobs — now come from `components/shared/style-fields.tsx`. What is left
 * here is what is genuinely a time scene's: its tool, its clock, and its end
 * state.
 *
 * Fully controlled: the modal owns the draft, so it is the modal that knows
 * whether there is anything unsaved. The two free-text numeric fields
 * (duration, time of day) keep a local draft of their own anyway, because a
 * half-typed `"1"` on the way to `"10:00"` must not be committed as one
 * minute and must not fight the operator's cursor.
 */
export function SceneForm({ addingImages, imageAssets, onAddImages, onChange, onEndFocus, value }: SceneFormProps) {
  const t = useT();

  const patch = (next: Partial<SceneDraft>) => onChange({ ...value, ...next });
  const patchStyle = (next: Partial<SceneStyle>) => patch({ style: { ...value.style, ...next } });
  const patchConfig = (next: Partial<SceneDraft["config"]>) => patch({ config: { ...value.config, ...next } });
  const patchFormat = (next: Partial<SceneDraft["config"]["format"]>) =>
    patchConfig({ format: { ...value.config.format, ...next } });
  const triggers = value.style.triggers ?? DEFAULT_TRIGGERS;

  const toolOptions: SelectOption[] = TIMER_TOOLS.map((tool) => ({
    label: t(TOOL_LABEL[tool]),
    value: tool,
  }));

  return (
    <>
      <InspectorSection title={t("scenes.groups.scene")}>
        <FieldRow description={t("scenes.toolHint")} label={t("scenes.tool")}>
          <Select
            onChange={(next) => patch({ tool: next as TimerTool })}
            options={toolOptions}
            value={value.tool}
          />
        </FieldRow>
      </InspectorSection>

      <InspectorSection title={t("scenes.groups.time")}>
        {value.tool === "countdown" ? (
          <FieldRow description={t("scenes.durationHint")} label={t("scenes.duration")}>
            <NumericTextField
              format={formatDuration}
              onCommit={(durationMs) => patchConfig({ durationMs })}
              parse={(text) => {
                const ms = parseDuration(text);
                return ms !== null && ms >= TIMER_MIN_DURATION_MS && ms <= TIMER_MAX_DURATION_MS ? ms : null;
              }}
              value={value.config.durationMs}
            />
          </FieldRow>
        ) : null}

        {value.tool === "countdown-to-time" ? (
          <FieldRow description={t("scenes.targetTimeHint")} label={t("scenes.targetTime")}>
            <NumericTextField
              format={formatMinuteOfDay}
              onCommit={(targetMinuteOfDay) => patchConfig({ targetMinuteOfDay })}
              parse={parseMinuteOfDay}
              value={value.config.targetMinuteOfDay}
            />
          </FieldRow>
        ) : null}

        {value.tool === "clock" || value.tool === "stopwatch" ? (
          <FieldRow label={t("scenes.hour12")}>
            <Switch
              checked={value.config.format.hour12}
              onChange={(e) => patchFormat({ hour12: e.target.checked })}
            />
          </FieldRow>
        ) : null}

        {value.tool === "clock" ? (
          <FieldRow label={t("scenes.showSeconds")}>
            <Switch
              checked={value.config.format.showSeconds}
              onChange={(e) => patchFormat({ showSeconds: e.target.checked })}
            />
          </FieldRow>
        ) : null}

        <FieldRow description={t("scenes.hideZeroHoursHint")} label={t("scenes.hideZeroHours")}>
          <Switch
            checked={value.config.format.hideZeroHours}
            onChange={(e) => patchFormat({ hideZeroHours: e.target.checked })}
          />
        </FieldRow>

        {isCountdownTool(value.tool) ? (
          <FieldRow description={t("scenes.overrunHint")} label={t("scenes.overrun")}>
            <Switch
              checked={value.config.format.overrun}
              onChange={(e) => patchFormat({ overrun: e.target.checked })}
            />
          </FieldRow>
        ) : null}
      </InspectorSection>

      <InspectorSection title={t("scenes.groups.texts")}>
        <FieldRow description={t("scenes.titleHint")} label={t("scenes.titleText")}>
          <Input
            maxLength={SCENE_TEXT_MAX_LENGTH}
            onChange={(e) => patch({ title: e.target.value === "" ? null : e.target.value })}
            value={value.title ?? ""}
          />
        </FieldRow>
        <FieldRow description={t("scenes.messageHint")} label={t("scenes.messageText")}>
          <Input
            maxLength={SCENE_TEXT_MAX_LENGTH}
            onChange={(e) => patch({ message: e.target.value === "" ? null : e.target.value })}
            value={value.message ?? ""}
          />
        </FieldRow>
      </InspectorSection>

      <InspectorSection title={t("style.groups.background")}>
        <BackgroundFields
          addingImages={addingImages}
          imageAssets={imageAssets}
          onAddImages={onAddImages}
          onChange={(background) => patchStyle({ background })}
          value={value.style.background}
        />
      </InspectorSection>

      <InspectorSection title={t("style.groups.typography")}>
        <FontFamilyFields
          onChange={(fontFamily) => patchStyle({ fontFamily })}
          value={value.style.fontFamily}
        />
        <VerticalAlignField
          onChange={(verticalAlign) => patchStyle({ verticalAlign })}
          value={value.style.verticalAlign}
        />
      </InspectorSection>

      <TextStyleGroup
        onChange={(next) => patchStyle({ value: next })}
        t={t}
        title={t("scenes.groups.number")}
        value={value.style.value}
      />
      <TextStyleGroup
        onChange={(next) => patchStyle({ title: next })}
        t={t}
        title={t("scenes.groups.titleLine")}
        value={value.style.title}
      />
      <TextStyleGroup
        onChange={(next) => patchStyle({ message: next })}
        t={t}
        title={t("scenes.groups.messageLine")}
        value={value.style.message}
      />

      {/* Everything that happens when the count runs out, in one group: the
          text that replaces the line below, how that text is drawn, and what
          disappears. Only a countdown has an end, so a clock and a stopwatch
          never see it. */}
      {isCountdownTool(value.tool) ? (
        <InspectorSection onFocus={onEndFocus} title={t("scenes.groups.end")}>
          <FieldRow description={t("scenes.endMessageHint")} label={t("scenes.endMessage")}>
            <Input
              maxLength={SCENE_TEXT_MAX_LENGTH}
              onChange={(e) => patchConfig({ endMessage: e.target.value === "" ? null : e.target.value })}
              value={value.config.endMessage ?? ""}
            />
          </FieldRow>
          <TextStyleFields
            onChange={(message) => patchStyle({ end: { ...value.style.end, message } })}
            t={t}
            value={value.style.end.message}
          />
          <FieldRow description={t("scenes.hideValueHint")} label={t("scenes.hideValue")}>
            <Switch
              checked={value.style.end.hideValue}
              onChange={(e) => patchStyle({ end: { ...value.style.end, hideValue: e.target.checked } })}
            />
          </FieldRow>
          <FieldRow description={t("scenes.hideTitleHint")} label={t("scenes.hideTitle")}>
            <Switch
              checked={value.style.end.hideTitle}
              onChange={(e) => patchStyle({ end: { ...value.style.end, hideTitle: e.target.checked } })}
            />
          </FieldRow>
          {/* Last in the group on purpose: it is not one more thing that
              changes at zero, it is HOW everything above it changes. */}
          <FieldRow description={t("scenes.endTransitionHint")} label={t("scenes.endTransition")}>
            <Select
              onChange={(style) =>
                patchStyle({
                  end: {
                    ...value.style.end,
                    transition: { ...value.style.end.transition, style: style as TransitionStyle },
                  },
                })
              }
              options={transitionStyleOptions(t)}
              value={value.style.end.transition.style}
            />
          </FieldRow>
          <FieldRow description={t("scenes.endTransitionDurationHint")} label={t("scenes.endTransitionDuration")}>
            <Select
              disabled={value.style.end.transition.style === "none"}
              onChange={(durationMs) =>
                patchStyle({
                  end: {
                    ...value.style.end,
                    transition: { ...value.style.end.transition, durationMs: Number(durationMs) },
                  },
                })
              }
              options={transitionDurationOptions(t, value.style.end.transition.durationMs)}
              value={String(value.style.end.transition.durationMs)}
            />
          </FieldRow>
        </InspectorSection>
      ) : null}

      {isCountdownTool(value.tool) ? (
        <InspectorSection defaultOpen={false} title={t("scenes.groups.triggers")}>
          <FieldRow description={t("scenes.triggersHint")} label={t("scenes.triggersEnabled")}>
            <Switch
              checked={value.style.triggers !== null}
              onChange={(e) =>
                patchStyle({
                  triggers: e.target.checked ? DEFAULT_TRIGGERS : null,
                })
              }
            />
          </FieldRow>
          {/* Off, the rows show what turning it on would start from. */}
          <DependentFields enabled={value.style.triggers !== null}>
            <FieldRow description={t("scenes.warningAtHint")} label={t("scenes.warningAt")}>
              <NumericTextField
                format={formatDuration}
                onCommit={(warningAtMs) => patchStyle({ triggers: { ...triggers, warningAtMs } })}
                parse={(text) => {
                  const ms = parseDuration(text);
                  return ms !== null && ms >= 0 && ms <= 3_600_000 ? ms : null;
                }}
                value={triggers.warningAtMs}
              />
            </FieldRow>
            <FieldRow label={t("scenes.warningColor")}>
              <ColorField
                label={t("scenes.warningColor")}
                onChange={(warningColor) => patchStyle({ triggers: { ...triggers, warningColor } })}
                value={triggers.warningColor}
              />
            </FieldRow>
            <FieldRow label={t("scenes.endColor")}>
              <ColorField
                label={t("scenes.endColor")}
                onChange={(endColor) => patchStyle({ triggers: { ...triggers, endColor } })}
                value={triggers.endColor}
              />
            </FieldRow>
          </DependentFields>
        </InspectorSection>
      ) : null}

    </>
  );
}

/** A whole section that is nothing but one text role's four knobs — the number,
 *  the title and the message, so they can never drift apart. */
function TextStyleGroup({
  onChange,
  t,
  title,
  value,
}: {
  onChange: (next: SceneTextStyle) => void;
  t: Translate;
  title: string;
  value: SceneTextStyle;
}) {
  return (
    <InspectorSection title={title}>
      <TextStyleFields onChange={onChange} t={t} value={value} />
    </InspectorSection>
  );
}

/**
 * A number the operator types as text (a duration, a time of day).
 *
 * The local draft is what makes it usable: committing on every keystroke would
 * turn `"10:00"` into one minute the instant `"1"` was typed, and then
 * re-format the field under the cursor. So the draft is free text while it has
 * focus, only a value that parses is committed, and blurring snaps back to the
 * canonical formatting of whatever was last committed.
 */
function NumericTextField({
  format,
  onCommit,
  parse,
  value,
}: {
  format: (value: number) => string;
  onCommit: (value: number) => void;
  parse: (text: string) => number | null;
  value: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? format(value);
  const invalid = draft !== null && parse(draft) === null;

  return (
    <Input
      aria-invalid={invalid || undefined}
      className="w-24 tabular-nums"
      onBlur={() => setDraft(null)}
      onChange={(e) => {
        setDraft(e.target.value);
        const parsed = parse(e.target.value);
        if (parsed !== null) onCommit(parsed);
      }}
      value={text}
    />
  );
}
