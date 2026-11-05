import { useMemo } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { OutputView } from "@renderer/components/shared/output-view";
import { bibleOutputFor } from "@renderer/lib/bible-output";
import { bibleVersionLabel, useBibleStore } from "@renderer/stores/bible.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { INSTANT_TRANSITION } from "@shared/types/projection";
import type { BibleStyle } from "@shared/types/bible-style";

/**
 * The verse as the projector would draw it, while its style is being edited.
 *
 * The SAME `OutputView` the projection window and both confidence monitors
 * use, fed by the SAME `bibleOutputFor` — the rule from `CLAUDE.md` and the
 * reason `ScenePreview` is built the same way: a preview drawn by a second,
 * simpler renderer is a preview that can disagree with the projector, and the
 * operator would only find out in front of the congregation. It is also what
 * makes the auto-fit honest, since the measurement runs here against a stage
 * of the very same proportions.
 *
 * `long` swaps a two-word verse for a long one. Not a decoration: it is the
 * only way to see what «Shrink to fit» actually does before Sunday, in
 * the same spirit as the time-scene editor's «Preview the end».
 *
 * The version label is the DEFAULT version's real name rather than a
 * placeholder, so «Show the version» previews the string that will really be
 * on screen — including how long it is, which is the thing worth finding out
 * here rather than mid-service.
 *
 * `INSTANT_TRANSITION` keeps `epoch` fixed, so `OutputView`'s `sameEpoch`
 * short-circuit means dragging a slider re-renders the verse without ever
 * running a scene transition.
 *
 * Only the picture: the editor's `EditorStage` frames it.
 */
export function VersePreview({ long, style }: { long: boolean; style: BibleStyle }) {
  const t = useT();
  const versions = useBibleStore((s) => s.versions);
  const defaultVersionId = useSettingsStore((s) => s.settings["bible.defaultVersionId"]);

  const output = useMemo(() => {
    const label = bibleVersionLabel(versions, defaultVersionId) ?? versions[0]?.name ?? null;
    return {
      ...bibleOutputFor(
        {
          text: long ? t("settings.verse.sampleLong") : t("settings.verse.sampleShort"),
          reference: long ? t("settings.verse.sampleLongRef") : t("settings.verse.sampleShortRef"),
          versionLabel: label,
        },
        style,
      ),
      videoUnderlay: null,
      slideVideo: null,
      plates: [],
      transition: INSTANT_TRANSITION,
    };
  }, [defaultVersionId, long, style, t, versions]);

  return <OutputView mode="preview" output={output} />;
}
