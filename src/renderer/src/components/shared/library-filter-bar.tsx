import type { ReactNode } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Icon, IconButton, Input, Menu, Select, Tooltip, type MenuOption } from "@renderer/components/ui";

type LibraryFilterBarProps<S extends string> = {
  activeView?: string;
  /** Linking a folder (Media, Songs); a list without folders (the Functions
   *  tab's) has none. */
  addFolder?: { hint: string; label: string; onClick: () => void };
  /** What acts on the open folder, beside the dropdown; hidden on the whole library. */
  folderActions?: ReactNode;
  onQueryChange: (query: string) => void;
  /** Enter in the search box: the Songs tab previews the best match. */
  onSearchEnter?: () => void;
  onSelectView?: (view: string) => void;
  onSortChange: (order: S) => void;
  query: string;
  searchLabel: string;
  sort: S;
  sortHint: string;
  sortOptions: readonly MenuOption<S>[];
  /** Where the list comes from: the whole library first, then each folder. The
   *  dropdown only exists once there is a folder. */
  views?: readonly { label: string; value: string }[];
  /** The dropdown's name: «Origen» in Media, «Carpeta» in Songs. */
  viewsLabel?: string;
};

/**
 * A library tab's one bar — Media's and Songs' (owner, 2026-11-05: «the same
 * as Media, for songs»): how the list is ordered, where it comes from — the
 * library or one of its folders, a dropdown that only exists once there is a
 * folder —, a search over it, and adding a folder. Sources had a bar of their
 * own until 2026-11-05: four stacked bars before the first tile, and with no
 * folder a lone «Biblioteca» always on (owner's call).
 *
 * The order and the open folder are durable (in Settings, per tab); the query
 * is not, because a filter left over from last week's service is a tab that
 * looks empty for no reason.
 */
export function LibraryFilterBar<S extends string>({
  activeView,
  addFolder,
  folderActions,
  onQueryChange,
  onSearchEnter,
  onSelectView,
  onSortChange,
  query,
  searchLabel,
  sort,
  sortHint,
  sortOptions,
  views = [],
  viewsLabel,
}: LibraryFilterBarProps<S>) {
  const t = useT();
  return (
    // 32 px controls, like the Bible tab's search row: the box does not change
    // size from one tab to the next (2026-11-05 review).
    <div className="flex shrink-0 items-center gap-1.5 border-b border-border p-1.5">
      <Tooltip align="start" content={sortHint} placement="bottom">
        <Menu icon="sort" label={t("resources.sort")} onSelect={onSortChange} options={sortOptions} size="sm" value={sort} />
      </Tooltip>

      {views.length > 1 ? (
        <>
          <Select
            aria-label={viewsLabel}
            className="w-44 shrink-0"
            onChange={(view) => onSelectView?.(view)}
            options={[...views]}
            value={activeView ?? ""}
          />
          {activeView !== views[0]?.value ? folderActions : null}
        </>
      ) : null}

      <div className="min-w-0 flex-1">
        <Input
          aria-label={searchLabel}
          icon="search"
          onChange={(e) => onQueryChange(e.target.value)}
          // Escape empties the box instead of reaching the app: a text field
          // already swallows every shortcut while it has focus
          // (`use-global-shortcuts`), so the operator's way out of a filter has
          // to be here.
          onKeyDown={(e) => {
            if (e.key === "Escape" && query !== "") onQueryChange("");
            if (e.key === "Enter") onSearchEnter?.();
          }}
          placeholder={searchLabel}
          value={query}
        />
      </div>

      {query !== "" ? (
        <Tooltip align="end" content={t("resources.clearSearch")} placement="bottom">
          <IconButton aria-label={t("resources.clearSearch")} onClick={() => onQueryChange("")} size="sm" variant="ghost">
            <Icon name="close" />
          </IconButton>
        </Tooltip>
      ) : null}

      {addFolder ? (
        <Tooltip content={addFolder.hint} floating>
          <IconButton aria-label={addFolder.label} onClick={addFolder.onClick} size="sm" variant="ghost">
            <Icon name="folderPlus" />
          </IconButton>
        </Tooltip>
      ) : null}
    </div>
  );
}
