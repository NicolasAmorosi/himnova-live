import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api";
import { bibleOutputFor } from "@renderer/lib/bible-output";
import { useBibleStore } from "@renderer/stores/bible.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useLogoPreview } from "@renderer/components/shared/settings-groups/use-logo-preview";
import { INSTANT_TRANSITION, type ProjectionOutput } from "@shared/types/projection";

/**
 * Something real for a demo's monitors: John 3:16 and the verse after it, in the profile's main version and dressed
 * with its own verse style, as the room would see them. Without a Bible (or until it answers), the church's LOGO.
 */
export function useSampleVerses(): readonly [ProjectionOutput, ProjectionOutput] {
  const logo = useLogoPreview();
  const versions = useBibleStore((s) => s.versions);
  const defaultId = useSettingsStore((s) => s.settings["bible.defaultVersionId"]);
  const style = useSettingsStore((s) => s.settings["bible.style"]);
  const version = versions.find((v) => v.id === defaultId) ?? versions[0];
  const [verses, setVerses] = useState<readonly [ProjectionOutput, ProjectionOutput] | null>(null);

  useEffect(() => {
    if (!version) return;
    let current = true;
    const verse = (n: number) =>
      api.bible.passage(version.id, "jo", 3, n, n).then((found): ProjectionOutput => {
        // A version without that verse (an imported New Testament-less one) keeps the LOGO.
        if (!found) throw new Error(`no John 3:${n} in ${version.name}`);
        return {
          ...bibleOutputFor({ text: found.text, reference: found.reference, versionLabel: version.name, parallel: null }, style),
          videoUnderlay: null,
          slideVideo: null,
          plates: [],
          transition: INSTANT_TRANSITION,
        };
      });
    Promise.all([verse(16), verse(17)]).then(
      (found) => {
        if (current) setVerses(found);
      },
      (error: unknown) => console.warn("[welcome] no sample verse", error),
    );
    return () => {
      current = false;
    };
  }, [version, style]);

  return verses ?? [logo, logo];
}
