import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Badge, Icon } from "@renderer/components/ui";

type ProgramUsage = { programId: number; programName: string; itemCount: number };

type ProgramUsagesProps = {
  intro: string;
  usages: readonly ProgramUsage[];
  warning: string;
};

/** The saved programs a delete is about to edit, named — an FK rejection says
 *  "in use", which is nothing the operator can act on. One component for every
 *  table a program row can point at (an asset, a time scene, a plate, a Bible
 *  version), because it is the same decision each time. */
export function ProgramUsages({ intro, usages, warning }: ProgramUsagesProps) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-foreground">{intro}</p>
      <ul className="flex flex-col gap-1 rounded-md border border-border bg-muted p-1.5">
        {usages.map((usage) => (
          <li className="flex items-center gap-2 rounded-md px-2 py-1.5 text-foreground" key={usage.programId}>
            <Icon className="text-subtle" name="fileText" />
            <span className="min-w-0 flex-1 truncate">{usage.programName}</span>
            <Badge>{t("common.itemCount", { count: usage.itemCount })}</Badge>
          </li>
        ))}
      </ul>
      <p>{warning}</p>
    </div>
  );
}
