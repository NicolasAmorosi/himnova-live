import { Panel } from "@renderer/components/shared/panel";
import { SchedulePanel } from "@renderer/components/pages/schedule/SchedulePanel";
import { ResourcePanel } from "@renderer/components/pages/resources/ResourcePanel";
import { SlidesPanel } from "@renderer/components/pages/slides/SlidesPanel";
import { MonitorsColumn } from "@renderer/components/pages/monitors/MonitorsColumn";
import { StagePanel } from "@renderer/components/pages/stage/StagePanel";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { TopBar } from "./TopBar";

type AppShellProps = {
  onOpenPrograms: (opts?: { mode: "create" }) => void;
  onOpenSettings: () => void;
};

/**
 * The EasyWorship 2009 workspace, in one place:
 *
 *   ┌ top bar ─────────────────────────────────────┐
 *   │ schedule   │ PREVIEW monitor    │ GO LIVE    │
 *   │ ───────────│ ────────────────── │ ────────── │
 *   │ resources  │ slides/verses of   │ LIVE       │
 *   │            │ the previewed item │ ────────── │
 *   │            │                    │ slides/    │
 *   │            │                    │ verses on  │
 *   │            │                    │ air        │
 *   └────────────────────────────────────────────────┘
 *
 * Left to right is browse -> stage -> broadcast, which is why the go-live
 * control sits at the far end of that path and nowhere else. All three
 * columns are equal-width — none of the three jobs (browsing, staging,
 * broadcasting) is visually more important than the others. The centre and
 * right columns mirror each other on purpose: a fixed monitor on top, the
 * same kind of grid underneath — the only difference is whether it's staged
 * or already on the projector.
 */
export function AppShell({ onOpenPrograms, onOpenSettings }: AppShellProps) {
  // The stage panel only with a stage screen assigned: a church with two screens sees nothing new.
  const hasStage = useSettingsStore((s) => s.settings["stage.displayId"] !== null);
  return (
    <div className="flex h-screen flex-col bg-background">
      <TopBar onOpenPrograms={onOpenPrograms} onOpenSettings={onOpenSettings} />

      {/* The column rules are the 1px gaps showing `bg-border` through, not
          `divide-x`: a divider is a border INSIDE the column it sits on, and
          only two of the three get one, so the centre column was 1px
          narrower than the live one — its monitor half a pixel shorter, and
          every row under it visibly out of line with its twin across. */}
      <main className="grid min-h-0 flex-1 grid-cols-3 gap-px bg-border">
        {/* The minimums never bind at the window's own `minHeight` (700px, see
            `control-window.ts`) — at that size the split is the plain
            1fr / 1.1fr it has always been. They are the floor for the case
            Electron cannot honour that minimum, on a screen short enough that
            the resources panel would otherwise be squeezed to a few pixels and
            the virtualized grid would mount a single row of tiles. `overflow-
            hidden` is what keeps that floor from spilling into the panel
            below instead. */}
        <div className="flex min-h-0 flex-col overflow-hidden bg-surface">
          <div className="grid min-h-0 flex-1 grid-rows-[minmax(160px,1fr)_minmax(220px,1.1fr)] divide-y divide-border overflow-hidden">
            <Panel>
              <SchedulePanel />
            </Panel>
            <Panel>
              <ResourcePanel />
            </Panel>
          </div>
          {hasStage ? <StagePanel /> : null}
        </div>

        <Panel>
          <SlidesPanel />
        </Panel>

        <Panel>
          <MonitorsColumn />
        </Panel>
      </main>
    </div>
  );
}
