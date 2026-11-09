import { useT } from "@renderer/lib/i18n/i18n-provider";
import { ChoiceGroup, Icon, IconTile, Title, type IconName } from "@renderer/components/ui";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { LOCALES, THEMES, type Locale, type Theme } from "@shared/types/settings";
import { StepLayout } from "./StepLayout";

const THEME_ICONS: Record<Theme, IconName> = { dark: "moon", light: "sun" };
const POINTS = [
  { icon: "check", key: "offline" },
  { icon: "save", key: "autosave" },
  { icon: "settings", key: "reopen" },
] as const satisfies readonly { icon: IconName; key: string }[];

/** Language and theme first: everything after reads in the one chosen, and both apply on the spot. */
export function HelloStep() {
  const t = useT();
  const locale = useSettingsStore((s) => s.settings["ui.locale"]);
  const theme = useSettingsStore((s) => s.settings["ui.theme"]);
  const update = useSettingsStore((s) => s.update);

  return (
    <StepLayout
      aside={
        <div className="flex flex-col gap-3">
          <Title as="h3">{t("welcome.hello.points.title")}</Title>
          <ul className="flex flex-col gap-3">
            {POINTS.map(({ icon, key }) => (
              <li className="flex items-start gap-2.5 text-sm text-muted-foreground" key={key}>
                <Icon className="mt-0.5 text-accent-ink" name={icon} />
                <span>{t(`welcome.hello.points.${key}`)}</span>
              </li>
            ))}
          </ul>
        </div>
      }
      subtitle={t("welcome.hello.subtitle")}
      title={t("welcome.hello.title")}
    >
      <section className="flex flex-col gap-2">
        <Title as="h3">{t("welcome.hello.language")}</Title>
        <ChoiceGroup<Locale>
          columns={4}
          label={t("welcome.hello.language")}
          onChange={(value) => void update({ "ui.locale": value })}
          // Each language in its own name, as Settings lists them: whoever cannot read the current one
          // still finds theirs.
          options={LOCALES.map((value) => ({ label: t(`settings.locales.${value}`), value }))}
          value={locale}
        />
      </section>
      <section className="flex flex-col gap-2">
        <Title as="h3">{t("welcome.hello.theme")}</Title>
        <ChoiceGroup<Theme>
          className="max-w-md"
          columns={2}
          label={t("welcome.hello.theme")}
          onChange={(value) => void update({ "ui.theme": value })}
          options={THEMES.map((value) => ({
            description: t(`welcome.hello.themeDescs.${value}`),
            label: t(`welcome.hello.themes.${value}`),
            value,
            visual: (
              <IconTile size="picture">
                <Icon name={THEME_ICONS[value]} />
              </IconTile>
            ),
          }))}
          value={theme}
        />
      </section>
    </StepLayout>
  );
}
