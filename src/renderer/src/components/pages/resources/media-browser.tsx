import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  LoadingState,
  Tooltip,
  VirtualGrid,
  thumbTileHeight,
} from "@renderer/components/ui";
import { PanelBody, PanelFooter } from "@renderer/components/shared/panel";
import { ConfirmModal } from "@renderer/components/shared/modal";
import { folderAssetsKey, useLibraryStore } from "@renderer/stores/library.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useDeckStore } from "@renderer/stores/deck.store";
import { api } from "@renderer/lib/api";
import { readOsFilesDrag, setMediaAssetDrag } from "@renderer/lib/dnd";
import { previewAsset } from "@renderer/lib/actions/preview";
import { goLive } from "@renderer/lib/actions/playback";
import { removeAsset } from "@renderer/lib/actions/remove-asset";
import {
  addLinkedFolder,
  removeLinkedFolder,
  selectMediaSourceView,
  setMediaSortOrder,
} from "@renderer/lib/actions/library-folders";
import { useDebouncedCallback } from "@renderer/lib/hooks/use-debounced-callback";
import { filterAssetsByName, sortAssets } from "@renderer/lib/media-view";
import { AssetTile } from "./asset-tile";
import { MediaFilterBar } from "./media-filter-bar";
import { MediaSourceBar } from "./media-source-bar";
import { PanelProgressRow } from "./panel-progress-row";
import { PrewarmConfirmModal } from "./prewarm-confirm-modal";
import { PREWARM_VISIBLE_MAX, type AssetKind } from "@shared/constants";
import type { DeckStatusSummary } from "@shared/types/deck";
import type { MediaAsset } from "@shared/types/media";

/** Rough estimate for the "this can take about N minutes" warning — no
 *  history of past conversion times is tracked yet, so a flat, slightly
 *  conservative per-deck figure stands in for one. */
const PREWARM_FALLBACK_SECONDS_PER_DECK = 8;

/** Grid geometry, in px, handed to `VirtualGrid` — it has to compute the
 *  column count itself, so these can't stay as Tailwind classes. They are the
 *  exact equivalent of the `repeat(auto-fill, minmax(7rem, 1fr))` + `gap-1.5`
 *  this grid used before it was virtualized. */
const TILE_MIN_WIDTH_PX = 112;
const TILE_GAP_PX = 6;

/** How long to wait before re-reading `deck:statuses` after decks finish
 *  converting. A background batch reports one deck at a time; refetching per
 *  deck would be hundreds of queries for a progress number nobody reads that
 *  precisely. */
const STATUS_REFETCH_DEBOUNCE_MS = 500;

/** Stable fallback for "this folder view hasn't loaded yet" — a fresh `[]`
 *  literal on every render would make effects keyed off `assets` (the visible
 *  prewarm below) re-fire on every render instead of only when the list
 *  actually changes. */
const EMPTY_ASSETS: MediaAsset[] = [];

/**
 * The library for one kind of asset, as a thumbnail grid. Click previews,
 * double-click goes live, drag adds to the schedule — an asset never has to be
 * in the schedule to be shown, which is what EasyWorship's resource area does.
 *
 * Two sources feed the grid: the added-to-library list ("recent"), or one of
 * this kind's linked folders, browsed live from disk (`MediaSourceBar`).
 */
export function MediaBrowser({ active, kind }: { active: boolean; kind: AssetKind }) {
  const t = useT();
  const recentAssets = useLibraryStore((s) => s.byKind[kind]);
  const selectedId = useLibraryStore((s) => s.selectedId);
  const refresh = useLibraryStore((s) => s.refresh);
  const addFiles = useLibraryStore((s) => s.addFiles);
  const pendingRemovalIds = useLibraryStore((s) => s.pendingRemovalIds);
  const addItem = useProgramStore((s) => s.addItem);
  const activeView = useLibraryStore((s) => s.activeView[kind]);
  const refreshFolder = useLibraryStore((s) => s.refreshFolder);
  const folders = useSettingsStore((s) => s.settings["library.linkedFolders"][kind]);
  const folderAssets = useLibraryStore((s) => s.folderAssets[folderAssetsKey(kind, activeView)]);
  const sortOrder = useSettingsStore((s) => s.settings["library.sort"][kind]);
  /** Session-only, and one per tab because each `MediaBrowser` stays mounted
   *  once visited (see `ResourcePanel`). Deliberately not persisted, unlike
   *  the order: a filter restored at launch is a tab that looks empty for no
   *  reason anyone can see. */
  const [query, setQuery] = useState("");

  const isFolderView = activeView !== "recent";
  const visibleAssets = isFolderView ? (folderAssets ?? EMPTY_ASSETS) : recentAssets;
  // An asset the operator has just removed is gone from the grid immediately,
  // even though its delete has not been sent yet — the undo window in
  // `lib/actions/remove-asset.ts`. Filtering here rather than in the store
  // keeps `byKind`/`folderAssets` a faithful copy of what main holds, which is
  // what every refresh rewrites.
  const viewAssets = useMemo(
    () =>
      pendingRemovalIds.length === 0
        ? visibleAssets
        : visibleAssets.filter((asset) => !pendingRemovalIds.includes(asset.id)),
    [pendingRemovalIds, visibleAssets],
  );
  /** What is actually on screen: the whole view, filtered by the search box
   *  and in the order this tab was left in.
   *
   *  Kept apart from `viewAssets` because the deck statuses below are fetched
   *  for the WHOLE view. Keyed off this list instead, every keystroke in the
   *  search box would be another `deck:statuses` round-trip over a folder of a
   *  thousand presentations — for a map the tiles look up by id anyway, and
   *  which filtering cannot change a single entry of. */
  const assets = useMemo(
    () => sortAssets(filterAssetsByName(viewAssets, query), sortOrder),
    [query, sortOrder, viewAssets],
  );
  // A new order, filter or view starts from its first file. The grid used to
  // keep its scroll offset, so an operator scrolled to the bottom of A → Z who
  // picked Z → A was shown "Himno 9 … Himno 1" — the tail of the new order,
  // which reads as an order that did nothing. Layout effect: the re-sorted
  // list is never painted at the old offset first.
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [activeView, query, sortOrder]);
  // "Empty" and "not read yet" are different answers and the grid used to
  // give the same one for both — a linked folder with 600 files showed "no
  // resources" for as long as the listing took, which on a share is seconds.
  const viewKey = isFolderView ? folderAssetsKey(kind, activeView) : kind;
  const status = useLibraryStore((s) => s.viewStatus[viewKey]);

  const imports = useLibraryStore((s) => s.imports);
  const prewarmBatch = useDeckStore((s) => s.prewarmBatch);
  const startBatchPrewarm = useDeckStore((s) => s.startBatchPrewarm);
  const cancelBatchPrewarm = useDeckStore((s) => s.cancelBatchPrewarm);
  /** `null` means "not asked yet" — distinct from "asked, and this asset has
   *  no deck". Without that distinction a tile can't tell a deck that still
   *  needs converting from one whose status simply hasn't come back, and it
   *  would have to pick one of the two to show wrongly. */
  const [deckStatuses, setDeckStatuses] = useState<Record<number, DeckStatusSummary> | null>(null);
  const [confirmPrewarmOpen, setConfirmPrewarmOpen] = useState(false);
  /** The folder awaiting an "are you sure" — `null` when none, so the path is
   *  both the target and the open flag (same shape as `RemoveAssetConfirm`). */
  const [confirmRemoveFolder, setConfirmRemoveFolder] = useState<string | null>(null);
  /** Index range currently mounted by the virtualized grid (`end` exclusive). */
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 0 });

  // Skipped in folder view: `recentAssets` isn't on screen there, and this
  // effect ran on every mount regardless — one `library:list` per tab opened,
  // for a list nobody was looking at. Switching back to "recent" flips
  // `isFolderView` and fetches it then, which is the moment it matters.
  useEffect(() => {
    if (!isFolderView) void refresh(kind);
  }, [isFolderView, kind, refresh]);

  useEffect(() => {
    if (isFolderView) void refreshFolder(kind, activeView);
  }, [kind, activeView, isFolderView, refreshFolder]);

  // Identity-stable so `VirtualGrid`'s notification effect doesn't re-fire on
  // every render of this component.
  const handleVisibleRangeChange = useCallback((range: { start: number; end: number }) => {
    setVisibleRange((current) =>
      current.start === range.start && current.end === range.end ? current : range,
    );
  }, []);

  // Reads decks in the background for what the operator can actually see
  // right now — the grid reports its mounted range by row and this debounces
  // the scroll, because a fast scroll through 600 tiles must not read 600
  // decks nobody will look at.
  const setVisiblePrewarm = useDebouncedCallback((assetIds: number[]) => {
    void api.deck.prewarm(assetIds);
  }, 300);

  // `PREWARM_VISIBLE_MAX` stays as a backstop even now that the range is real:
  // a very tall window at a very small tile size could still mount more than
  // is worth reading at once.
  const visibleIdsKey = useMemo(
    () =>
      assets
        .slice(visibleRange.start, visibleRange.end)
        .filter((a) => a.missingSince === null)
        .slice(0, PREWARM_VISIBLE_MAX)
        .map((a) => a.id)
        .join(","),
    [assets, visibleRange],
  );

  useEffect(() => {
    // A hidden tab stays mounted (see `ResourcePanel`) and its range is still
    // perfectly valid — it is just not what anyone is looking at.
    if (kind !== "ppt" || !active) return;
    const ids = visibleIdsKey === "" ? [] : visibleIdsKey.split(",").map(Number);
    setVisiblePrewarm(ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `setVisiblePrewarm` is stable per render by design (see useDebouncedCallback); `visibleIdsKey` is the real, identity-stable dependency
  }, [active, kind, visibleIdsKey]);

  // One round-trip for the whole view: which decks are ready (drives the
  // "Prepare folder/view" button and its count) and where each ready deck's
  // first slide lives (drives every PPT tile's thumbnail). This is what
  // replaced one `deck:get` per tile.
  /** Monotonic request id. `invoke` cannot be cancelled, so switching folders
   *  quickly leaves two of these in flight and the slower one would win —
   *  painting folder A's thumbnails and pending-count over folder B's grid.
   *  Only the newest request is allowed to publish. */
  const statusesSeqRef = useRef(0);
  const fetchDeckStatuses = useCallback((forAssets: readonly MediaAsset[]) => {
    const seq = (statusesSeqRef.current += 1);
    void api.deck
      .statuses(forAssets.map((a) => a.id))
      .then((statuses) => {
        if (seq === statusesSeqRef.current) setDeckStatuses(statuses);
      })
      .catch(() => {
        // A failed status read is not worth a toast: every tile falls back to
        // its icon, and the next finished deck retries. Left as `null` so the
        // tiles show "no deck yet" rather than an eternal skeleton.
        if (seq === statusesSeqRef.current) setDeckStatuses({});
      });
  }, []);
  const refetchDeckStatuses = useDebouncedCallback(fetchDeckStatuses, STATUS_REFETCH_DEBOUNCE_MS);
  /** Identifies the list these statuses were fetched for, so opening a view is
   *  told apart from decks finishing inside the view it already showed. */
  const fetchedForRef = useRef("");

  // Recomputed as decks finish, so tiles gain their thumbnail during a batch
  // instead of only once the whole thing wraps up. Debounced above, because a
  // background batch reports one deck at a time.
  //
  // A counter from the store, not a count derived from it: the previous
  // version ran `Object.values(byAssetId).filter(...)` on every notification
  // of the deck store, which during a folder batch is an O(n) scan repeated
  // once per finished deck over a map that grows with every one of them.
  const readyEpoch = useDeckStore((s) => s.readyEpoch);

  useEffect(() => {
    if (kind !== "ppt" || viewAssets.length === 0) {
      setDeckStatuses(null);
      fetchedForRef.current = "";
      return;
    }
    const listKey = `${kind}|${viewAssets.length}|${viewAssets[0]?.id}|${viewAssets.at(-1)?.id}`;
    if (listKey === fetchedForRef.current) {
      // Same list, something finished converting: the thumbnails that appear
      // are a bonus, not something anyone is waiting on, and during a batch
      // this fires once per deck.
      refetchDeckStatuses(viewAssets);
      return;
    }
    // A view the operator just opened: asking immediately is the difference
    // between thumbnails that are there and thumbnails that pop in half a
    // second later. Until the answer arrives the tiles show a skeleton.
    fetchedForRef.current = listKey;
    setDeckStatuses(null);
    fetchDeckStatuses(viewAssets);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `refetchDeckStatuses` is stable per render by design (see useDebouncedCallback)
  }, [kind, viewAssets, prewarmBatch?.status, readyEpoch, fetchDeckStatuses]);

  // Empty while the statuses are unknown: offering "Prepare folder" for a
  // count we haven't confirmed would show a button that may have nothing to do.
  //
  // This list is only ever as honest as what `deck:statuses` returns, and for
  // a long time it wasn't: that channel answered by deck-row OWNERSHIP while
  // the cache is addressed by content, so every file sharing its bytes with an
  // already-converted one was counted here — 555 of 1235 on a real library,
  // with zero work to do. `statusesByAsset` now asks by content (`N3` in the
  // media-chain audit §5.2). An asset can still legitimately appear here
  // before the startup backfill has stamped its hash; `deck-statuses-changed`
  // bumps `readyEpoch` as that lands, which re-runs the fetch above.
  //
  // The ids, not just the count — they are the same list, and they were not:
  // the modal promised "N presentations aren't converted yet" and the batch it
  // started was then handed EVERY asset in the view, missing files and
  // already-converted decks included. Main skips those, so the progress bar
  // counted to a total that never matched the number the operator had just
  // agreed to.
  //
  // Over `assets`, so a search narrows it too: the button says "this view"
  // and the modal quotes a count back, so with a filter up it has to prepare
  // the matches the operator can see rather than the thousand decks behind
  // them.
  const pendingDeckAssetIds = useMemo(
    () =>
      kind !== "ppt" || deckStatuses === null
        ? []
        : assets.filter((a) => a.missingSince === null && deckStatuses[a.id]?.status !== "ready").map((a) => a.id),
    [assets, deckStatuses, kind],
  );
  const pendingDeckCount = pendingDeckAssetIds.length;

  async function handleAdd() {
    const paths = await api.files.pick(kind, true);
    if (paths.length > 0) await addFiles(paths, kind);
  }

  async function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const byKind = new Map<AssetKind, string[]>();
    for (const file of readOsFilesDrag(e)) {
      byKind.set(file.kind, [...(byKind.get(file.kind) ?? []), file.path]);
    }
    for (const [dropped, paths] of byKind) await addFiles(paths, dropped);
  }

  return (
    <>
      <MediaSourceBar
        activeView={activeView}
        folders={folders}
        onAddFolder={() => void addLinkedFolder(kind)}
        // Asked first: the button is a 12px × next to the folder's name, it
        // sits inside the row that SELECTS that folder, and the result — the
        // view the operator had open disappearing — looks exactly like data
        // loss even though no file is touched.
        onRemoveFolder={(folderPath) => setConfirmRemoveFolder(folderPath)}
        onSelectView={(view) => selectMediaSourceView(kind, view)}
      />
      <MediaFilterBar
        onQueryChange={setQuery}
        onSortChange={(order) => setMediaSortOrder(kind, order)}
        query={query}
        sort={sortOrder}
      />
      <PanelBody
        className="p-1.5"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => void handleDrop(e)}
        ref={bodyRef}
      >
        {viewAssets.length === 0 && status?.error ? (
          <LoadingState
            action={
              <Button
                onClick={() =>
                  isFolderView ? void refreshFolder(kind, activeView) : void refresh(kind)
                }
                size="sm"
                variant="outline"
              >
                {t("common.retry")}
              </Button>
            }
            hint={status.error}
            icon="alert"
            surface="panel"
            title={t("library.loadFailed")}
            tone="failed"
          />
        ) : viewAssets.length === 0 && status?.loading ? (
          <LoadingState progress={null} surface="panel" title={t("library.loading")} />
        ) : viewAssets.length === 0 ? (
          <EmptyState description={t("resources.emptyHint")} icon={kind} title={t("resources.empty")} />
        ) : assets.length === 0 ? (
          // A view with files in it and nothing matching what was typed — the
          // way out has to be offered here, because the operator's eyes are on
          // the grid, not on the box two rows above it.
          <EmptyState
            action={
              <Button onClick={() => setQuery("")} size="sm" variant="outline">
                {t("resources.clearSearch")}
              </Button>
            }
            description={t("resources.searchNoResultsHint", { query })}
            icon="search"
            title={t("resources.searchNoResults")}
          />
        ) : (
          <VirtualGrid
            aria-label={t(`library.${kind}s`)}
            gap={TILE_GAP_PX}
            itemHeight={thumbTileHeight}
            itemKey={(asset) => asset.id}
            items={assets}
            minItemWidth={TILE_MIN_WIDTH_PX}
            onVisibleRangeChange={handleVisibleRangeChange}
            renderItem={(asset, _index, { tabIndex }) => (
              <AssetTile
                asset={asset}
                deckStatus={deckStatuses === null ? undefined : (deckStatuses[asset.id] ?? null)}
                kind={kind}
                onClick={() => previewAsset(asset.id, kind)}
                onDoubleClick={() => {
                  previewAsset(asset.id, kind);
                  void goLive();
                }}
                onDragStart={(e) => setMediaAssetDrag(e, { assetId: asset.id, kind })}
                selected={selectedId === asset.id}
                tabIndex={tabIndex}
              />
            )}
          />
        )}
      </PanelBody>
      <ConfirmModal
        confirmLabel={t("resources.removeFolder")}
        description={t("resources.removeFolderConfirmBody", { folder: confirmRemoveFolder ?? "" })}
        onConfirm={async () => {
          if (confirmRemoveFolder !== null) await removeLinkedFolder(kind, confirmRemoveFolder);
        }}
        onOpenChange={(open) => {
          if (!open) setConfirmRemoveFolder(null);
        }}
        open={confirmRemoveFolder !== null}
        title={t("resources.removeFolderConfirmTitle")}
      />
      <PrewarmConfirmModal
        count={pendingDeckCount}
        estimatedMinutes={Math.max(1, Math.ceil((pendingDeckCount * PREWARM_FALLBACK_SECONDS_PER_DECK) / 60))}
        onConfirm={() => void startBatchPrewarm(pendingDeckAssetIds, t(`library.${kind}s`))}
        onOpenChange={setConfirmPrewarmOpen}
        open={confirmPrewarmOpen}
      />
      <PanelFooter>
        {imports && imports.kind === kind ? (
          <PanelProgressRow
            label={t("library.importing", { done: imports.done, total: imports.total })}
            value={imports.total > 0 ? imports.done / imports.total : null}
          />
        ) : null}
        {kind === "ppt" && prewarmBatch && prewarmBatch.status === "running" ? (
          <PanelProgressRow
            cancelLabel={t("prewarm.cancel")}
            label={t("prewarm.progress", { done: prewarmBatch.done, total: prewarmBatch.total })}
            onCancel={() => void cancelBatchPrewarm()}
            value={prewarmBatch.total > 0 ? prewarmBatch.done / prewarmBatch.total : null}
          />
        ) : null}
        {/* Adding files feeds the library list, which is the "recent" view — a
            linked folder mirrors what is on disk, so there is nothing an
            in-app picker could add to the view being browsed. */}
        {!isFolderView ? (
          <Tooltip align="start" content={t("library.addHint")} placement="top">
            <IconButton aria-label={t("library.add")} onClick={() => void handleAdd()} size="sm" variant="success">
              <Icon name="add" />
            </IconButton>
          </Tooltip>
        ) : null}
        {!isFolderView ? (
          <Tooltip align="start" content={t("library.removeHint")} placement="top">
            <IconButton
              aria-label={t("library.remove")}
              disabled={selectedId === null}
              onClick={() => selectedId !== null && void removeAsset(selectedId)}
              size="sm"
              variant="warning"
            >
              <Icon name="close" />
            </IconButton>
          </Tooltip>
        ) : null}
        {kind === "ppt" && pendingDeckCount > 0 && (!prewarmBatch || prewarmBatch.status !== "running") ? (
          <Tooltip align="start" content={t("prewarm.actionHint")} placement="top">
            <IconButton
              aria-label={t("prewarm.action")}
              onClick={() => setConfirmPrewarmOpen(true)}
              size="sm"
              variant="outline"
            >
              <Icon name="layers" />
            </IconButton>
          </Tooltip>
        ) : null}
        <Tooltip className="ml-auto" content={t("resources.addToScheduleHint")} placement="top">
          <IconButton
            aria-label={t("resources.addToSchedule")}
            disabled={selectedId === null}
            onClick={() =>
              selectedId !== null &&
              addItem(
                kind === "ppt"
                  ? { kind: "ppt", mediaAssetId: selectedId, title: null }
                  : { kind: "media", mediaAssetId: selectedId, title: null },
              )
            }
            size="sm"
            variant="primary"
          >
            <Icon name="addToSchedule" />
          </IconButton>
        </Tooltip>
      </PanelFooter>
    </>
  );
}
