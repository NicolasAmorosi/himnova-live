import { useT } from "@renderer/lib/i18n/i18n-provider";
import { ChoiceGroup, Icon, ThemeSwatch, Title, type IconName } from "@renderer/components/ui";
import { api } from "@renderer/lib/api";
import { toast } from "@renderer/lib/toast";
import { useBibleStore } from "@renderer/stores/bible.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { LOCALES, THEMES, type Locale, type Theme } from "@shared/types/settings";
import { StepLayout } from "./StepLayout";

const POINTS = [
  { icon: "check", key: "offline" },
  { icon: "save", key: "autosave" },
  { icon: "settings", key: "reopen" },
] as const satisfies readonly { icon: IconName; key: string }[];

let bibleSwap: Promise<void> = Promise.resolve();

/**
 * On a first launch, choosing another language swaps the Bibles main gave the new profile — the OS language's,
 * before anybody chose — for the new language's, which become the default (owner, 2026-11-09). Chained, so
 * quick clicks through the languages settle in order. Only the previous language's bundled versions go, and
 * never one a saved program cites: one installed by hand in a third language stays.
 */
function swapBundledBibles(from: string, to: string, failed: string): void {
  bibleSwap = bibleSwap
    .then(async () => {
      const bundled = await api.bible.bundled();
      let first: number | null = null;
      for (const bible of bundled.filter((b) => b.language === to)) {
        const id = bible.versionId ?? (await api.bible.installBundled(bible.code)).id;
        first ??= id;
      }
      if (first !== null) await useSettingsStore.getState().update({ "bible.defaultVersionId": first });
      for (const { versionId } of bundled.filter((b) => b.language === from)) {
        if (versionId === null || (await api.bible.usages(versionId)).length > 0) continue;
        await api.bible.delete(versionId);
        useProgramStore.getState().forgetBibleVersion(versionId);
      }
      await useBibleStore.getState().loadVersions();
    })
    .catch((error: unknown) => {
      console.error("[welcome] bible swap failed", error);
      toast.danger(failed);
    });
}

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
                <Icon className="mt-0.5" name={icon} />
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
          onChange={(value) => {
            if (useSettingsStore.getState().settings["welcome.pending"] && value !== locale) {
              swapBundledBibles(locale, value, t("settings.bible.installFailed"));
            }
            void update({ "ui.locale": value });
          }}
          // Each language in its own name, as Settings lists them: whoever cannot read the current one
          // still finds theirs.
          options={LOCALES.map((value) => ({ label: t(`settings.locales.${value}`), value }))}
          value={locale}
        />
      </section>
      <section className="flex flex-col gap-2">
        <Title as="h3">{t("welcome.hello.theme")}</Title>
        <ChoiceGroup<Theme>
          columns={2}
          label={t("welcome.hello.theme")}
          onChange={(value) => void update({ "ui.theme": value })}
          options={THEMES.map((value) => ({
            description: t(`welcome.hello.themeDescs.${value}`),
            label: t(`welcome.hello.themes.${value}`),
            value,
            // The work screen in that theme, not a moon or a sun.
            visual: <ThemeSwatch theme={value} />,
          }))}
          value={theme}
        />
      </section>
    </StepLayout>
  );
}
