import { ListRow } from "@renderer/components/ui";
import { ProgramItemThumb } from "@renderer/components/shared/program-item-thumb";
import { useItemLabel } from "@renderer/lib/hooks/use-program-item-display";
import type { ProgramItemDTO } from "@shared/types/program";

function PreviewItemRow({ index, item }: { index: number; item: ProgramItemDTO }) {
  const label = useItemLabel(item);
  return (
    // Lines from edge to edge, and no hover: read-only rows must not look clickable.
    <ListRow
      className="cursor-default rounded-none px-3 py-1.5 hover:bg-transparent"
      index={index + 1}
      leading={<ProgramItemThumb item={item} />}
    >
      {label}
    </ListRow>
  );
}

/** A program's items as the order of service draws them — number, picture,
 *  name (2026-11-04 review: it had coloured capsules of its own) — read-only:
 *  no drag, no selection, no click handlers. Inside the programs screen's box. */
export function ProgramItemList({ items }: { items: readonly ProgramItemDTO[] }) {
  return (
    <ul className="flex flex-col divide-y divide-border">
      {items.map((item, index) => (
        <PreviewItemRow index={index} item={item} key={item.id} />
      ))}
    </ul>
  );
}

