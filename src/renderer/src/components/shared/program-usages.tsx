import { useT, type MessageKey } from "@renderer/lib/i18n/i18n-provider";
import { Badge, Icon, type IconName } from "@renderer/components/ui";
import type { AssetLookUsage } from "@shared/types/media";

type ProgramUsage = { programId: number; programName: string; itemCount: number };

type ProgramUsagesProps = {
  intro: string;
  usages: readonly ProgramUsage[];
  warning: string;
};

type UsageRow = { badge?: string; icon: IconName; id: string; label: string };

/** What a delete is about to change, named: an intro, one row each, and what happens to them. */
function UsageList({ intro, rows, warning }: { intro: string; rows: readonly UsageRow[]; warning: string }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-foreground">{intro}</p>
      <ul className="flex flex-col gap-1 rounded-md border border-border bg-muted p-1.5">
        {rows.map((row) => (
          <li className="flex items-center gap-2 rounded-md px-2 py-1.5 text-foreground" key={row.id}>
            <Icon className="text-subtle" name={row.icon} />
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            {row.badge ? <Badge>{row.badge}</Badge> : null}
          </li>
        ))}
      </ul>
      <p>{warning}</p>
    </div>
  );
}

/** The saved programs a delete is about to edit, named — an FK rejection says
 *  "in use", which is nothing the operator can act on. One component for every
 *  table a program row can point at (an asset, a time scene, a plate, a Bible
 *  version), because it is the same decision each time. */
export function ProgramUsages({ intro, usages, warning }: ProgramUsagesProps) {
  const t = useT();
  return (
    <UsageList
      intro={intro}
      rows={usages.map((usage) => ({
        badge: t("common.itemCount", { count: usage.itemCount }),
        icon: "fileText",
        id: String(usage.programId),
        label: usage.programName,
      }))}
      warning={warning}
    />
  );
}

/** Explicit, because a message key can never be built from a runtime value. */
const LOOK: Record<AssetLookUsage["kind"], { icon: IconName; label: MessageKey }> = {
  logo: { icon: "display", label: "library.looks.logo" },
  verse: { icon: "bible", label: "library.looks.verse" },
  songTheme: { icon: "palette", label: "library.looks.songTheme" },
  scene: { icon: "timer", label: "library.looks.scene" },
  plate: { icon: "overlay", label: "library.looks.plate" },
};

/** The looks drawn over a file about to leave the library — no FK protects
 *  them, so this list is the only warning (owner, 2026-11-06). */
export function LookUsages({ looks }: { looks: readonly AssetLookUsage[] }) {
  const t = useT();
  return (
    <UsageList
      intro={t("library.removeLooksIntro")}
      rows={looks.map((look, index) => ({
        icon: LOOK[look.kind].icon,
        id: `${look.kind}-${index}`,
        label: t(LOOK[look.kind].label, { name: look.name ?? "" }),
      }))}
      warning={t("library.removeLooksWarning")}
    />
  );
}
