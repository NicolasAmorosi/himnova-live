import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Badge } from "@renderer/components/ui";
import { PanelBody, PanelHeader } from "@renderer/components/shared/panel";
import { DamagedSlideBadge } from "@renderer/components/shared/damaged-slide";
import { selectOutputMemo, useProjectionStore } from "@renderer/stores/projection.store";
import { useLiveHeading } from "@renderer/lib/hooks/use-live";
import { cn } from "@renderer/lib/utils";
import { LiveMonitor } from "./live-monitor";
import { LiveContentGrid } from "./live-content-grid";
import { LiveMediaPanel } from "./live-media-panel";
import { DeckTransport } from "./deck-transport";
import { VerseTransport } from "./verse-transport";

/**
 * EasyWorship's right-hand column: a header matching the other two columns'
 * (same height, "LIVE" plus a blinking dot exactly while something is
 * actually going out to the projector), the LIVE monitor, and below it the
 * live equivalent of the centre column's grid — a deck's slides or a
 * passage's verses, whichever is on air. The preview monitor used to live
 * here too; it is pinned in the centre column now, next to what it previews.
 *
 * The monitor itself is a bare stage (`components/ui/monitor.tsx`), so all
 * of its former status text (BLACK/LOGO/disconnected) lives here in the
 * header instead — see `useLiveStatus`. The slide counter used to live here
 * too; it's redundant with `DeckTransport`'s own counter and the highlighted
 * tile in `LiveContentGrid`, so it was dropped rather than shown three times.
 */
function useLiveStatus(): string {
  const t = useT();
  const presentationOpen = useProjectionStore((s) => s.presentationOpen);
  // Read off the SAME value the monitor renders, never a second reading of
  // `overlay`/`base`: this badge used to re-derive the precedence by hand and
  // got it wrong for the one case the two disagree on. With nothing selected
  // and no overlay, `selectOutputWithoutUnderlay` falls back to the logo — so
  // the stage showed the logo while the badge beside it said "No signal".
  // A badge that contradicts the stage it labels is the monitor lying to the
  // operator, which is the one thing this column may never do.
  // `.kind` and not the whole output: a string is comparable by `Object.is`,
  // so this subscription only wakes the column when the badge would actually
  // change — not on every slide advance. `selectOutputMemo` makes the call
  // inside the selector free.
  const outputKind = useProjectionStore((s) => selectOutputMemo(s).kind);

  if (!presentationOpen) return t("live.disconnected");
  if (outputKind === "black") return t("status.black");
  if (outputKind === "logo") return t("status.logo");
  return "";
}

export function MonitorsColumn() {
  const t = useT();
  const presentationOpen = useProjectionStore((s) => s.presentationOpen);
  const overlay = useProjectionStore((s) => s.overlay);
  const base = useProjectionStore((s) => s.base);
  const heading = useLiveHeading();
  const status = useLiveStatus();
  // The slide the LIVE monitor draws — none under BLACK/LOGO, like the stage.
  const liveModelUrl = useProjectionStore((s) => {
    const output = selectOutputMemo(s);
    return output.kind === "slide" ? output.modelUrl : null;
  });

  const broadcasting = presentationOpen && overlay === "none" && base !== null;

  return (
    <>
      <PanelHeader
        actions={
          <>
            {heading ? (
              <Badge className="min-w-0 flex-1" variant="blue">
                <span className="truncate">{heading}</span>
              </Badge>
            ) : null}
            <DamagedSlideBadge url={liveModelUrl} />
            {status ? (
              <Badge variant="neutral">
                {status}
              </Badge>
            ) : null}
          </>
        }
        title={
          <span className="flex items-center gap-1.5">
            {broadcasting ? (
              <span className="size-2 shrink-0 rounded-full bg-on-air motion-safe:animate-pulse" />
            ) : null}
            {t("live.title")}
          </span>
        }
      />
      {/* The same column as PREVIEW's (`SlidesPanel`), on purpose: whatever
          row sits right under each monitor has to land on the same pixel as
          its twin across, for every kind of content. Each row below is a
          sibling of the monitor, never its footer, so none can shrink the
          stage itself — see `Monitor` — and each renders `null` when it has
          nothing to show (deck and verse are mutually exclusive, since
          `base` can't be both kinds at once). The media panel was inside the
          scrolling body for a while, which put it 6px lower and 18px narrower
          than the PREVIEW row; it caps its own height instead, so any number
          of tracks only ever takes part of the live grid's room. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <LiveMonitor />
        <DeckTransport />
        <VerseTransport />
        <LiveMediaPanel />
        <PanelBody className="p-1.5">
          <div className={cn("flex flex-1 flex-col", base === null && "items-center justify-center")}>
            <LiveContentGrid />
          </div>
        </PanelBody>
      </div>
    </>
  );
}
