import { useT, type MessageKey } from "@renderer/lib/i18n/i18n-provider";
import { Icon, IconButton, Input, Menu, Select, Tooltip, type MenuOption } from "@renderer/components/ui";
import type { MediaSourceView } from "@renderer/stores/library.store";
import { MEDIA_SORT_ORDERS, type MediaSortOrder } from "@shared/types/media";

/** Explicit, because a message key can never be built from a runtime value —
 *  see the note on `MessageKey` in `i18n-provider.tsx`. */
const SORT_LABEL_KEY: Record<MediaSortOrder, MessageKey> = {
  "name-asc": "resources.sortOrders.name-asc",
  "name-desc": "resources.sortOrders.name-desc",
  "date-desc": "resources.sortOrders.date-desc",
  "date-asc": "resources.sortOrders.date-asc",
  "size-desc": "resources.sortOrders.size-desc",
  "size-asc": "resources.sortOrders.size-asc",
};

type MediaFilterBarProps = {
  activeView: MediaSourceView;
  folders: readonly string[];
  onAddFolder: () => void;
  onQueryChange: (query: string) => void;
  onRemoveFolder: (folderPath: string) => void;
  onSelectView: (view: MediaSourceView) => void;
  onSortChange: (order: MediaSortOrder) => void;
  query: string;
  sort: MediaSortOrder;
};

/** A folder's own name: its tail is what tells two folders apart. */
const folderName = (folderPath: string) => folderPath.split(/[\\/]/).filter(Boolean).pop() ?? folderPath;

/**
 * The tab's one bar: how this view is ordered, where it comes from — the
 * library or a linked folder, a dropdown that only exists once a folder is
 * linked —, a name filter over it, and linking another folder. Sources had a
 * bar of their own until 2026-11-05: four stacked bars before the first tile,
 * and with no folder a lone «Biblioteca» always on (owner's call).
 *
 * Both act on what the tab is already showing — the library list or the one
 * linked folder that is open — and neither reaches main. The order is durable
 * (`settings["library.sort"]`, per kind); the query is not, because a filter
 * left over from last week's service is a tab that looks empty for no reason.
 */
export function MediaFilterBar({
  activeView,
  folders,
  onAddFolder,
  onQueryChange,
  onRemoveFolder,
  onSelectView,
  onSortChange,
  query,
  sort,
}: MediaFilterBarProps) {
  const t = useT();

  const options: MenuOption<MediaSortOrder>[] = MEDIA_SORT_ORDERS.map((order) => ({
    label: t(SORT_LABEL_KEY[order]),
    value: order,
  }));

  return (
    // 32 px controls, like the Songs and Bible tabs' search rows: the box no
    // longer changes size from one tab to the next (2026-11-05 review).
    <div className="flex shrink-0 items-center gap-1.5 border-b border-border p-1.5">
      <Tooltip align="start" content={t("resources.sortHint")} placement="bottom">
        <Menu icon="sort" label={t("resources.sort")} onSelect={onSortChange} options={options} size="sm" value={sort} />
      </Tooltip>

      {folders.length > 0 ? (
        <>
          <Select
            aria-label={t("resources.source")}
            className="w-44 shrink-0"
            onChange={(view) => onSelectView(view)}
            options={[
              { label: t("resources.recentTab"), value: "recent" },
              ...folders.map((folderPath) => ({ label: folderName(folderPath), value: folderPath })),
            ]}
            value={activeView}
          />
          {activeView !== "recent" ? (
            <Tooltip content={t("resources.removeFolderHint")} floating>
              {/* Its own icon: a bare ✕ after a dropdown read as «clear the choice». */}
              <IconButton
                aria-label={t("resources.removeFolder")}
                onClick={() => onRemoveFolder(activeView)}
                size="sm"
                variant="ghost"
              >
                <Icon name="folderMinus" />
              </IconButton>
            </Tooltip>
          ) : null}
        </>
      ) : null}

      <div className="min-w-0 flex-1">
        <Input
          aria-label={t("resources.search")}
          icon="search"
          onChange={(e) => onQueryChange(e.target.value)}
          // Escape empties the box instead of reaching the app: a text field
          // already swallows every shortcut while it has focus
          // (`use-global-shortcuts`), so the operator's way out of a filter has
          // to be here.
          onKeyDown={(e) => {
            if (e.key === "Escape" && query !== "") onQueryChange("");
          }}
          placeholder={t("resources.search")}
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

      <Tooltip content={t("resources.addFolderHint")} floating>
        <IconButton aria-label={t("resources.addFolder")} onClick={onAddFolder} size="sm" variant="ghost">
          <Icon name="folderPlus" />
        </IconButton>
      </Tooltip>
    </div>
  );
}
