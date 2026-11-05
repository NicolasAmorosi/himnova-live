import { useT } from "@renderer/lib/i18n/i18n-provider";
import { OutputView } from "@renderer/components/shared/output-view";
import { useLiveHeading, useLiveStatus } from "@renderer/lib/hooks/use-live";
import { useLiveVideoPoster } from "@renderer/lib/hooks/use-live-video-poster";
import { selectOutputMemo, useProjectionStore } from "@renderer/stores/projection.store";
import { cn } from "@renderer/lib/utils";

/**
 * What the congregation sees while a full-screen editor covers the work
 * screen (owner, 2026-11-04: only an indicator — with an editor open no key
 * acts on the projector). The dot, the word and the picture are the LIVE
 * column's own: `useLiveHeading`/`useLiveStatus` and `OutputView` fed the same
 * `selectOutput`, so the indicator can never say something the monitor does
 * not.
 *
 * The picture never decodes a video: `videoStill` shows the file's thumbnail
 * instead, the same path the LIVE monitor takes with «video motion» off — a
 * thumbnail is not worth a third copy of the decoder.
 */
export function LiveIndicator() {
  const t = useT();
  const heading = useLiveHeading();
  const status = useLiveStatus();
  const output = useProjectionStore(selectOutputMemo);
  const presentationOpen = useProjectionStore((s) => s.presentationOpen);
  const broadcasting = useProjectionStore((s) => s.presentationOpen && s.overlay === "none" && s.base !== null);
  const videoAssetId = useProjectionStore((s) => (s.base?.kind === "video" ? s.base.assetId : null));
  const videoUrl = useProjectionStore((s) => (s.base?.kind === "video" ? s.base.url : null));
  const posterUrl = useLiveVideoPoster(videoAssetId);
  const label = status || heading || "";

  return (
    <div aria-label={label ? `${t("live.title")}: ${label}` : t("live.title")} className="flex min-w-0 items-center gap-2" role="group">
      <span className="flex min-w-0 flex-col items-end leading-tight">
        <span className="flex items-center gap-1.5 text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              // The work screen's colours (2026-11-05): red on air, amber when
              // NEGRO or LOGO covers it, grey with nothing projected.
              broadcasting
                ? "bg-on-air motion-safe:animate-pulse"
                : presentationOpen && (output.kind === "black" || output.kind === "logo")
                  ? "bg-warning"
                  : "bg-border-light",
            )}
          />
          {t("live.title")}
        </span>
        <span className="max-w-48 truncate text-dense text-foreground">{label}</span>
      </span>
      {/* 32 px tall with air around it, not an 80 px block touching the bar's
          edges; and no picture at all without a projector — a black box read
          as a broken image (2026-11-04 review). */}
      {presentationOpen ? (
        <div className="w-14 shrink-0 overflow-hidden rounded-md border border-border bg-black">
          <div className="flex aspect-video w-full items-center justify-center">
            <OutputView mode="monitor" output={output} videoStill={{ posterUrl, videoUrl }} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
